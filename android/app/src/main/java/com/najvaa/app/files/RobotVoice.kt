package com.najvaa.app.files

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * "Anonymous voice": a port of the web client's robot engine
 * (chat/public/voicefx-worklet.js, RobotFx) with the same parameters the web
 * uses for voice messages (f0 155 Hz, formant 1.18, ring 0.15, smooth 40).
 *
 * Every 10 ms the vocal-tract shape is measured with linear prediction (that
 * keeps the words intelligible); the sound is then re-made from a synthetic
 * source: a steady buzz at one neutral pitch for voiced sounds, noise for
 * s / sh / f. The speaker's own pitch, intonation and timbre - the cues that
 * carry gender and identity - are never passed on.
 */
class RobotVoice(sampleRate: Int) {
    private companion object {
        const val R = 16000.0
        const val N = 400
        const val H = 160
        const val P = 16
        const val BLK = 32
        const val K = 128
    }

    private val sr = if (sampleRate in 8000..384000) sampleRate.toDouble() else 48000.0
    private var f0 = 155.0
    private val step = R / sr
    private val dnC = DoubleArray(10); private val dnS = DoubleArray(8)
    private val upC = DoubleArray(10); private val upS = DoubleArray(8)
    private var dnPos = 0.0; private var dnPrev = 0.0
    private val ring = DoubleArray(1024); private var wr = 0; private var got = 0; private var sinceHop = 0
    private val win = DoubleArray(N) { 0.5 - 0.5 * cos(2 * PI * (it + 0.5) / N) }
    private val lagW = DoubleArray(P + 1) { exp(-0.5 * (2 * PI * 60 * it / R).pow(2)) }
    private val frame = DoubleArray(N)
    private val ac = DoubleArray(P + 1)
    private val tmp = DoubleArray(P + 1)
    private val kPrev = DoubleArray(P); private val kCur = DoubleArray(P); private val kNow = DoubleArray(P)
    private val a = DoubleArray(P + 1)
    private val aT = DoubleArray(P + 1)
    private var gPrev = 0.0; private var gCur = 0.0
    private var uPrev = 1.0; private var uCur = 1.0
    private val out16 = DoubleArray(1024); private var oRd = 0; private var oWr = 0; private var oCount = 0
    private val hist = DoubleArray(P)
    private var phase = 0.0; private var seed = 1234567L
    private var deY = 0.0
    private var upPos = 0.0; private var upA = 0.0; private var upB = 0.0
    private var inP = 1e-7; private var outP = 1e-7; private var g = 1.0
    private val lvA = 1 - exp(-1 / (0.2 * sr)); private val gA = 1 - exp(-1 / (0.08 * sr))
    private val cosT = DoubleArray(K * (P + 1)); private val sinT = DoubleArray(K * (P + 1))
    private val S = DoubleArray(K); private val Sw = DoubleArray(K); private val rw = DoubleArray(P + 1)
    private val lagW2 = DoubleArray(P + 1) { exp(-0.5 * (2 * PI * 40 * it / R).pow(2)) }
    private var alpha = 1.18
    private val formant = 1.18
    private val ringF = 42.0; private val ringD = 0.15; private var ringPh = 0.0

    init {
        lowpass4(dnC, min(7200.0, sr * 0.45), sr)
        lowpass4(upC, min(7200.0, sr * 0.45), sr)
        for (k in 0 until K) for (m in 0..P) {
            val w = PI * k / K * m
            cosT[k * (P + 1) + m] = cos(w); sinT[k * (P + 1) + m] = sin(w)
        }
        repeat(H) { push16(0.0) }
    }

    private fun lowpass4(c: DoubleArray, fc: Double, sr: Double) {
        val qs = doubleArrayOf(0.5411961, 1.3065630)
        for (s in 0 until 2) {
            val w = 2 * PI * fc / sr; val cw = cos(w); val al = sin(w) / (2 * qs[s]); val a0 = 1 + al; val o = s * 5
            c[o] = (1 - cw) / 2 / a0; c[o + 1] = (1 - cw) / a0; c[o + 2] = (1 - cw) / 2 / a0
            c[o + 3] = -2 * cw / a0; c[o + 4] = (1 - al) / a0
        }
    }

