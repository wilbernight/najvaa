package com.najvaa.app.files

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import android.media.MediaRecorder
import android.os.Build
import com.najvaa.app.core.Bytes
import java.io.File
import kotlin.math.abs

/**
 * Records a voice note as AAC in an M4A container, with a coarse amplitude
 * wave for the bubble. With [anonymous] the microphone is captured as raw PCM
 * instead, re-synthesised by [RobotVoice] after recording and only then
 * encoded, so the real voice never reaches the encoder, the disk or the wire.
 */
class VoiceRecorder(private val context: Context) {
    private var recorder: MediaRecorder? = null
    private var file: File? = null
    private var startedAt = 0L
    private val levels = ArrayList<Int>()

    // PCM (anonymous) mode
    private var audio: AudioRecord? = null
    private var pcmThread: Thread? = null
    @Volatile private var pcmRunning = false
    @Volatile private var pcmLevel = 0f
    private val pcm = ArrayList<ShortArray>()
    private var anonymous = false

    val isRecording: Boolean get() = recorder != null || audio != null
    val seconds: Int get() = if (startedAt == 0L) 0 else ((System.currentTimeMillis() - startedAt) / 1000).toInt()

    fun start(anonymous: Boolean = false): Boolean {
        stopQuietly()
        this.anonymous = anonymous
        return if (anonymous) startPcm() else startAac()
    }

    private fun startAac(): Boolean {
        val out = File(FileCodec.openDir(context.cacheDir), "rec_${System.currentTimeMillis()}.m4a")
        val r = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(context) else @Suppress("DEPRECATION") MediaRecorder()
        return runCatching {
            r.setAudioSource(MediaRecorder.AudioSource.MIC)
            r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            r.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            r.setAudioEncodingBitRate(48_000)
            r.setAudioSamplingRate(44_100)
            r.setOutputFile(out.absolutePath)
            r.prepare()
            r.start()
            recorder = r
            file = out
            startedAt = System.currentTimeMillis()
            levels.clear()
            true
        }.getOrElse {
            runCatching { r.release() }
            out.delete()
            false
        }
    }

