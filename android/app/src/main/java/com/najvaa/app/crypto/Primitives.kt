package com.najvaa.app.crypto

import com.najvaa.app.core.Bytes
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.text.Normalizer
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

/**
 * The same primitives the web client uses (HKDF-SHA256, HMAC-SHA256,
 * PBKDF2-HMAC-SHA256, AES-256-GCM, 256-byte bucket padding), so ciphertext
 * written by a browser opens on the phone and the other way round.
 */
object Primitives {
    private const val TAG_BITS = 128
    private const val PAD_BLOCK = 256
    val ZERO32 = ByteArray(32)

    fun sha256(vararg parts: ByteArray): ByteArray {
        val md = MessageDigest.getInstance("SHA-256")
        for (p in parts) md.update(p)
        return md.digest()
    }

    fun hmac(key: ByteArray, data: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        return mac.doFinal(data)
    }

    fun hkdf(ikm: ByteArray, salt: ByteArray, info: String, length: Int = 32): ByteArray {
        val prk = hmac(if (salt.isEmpty()) ZERO32 else salt, ikm)
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(prk, "HmacSHA256"))
        val infoBytes = Bytes.utf8(info)
        val out = ByteArrayOutputStream(length)
        var block = ByteArray(0)
        var counter = 1
        while (out.size() < length) {
            mac.reset()
            mac.update(block)
            mac.update(infoBytes)
            mac.update(counter.toByte())
            block = mac.doFinal()
            out.write(block)
            counter++
        }
        Bytes.wipe(prk)
        return out.toByteArray().copyOf(length)
    }

    fun pbkdf2(password: String, salt: ByteArray, iterations: Int, bits: Int = 256): ByteArray {
        val normalized = Normalizer.normalize(password, Normalizer.Form.NFC)
        val spec = PBEKeySpec(normalized.toCharArray(), salt, iterations, bits)
        return try {
            SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded
        } finally {
            spec.clearPassword()
        }
    }

    fun aesGcmEncrypt(key: ByteArray, iv: ByteArray, plain: ByteArray, aad: ByteArray? = null): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BITS, iv))
        if (aad != null) cipher.updateAAD(aad)
        return cipher.doFinal(plain)
    }

    fun aesGcmDecrypt(key: ByteArray, iv: ByteArray, sealed: ByteArray, aad: ByteArray? = null): ByteArray? = try {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BITS, iv))
        if (aad != null) cipher.updateAAD(aad)
        cipher.doFinal(sealed)
    } catch (_: Exception) {
        null
    }

    /** iv(12) || ciphertext, for local storage where no AAD context exists. */
    fun seal(key: ByteArray, plain: ByteArray, aad: ByteArray? = null): ByteArray {
        val iv = Bytes.random(12)
        return Bytes.concat(iv, aesGcmEncrypt(key, iv, plain, aad))
    }

    fun open(key: ByteArray, blob: ByteArray, aad: ByteArray? = null): ByteArray? {
        if (blob.size < 12 + 16) return null
        return aesGcmDecrypt(key, blob.copyOfRange(0, 12), blob.copyOfRange(12, blob.size), aad)
    }

    /**
     * Every message is padded to 256-byte buckets (4-byte big-endian length,
     * payload, random tail), so neither the relay nor the store learns sizes.
     */
    fun pad(bytes: ByteArray): ByteArray {
        val size = ((bytes.size + 4 + PAD_BLOCK - 1) / PAD_BLOCK) * PAD_BLOCK
        val out = ByteArray(size)
        ByteBuffer.wrap(out).putInt(bytes.size)
        System.arraycopy(bytes, 0, out, 4, bytes.size)
        val tail = size - 4 - bytes.size
        if (tail > 0) System.arraycopy(Bytes.random(tail), 0, out, 4 + bytes.size, tail)
        return out
    }

    fun unpad(bytes: ByteArray): ByteArray? {
        if (bytes.size < 4) return null
        val length = ByteBuffer.wrap(bytes).int
        if (length < 0 || length > bytes.size - 4) return null
        return bytes.copyOfRange(4, 4 + length)
    }
}