    private fun biquads(c: DoubleArray, st: DoubleArray, xIn: Double): Double {
        var x = xIn
        for (s in 0 until 2) {
            val o = s * 5; val q = s * 4
            val y = c[o] * x + c[o + 1] * st[q] + c[o + 2] * st[q + 1] - c[o + 3] * st[q + 2] - c[o + 4] * st[q + 3]
            st[q + 1] = st[q]; st[q] = x; st[q + 3] = st[q + 2]; st[q + 2] = y
            x = y
        }
        return x
    }

    private fun ok(v: Double) = !v.isNaN() && !v.isInfinite()

    private fun noise(): Double {
        seed = (seed * 1664525 + 1013904223) and 0xFFFFFFFFL
        val a1 = seed / 4294967296.0
        seed = (seed * 1664525 + 1013904223) and 0xFFFFFFFFL
        return (a1 + seed / 4294967296.0 - 1) * 2.449
    }

    private fun push16(v: Double) { out16[oWr] = v; oWr = (oWr + 1) and 1023; oCount++ }
    private fun pop16(): Double {
        if (oCount <= 0) return 0.0
        val v = out16[oRd]; oRd = (oRd + 1) and 1023; oCount--
        return v
    }

    private fun analyse() {
        var e0 = 0.0
        for (i in 0 until N) { val x = ring[(wr - N + i + 1024) and 1023]; frame[i] = x; e0 += x * x }
        var best = 0.0; var zc = 0
        for (i in 1 until N) if ((frame[i] >= 0) != (frame[i - 1] >= 0)) zc++
        var lag = 40
        while (lag <= 266) {
            var s = 0.0; var e1 = 1e-12; var e2 = 1e-12
            var i = lag
            while (i < N) { s += frame[i] * frame[i - lag]; e1 += frame[i] * frame[i]; e2 += frame[i - lag] * frame[i - lag]; i += 2 }
            val r = s / sqrt(e1 * e2)
            if (r > best) best = r
            lag += 2
        }
        val zcr = zc.toDouble() / N
        var u = if (best > 0.7) 0.0 else if (best < 0.3) 1.0 else (0.7 - best) / 0.4
        if (zcr > 0.28) u = max(u, min(1.0, (zcr - 0.28) / 0.12))
        var prev = 0.0
        for (i in 0 until N) { val x = frame[i]; frame[i] = (x - 0.9 * prev) * win[i]; prev = x }
        for (k in 0..P) {
            var s = 0.0
            for (i in k until N) s += frame[i] * frame[i - k]
            ac[k] = s * lagW[k]
        }
        ac[0] = ac[0] * 1.0001 + 1e-9
        val err = levinson(ac)
        normalise(u < 0.5 && e0 > 1e-6)
        val gg = sqrt(max(0.0, err) / (N * 0.375))
        gPrev = gCur; uPrev = uCur
        gCur = if (ok(gg)) gg else 0.0
        uCur = if (e0 < 1e-7) 1.0 else u
    }

    private fun levinson(r: DoubleArray): Double {
        aT.fill(0.0); aT[0] = 1.0
        var err = r[0]
        for (i in 1..P) {
            var acc = r[i]
            for (j in 1 until i) acc += aT[j] * r[i - j]
            var ki = -acc / err
            if (!ok(ki)) ki = 0.0
            ki = max(-0.995, min(0.995, ki))
            kCur[i - 1] = ki
            for (j in 1 until i) tmp[j] = aT[j] + ki * aT[i - j]
            for (j in 1 until i) aT[j] = tmp[j]
            aT[i] = ki
            err *= 1 - ki * ki
        }
        return err
    }