    @SuppressLint("MissingPermission") // the caller asks for RECORD_AUDIO first
    private fun startPcm(): Boolean {
        val min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        if (min <= 0) return false
        val rec = runCatching {
            AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(min, RATE / 5 * 2))
        }.getOrNull() ?: return false
        if (rec.state != AudioRecord.STATE_INITIALIZED) { rec.release(); return false }
        runCatching { rec.startRecording() }.onFailure { rec.release(); return false }
        synchronized(pcm) { pcm.clear() }
        levels.clear()
        audio = rec
        pcmRunning = true
        startedAt = System.currentTimeMillis()
        pcmThread = Thread {
            val buf = ShortArray(RATE / 20) // 50 ms
            while (pcmRunning) {
                val n = rec.read(buf, 0, buf.size)
                if (n <= 0) continue
                var peak = 0
                for (i in 0 until n) peak = maxOf(peak, abs(buf[i].toInt()))
                pcmLevel = (peak / 32767f).coerceIn(0f, 1f)
                synchronized(pcm) { if (pcm.size < MAX_PCM_BLOCKS) pcm += buf.copyOf(n) }
            }
        }.apply { name = "najvaa-voice"; start() }
        return true
    }

    /** Call a few times a second while recording; feeds the wave. Returns 0..1. */
    fun sample(): Float {
        val level = if (audio != null) pcmLevel else (runCatching { recorder?.maxAmplitude ?: 0 }.getOrDefault(0) / 32767f).coerceIn(0f, 1f)
        if (levels.size < 4000) levels += (level * 255).toInt()
        return level
    }

    data class Result(val bytes: ByteArray, val seconds: Int, val wave: String, val mime: String, val name: String)

    /** Stops and returns the encoded note. In anonymous mode this runs the voice filter: call it off the main thread. */
    fun stop(): Result? {
        val dur = seconds
        val wave = wave()
        if (audio != null) {
            val blocks = stopPcm()
            startedAt = 0
            if (dur < 1 || blocks.isEmpty()) { blocks.forEach { it.fill(0) }; return null }
            val bytes = runCatching { encodeAnonymous(blocks) }.getOrNull()
            blocks.forEach { it.fill(0) }
            return bytes?.let { Result(it, dur, wave, "audio/mp4", "voice.m4a") }
        }
        val r = recorder ?: return null
        val f = file
        recorder = null
        file = null
        startedAt = 0
        runCatching { r.stop() }
        runCatching { r.release() }
        if (f == null || !f.exists() || dur < 1) {
            f?.delete()
            return null
        }
        val bytes = f.readBytes()
        com.najvaa.app.vault.SecureFiles.shred(f)
        return Result(bytes, dur, wave, "audio/mp4", "voice.m4a")
    }

    private fun wave(): String {
        val bars = 48
        val out = ByteArray(bars)
        if (levels.isNotEmpty()) {
            for (i in 0 until bars) {
                val from = i * levels.size / bars
                val to = maxOf(from + 1, (i + 1) * levels.size / bars)
                val avg = levels.subList(from, minOf(to, levels.size)).average()
                out[i] = avg.toInt().coerceIn(0, 255).toByte()
            }
        }
        return Bytes.b64u(out)
    }

    private fun stopPcm(): List<ShortArray> {
        pcmRunning = false
        audio?.let { runCatching { it.stop() } }
        runCatching { pcmThread?.join(500) }
        audio?.release()
        audio = null
        pcmThread = null
        return synchronized(pcm) { pcm.toList().also { pcm.clear() } }
    }

    /** Robot voice over the whole note, then AAC-LC 48 kbps in MP4, all in memory. */
    private fun encodeAnonymous(blocks: List<ShortArray>): ByteArray {
        val total = blocks.sumOf { it.size }
        val fx = RobotVoice(RATE)
        val lat = fx.latencySamples
        val samples = FloatArray(total + lat)
        var p = 0
        for (b in blocks) for (s in b) samples[p++] = s / 32768f
        fx.process(samples)
        val out = ShortArray(total)
        for (i in 0 until total) out[i] = (samples[i + lat].coerceIn(-1f, 1f) * 32767f).toInt().toShort()
        samples.fill(0f)
        val tmp = File(FileCodec.openDir(context.cacheDir), "vfx_${System.currentTimeMillis()}.m4a")
        try {
            encodeAac(out, tmp)
            out.fill(0)
            return tmp.readBytes()
        } finally {
            com.najvaa.app.vault.SecureFiles.shred(tmp)
        }
    }

    private fun encodeAac(pcm16: ShortArray, dest: File) {
        val format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, RATE, 1).apply {
            setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
            setInteger(MediaFormat.KEY_BIT_RATE, 48_000)
            setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16384)
        }
        val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC)
        val muxer = MediaMuxer(dest.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
        try {
            codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            codec.start()
            val info = MediaCodec.BufferInfo()
            var track = -1
            var muxing = false
            var pos = 0
            var inputDone = false
            var outputDone = false
            while (!outputDone) {
                if (!inputDone) {
                    val ix = codec.dequeueInputBuffer(10_000)
                    if (ix >= 0) {
                        val buf = codec.getInputBuffer(ix)!!
                        buf.clear()
                        val n = minOf((buf.capacity() / 2), pcm16.size - pos, 4096)
                        val ptsUs = pos * 1_000_000L / RATE
                        if (n <= 0) {
                            codec.queueInputBuffer(ix, 0, 0, ptsUs, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                            inputDone = true
                        } else {
                            val bb = java.nio.ByteBuffer.allocate(n * 2).order(java.nio.ByteOrder.LITTLE_ENDIAN)
                            for (i in 0 until n) bb.putShort(pcm16[pos + i])
                            bb.flip()
                            buf.put(bb)
                            codec.queueInputBuffer(ix, 0, n * 2, ptsUs, 0)
                            pos += n
                        }
                    }
                }
                when (val ox = codec.dequeueOutputBuffer(info, 10_000)) {
                    MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                        track = muxer.addTrack(codec.outputFormat)
                        muxer.start()
                        muxing = true
                    }
                    MediaCodec.INFO_TRY_AGAIN_LATER -> Unit
                    else -> if (ox >= 0) {
                        val out = codec.getOutputBuffer(ox)!!
                        if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) info.size = 0
                        if (info.size > 0 && muxing) {
                            out.position(info.offset)
                            out.limit(info.offset + info.size)
                            muxer.writeSampleData(track, out, info)
                        }
                        codec.releaseOutputBuffer(ox, false)
                        if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) outputDone = true
                    }
                }
            }
        } finally {
            runCatching { codec.stop() }
            codec.release()
            runCatching { muxer.stop() }
            runCatching { muxer.release() }
        }
    }

    fun cancel() = stopQuietly()

    private fun stopQuietly() {
        recorder?.let { r ->
            runCatching { r.stop() }
            runCatching { r.release() }
        }
        recorder = null
        file?.let { com.najvaa.app.vault.SecureFiles.shred(it) }
        file = null
        if (audio != null) stopPcm().forEach { it.fill(0) }
        startedAt = 0
    }

    private companion object {
        const val RATE = 16_000
        const val MAX_PCM_BLOCKS = 20 * 60 * 10 // 10 minutes of 50 ms blocks
    }
}
