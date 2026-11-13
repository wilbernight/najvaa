package com.najvaa.app.files

import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.net.Uri
import android.provider.OpenableColumns
import androidx.exifinterface.media.ExifInterface
import com.najvaa.app.core.Bytes
import com.najvaa.app.crypto.Primitives
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer

/**
 * File chunk encryption, identical to the web client: 128 KB chunks, a fresh
 * AES-256 key per file, iv = chunk index, AAD = "wn1/file" || id || i || total.
 * The last chunk is padded to 16 KB (voice: a whole chunk) with random bytes.
 */
object FileCodec {
    const val CHUNK = 128 * 1024
    const val MAX_FILE = 100L * 1024 * 1024
    const val VOICE_MAX_BYTES = 20L * 1024 * 1024

    fun chunkIv(i: Int): ByteArray = ByteArray(12).also { ByteBuffer.wrap(it).putInt(8, i) }

    fun chunkAad(idBytes: ByteArray, i: Int, total: Int): ByteArray =
        Bytes.concat(Bytes.utf8("wn1/file"), idBytes, Bytes.u32(i), Bytes.u32(total))

    fun totalChunks(size: Long): Int = maxOf(1, ((size + CHUNK - 1) / CHUNK).toInt())

    fun encryptChunk(key: ByteArray, idBytes: ByteArray, i: Int, total: Int, plain: ByteArray, voice: Boolean): ByteArray {
        var chunk = plain
        if (i == total - 1) {
            val unit = if (voice) CHUNK else 16384
            val padded = ByteArray(maxOf(unit, ((chunk.size + unit - 1) / unit) * unit))
            System.arraycopy(chunk, 0, padded, 0, chunk.size)
            val tail = Bytes.random(padded.size - chunk.size)
            System.arraycopy(tail, 0, padded, chunk.size, tail.size)
            chunk = padded
        }
        return Primitives.aesGcmEncrypt(key, chunkIv(i), chunk, chunkAad(idBytes, i, total))
    }

    fun decryptChunk(key: ByteArray, idBytes: ByteArray, i: Int, total: Int, size: Long, ct: ByteArray): ByteArray? {
        val pt = Primitives.aesGcmDecrypt(key, chunkIv(i), ct, chunkAad(idBytes, i, total)) ?: return null
        val keep = if (i < total - 1) CHUNK.toLong() else size - (total - 1).toLong() * CHUNK
        return if (keep < pt.size) pt.copyOf(keep.toInt()) else pt
    }

    data class Picked(val name: String, val mime: String, val bytes: ByteArray)

    fun kindOf(mime: String): String = when {
        Regex("^image/(jpeg|png|gif|webp|avif|heic|heif)$").matches(mime) -> "image"
        Regex("^video/(mp4|webm|quicktime|ogg|3gpp)$").matches(mime) -> "video"
        AUDIO.matches(mime) -> "audio"
        else -> "file"
    }

    val AUDIO = Regex("^audio/(mpeg|mp3|mp4|aac|ogg|wav|x-wav|wave|webm|flac|x-flac|x-m4a|m4a|opus)$")

    /** Reads a picked document; photos are re-encoded so EXIF (location, device) never leaves the phone. */
    fun read(resolver: ContentResolver, uri: Uri): Picked? {
        var name = "file"
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) name = c.getString(0) ?: name
        }
        val mime = resolver.getType(uri) ?: guessMime(name)
        val raw = resolver.openInputStream(uri)?.use { it.readBytes() } ?: return null
        if (raw.size > MAX_FILE) return null
        if (mime.startsWith("image/") && mime != "image/gif") {
            stripImage(raw)?.let { return Picked(name.substringBeforeLast('.') + ".jpg", "image/jpeg", it) }
        }
        return Picked(name, mime, raw)
    }

    private fun stripImage(raw: ByteArray): ByteArray? = runCatching {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(raw, 0, raw.size, bounds)
        var sample = 1
        while (bounds.outWidth / sample > 2560 || bounds.outHeight / sample > 2560) sample *= 2
        val bmp = BitmapFactory.decodeByteArray(raw, 0, raw.size, BitmapFactory.Options().apply { inSampleSize = sample }) ?: return null
        val orientation = ExifInterface(raw.inputStream()).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
        val rotated = rotate(bmp, orientation)
        val out = ByteArrayOutputStream()
        rotated.compress(Bitmap.CompressFormat.JPEG, 88, out)
        out.toByteArray()
    }.getOrNull()

    private fun rotate(bmp: Bitmap, orientation: Int): Bitmap {
        val m = Matrix()
        when (orientation) {
            ExifInterface.ORIENTATION_ROTATE_90 -> m.postRotate(90f)
            ExifInterface.ORIENTATION_ROTATE_180 -> m.postRotate(180f)
            ExifInterface.ORIENTATION_ROTATE_270 -> m.postRotate(270f)
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> m.preScale(-1f, 1f)
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> m.preScale(1f, -1f)
            else -> return bmp
        }
        return Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, m, true)
    }

    fun guessMime(name: String): String = when (name.substringAfterLast('.', "").lowercase()) {
        "jpg", "jpeg" -> "image/jpeg"
        "png" -> "image/png"
        "gif" -> "image/gif"
        "webp" -> "image/webp"
        "mp4" -> "video/mp4"
        "mov" -> "video/quicktime"
        "mp3" -> "audio/mpeg"
        "m4a" -> "audio/mp4"
        "aac" -> "audio/aac"
        "ogg", "opus" -> "audio/ogg"
        "wav" -> "audio/wav"
        "flac" -> "audio/flac"
        "pdf" -> "application/pdf"
        "zip" -> "application/zip"
        "txt" -> "text/plain"
        else -> "application/octet-stream"
    }

    fun extensionFor(mime: String?, name: String?): String {
        name?.substringAfterLast('.', "")?.takeIf { it.isNotEmpty() && it.length <= 5 }?.let { return it }
        return when (mime) {
            "image/jpeg" -> "jpg"
            "image/png" -> "png"
            "image/gif" -> "gif"
            "image/webp" -> "webp"
            "video/mp4" -> "mp4"
            "audio/mpeg" -> "mp3"
            "audio/mp4", "audio/m4a", "audio/x-m4a" -> "m4a"
            "audio/aac" -> "aac"
            "audio/ogg" -> "ogg"
            "audio/wav" -> "wav"
            else -> "bin"
        }
    }

    fun openDir(cacheDir: File): File = File(cacheDir, "open").apply { mkdirs() }
}