    private fun normalise(@Suppress("UNUSED_PARAMETER") voiced: Boolean) {
        for (k in 0 until K) {
            var re = 0.0; var im = 0.0
            val o = k * (P + 1)
            for (m in 0..P) { re += aT[m] * cosT[o + m]; im -= aT[m] * sinT[o + m] }
            S[k] = 1 / max(1e-9, re * re + im * im)
        }
        alpha += 0.1 * (formant - alpha)
        val al = alpha
        for (k in 0 until K) {
            val pos = k / al; val i0 = floor(pos).toInt(); val f = pos - i0
            Sw[k] = if (i0 + 1 < K) S[i0] * (1 - f) + S[i0 + 1] * f else S[K - 1] * 0.5
        }
        for (m in 0..P) {
            var acc = 0.5 * Sw[0]
            for (k in 1 until K) acc += Sw[k] * cosT[k * (P + 1) + m]
            rw[m] = acc * lagW2[m]
        }
        rw[0] = rw[0] * 1.001 + 1e-12
        levinson(rw)
    }

    private fun kToA(kk: DoubleArray) {
        a.fill(0.0); a[0] = 1.0
        for (i in 1..P) {
            val ki = kk[i - 1]
            for (j in 1 until i) tmp[j] = a[j] + ki * a[i - j]
            for (j in 1 until i) a[j] = tmp[j]
            a[i] = ki
        }
    }

    private fun synthHop() {
        val t = R / f0
        var n = 0
        while (n < H) {
            val f = (n + BLK / 2.0) / H
            for (i in 0 until P) kPrev[i] = kNow[i] + (kCur[i] - kNow[i]) * f
            kToA(kPrev)
            val gg = gPrev + (gCur - gPrev) * f
            val u = uPrev + (uCur - uPrev) * f
            val wv = sqrt(1 - u); val wn = sqrt(u) * 0.9 + 0.08
            for (m in 0 until BLK) {
                phase += 1
                var pulse = 0.0
                if (phase >= t) { phase -= t; pulse = sqrt(t) }
                val e = (wv * pulse + wn * noise()) * gg
                var y = e
                for (j in 1..P) y -= a[j] * hist[j - 1]
                for (j in P - 1 downTo 1) hist[j] = hist[j - 1]
                hist[0] = if (ok(y)) y else 0.0
                deY = hist[0] + 0.9 * deY
                ringPh += ringF / R
                if (ringPh >= 1) ringPh -= 1
                push16(deY * (1 - ringD + ringD * sin(2 * PI * ringPh)))
            }
            n += BLK
        }
        System.arraycopy(kCur, 0, kNow, 0, P)
    }

    /** Processes one block in place (values in -1..1). */
    fun process(buf: FloatArray, len: Int = buf.size) {
        for (i in 0 until len) {
            var x = buf[i].toDouble()
            if (!ok(x)) x = 0.0
            inP += lvA * (x * x - inP)
            val xl = biquads(dnC, dnS, x)
            dnPos += step
            while (dnPos >= 1) {
                dnPos -= 1
                val frac = 1 - dnPos / step
                val v = dnPrev + (xl - dnPrev) * max(0.0, min(1.0, frac))
                ring[wr] = v; wr = (wr + 1) and 1023; got++
                if (++sinceHop >= H) {
                    sinceHop = 0
                    if (got >= N) { analyse(); synthHop() } else repeat(H) { push16(0.0) }
                }
            }
            dnPrev = xl
            upPos += step
            while (upPos >= 1) { upPos -= 1; upA = upB; upB = pop16() }
            val y = biquads(upC, upS, upA + (upB - upA) * upPos)
            outP += lvA * (y * y - outP)
            val want = if (outP > 1e-12) sqrt(inP / outP) else g
            g += gA * (max(0.05, min(20.0, want)) - g)
            var o = y * g
            o = if (o > 1) 1.0 else if (o < -1) -1.0 else o
            buf[i] = if (ok(o)) o.toFloat() else 0f
        }
        if (!ok(g)) g = 1.0
        for (j in 0 until P) if (!ok(hist[j])) { hist.fill(0.0); break }
        if (!ok(deY)) deY = 0.0
    }

    /** Output lags input by this many samples; callers trim it from the start. */
    val latencySamples: Int = ((N / 2 + H) / R * sr).toInt()
}
