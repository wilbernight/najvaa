package com.najvaa.app.crypto

import com.najvaa.app.core.Bytes
import org.bouncycastle.math.ec.rfc7748.X25519
import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.PrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import javax.crypto.KeyAgreement

/** Ephemeral key pairs for the live handshake: X25519 preferred, P-256 as the fallback both sides support. */
class X25519Pair(val priv: ByteArray, val pub: ByteArray) {
    fun wipe() = Bytes.wipe(priv)

    companion object {
        fun generate(): X25519Pair {
            val priv = ByteArray(32)
            X25519.generatePrivateKey(java.security.SecureRandom(), priv)
            val pub = ByteArray(32)
            X25519.generatePublicKey(priv, 0, pub, 0)
            return X25519Pair(priv, pub)
        }
    }

    fun agree(peerPub: ByteArray): ByteArray {
        require(peerPub.size == 32) { "x25519 pub" }
        val out = ByteArray(32)
        if (!X25519.calculateAgreement(priv, 0, peerPub, 0, out, 0)) throw IllegalStateException("weak key")
        if (out.all { it == 0.toByte() }) throw IllegalStateException("weak key")
        return out
    }
}

class P256Pair(private val priv: PrivateKey, val pub: ByteArray) {
    companion object {
        private val params: ECParameterSpec by lazy {
            AlgorithmParameters.getInstance("EC").apply { init(ECGenParameterSpec("secp256r1")) }
                .getParameterSpec(ECParameterSpec::class.java)
        }

        fun generate(): P256Pair {
            val gen = KeyPairGenerator.getInstance("EC")
            gen.initialize(ECGenParameterSpec("secp256r1"))
            val kp = gen.generateKeyPair()
            val point = (kp.public as ECPublicKey).w
            return P256Pair(kp.private, encode(point))
        }

        /** Uncompressed SEC1 encoding (0x04 || X || Y), what WebCrypto exports as "raw". */
        private fun encode(point: ECPoint): ByteArray {
            val x = point.affineX.toByteArray().let { trim(it) }
            val y = point.affineY.toByteArray().let { trim(it) }
            return Bytes.concat(byteArrayOf(4), x, y)
        }

        private fun trim(b: ByteArray): ByteArray {
            val out = ByteArray(32)
            val src = if (b.size > 32) b.copyOfRange(b.size - 32, b.size) else b
            System.arraycopy(src, 0, out, 32 - src.size, src.size)
            return out
        }
    }

    fun agree(peerPub: ByteArray): ByteArray {
        require(peerPub.size == 65 && peerPub[0] == 4.toByte()) { "p256 pub" }
        val x = BigInteger(1, peerPub.copyOfRange(1, 33))
        val y = BigInteger(1, peerPub.copyOfRange(33, 65))
        val peer = KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(ECPoint(x, y), params))
        val ka = KeyAgreement.getInstance("ECDH")
        ka.init(priv)
        ka.doPhase(peer, true)
        val out = ka.generateSecret()
        if (out.all { it == 0.toByte() }) throw IllegalStateException("weak key")
        return out
    }
}
