package com.najvaa.app.core

import android.util.Base64
import java.nio.ByteBuffer
import java.security.SecureRandom

/** Byte helpers shared by the crypto, vault and wire layers. */
object Bytes {
    private val random = SecureRandom()

    fun random(size: Int): ByteArray = ByteArray(size).also { random.nextBytes(it) }

    fun b64u(bytes: ByteArray): String =
        Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)

    fun unb64u(text: String): ByteArray? = runCatching {
        if (!text.matches(Regex("^[A-Za-z0-9_-]*$"))) return null
        Base64.decode(text, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
    }.getOrNull()

    fun b64(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.NO_WRAP)

    fun unb64(text: String): ByteArray? = runCatching { Base64.decode(text, Base64.NO_WRAP) }.getOrNull()

    fun concat(vararg parts: ByteArray): ByteArray {
        val out = ByteArray(parts.sumOf { it.size })
        var offset = 0
        for (p in parts) {
            System.arraycopy(p, 0, out, offset, p.size)
            offset += p.size
        }
        return out
    }

    fun u32(value: Int): ByteArray = ByteBuffer.allocate(4).putInt(value).array()

    fun u32At(bytes: ByteArray, offset: Int): Int = ByteBuffer.wrap(bytes, offset, 4).int

    /** Length-prefixed (2 bytes, big endian), for unambiguous handshake transcripts. */
    fun lp(bytes: ByteArray): ByteArray = concat(ByteBuffer.allocate(2).putShort(bytes.size.toShort()).array(), bytes)

    fun wipe(vararg arrays: ByteArray?) {
        for (a in arrays) a?.fill(0)
    }

    fun constantTimeEquals(a: ByteArray, b: ByteArray): Boolean {
        if (a.size != b.size) return false
        var diff = 0
        for (i in a.indices) diff = diff or (a[i].toInt() xor b[i].toInt())
        return diff == 0
    }

    fun compare(a: ByteArray, b: ByteArray): Int {
        val n = minOf(a.size, b.size)
        for (i in 0 until n) {
            val d = (a[i].toInt() and 0xFF) - (b[i].toInt() and 0xFF)
            if (d != 0) return d
        }
        return a.size - b.size
    }

    fun utf8(text: String): ByteArray = text.toByteArray(Charsets.UTF_8)

    fun text(bytes: ByteArray): String = String(bytes, Charsets.UTF_8)
}
