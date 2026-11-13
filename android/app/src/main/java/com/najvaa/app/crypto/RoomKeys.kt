package com.najvaa.app.crypto

import com.najvaa.app.core.Bytes

/**
 * Everything a room needs, derived from its seven-digit code and password.
 * The derivation matches the web client byte for byte (PBKDF2 800k rounds +
 * HKDF), which is what lets one room be opened from a browser and this app.
 *
 *  - [roomId]    names the room on the relay (HKDF of the code only).
 *  - [psk]       authenticates every live handshake; never leaves the device.
 *  - [histKey]   encrypts the history kept on the server.
 *  - [storeAuth] the password-derived token the store checks (its hash is
 *                registered on first write).
 *  - [vaultKey]  Android only: encrypts this room's local vault file.
 */
class RoomKeys private constructor(
    val code: String,
    val roomId: String,
    val psk: ByteArray,
    val histKey: ByteArray,
    val storeAuth: String,
    val vaultKey: ByteArray,
) {
    fun wipe() = Bytes.wipe(psk, histKey, vaultKey)

    /** psk || histKey || vaultKey || storeAuth, for caching under the master key so rooms reopen instantly. */
    fun export(): ByteArray = Bytes.concat(psk, histKey, vaultKey, Bytes.utf8(storeAuth))

    companion object {
        const val PBKDF2_ITERATIONS = 800_000

        fun restore(code: String, exported: ByteArray): RoomKeys? {
            if (exported.size < 96 + 43) return null
            return RoomKeys(
                code = code,
                roomId = roomId(code),
                psk = exported.copyOfRange(0, 32),
                histKey = exported.copyOfRange(32, 64),
                vaultKey = exported.copyOfRange(64, 96),
                storeAuth = Bytes.text(exported.copyOfRange(96, exported.size)),
            )
        }

        fun roomId(code: String): String =
            Bytes.b64u(Primitives.hkdf(Bytes.utf8("najva/room/$code"), Primitives.ZERO32, "wn1/room-id", 16))

        /** Slow (PBKDF2 800k): always call off the main thread. */
        fun derive(code: String, password: String): RoomKeys {
            val passKey = Primitives.pbkdf2(password, Bytes.utf8("najva/v1/$code"), PBKDF2_ITERATIONS)
            val salt = Bytes.utf8(code)
            val keys = RoomKeys(
                code = code,
                roomId = roomId(code),
                psk = Primitives.hkdf(passKey, salt, "wn1/psk"),
                histKey = Primitives.hkdf(passKey, salt, "wn1/history"),
                storeAuth = Bytes.b64u(Primitives.hkdf(passKey, salt, "wn1/store-auth")),
                vaultKey = Primitives.hkdf(passKey, salt, "najvaa/android/room-vault"),
            )
            Bytes.wipe(passKey)
            return keys
        }
    }

    private fun histAad(entryId: String) = Bytes.utf8("wn1/hist/$roomId/$entryId")

    /** Returns (iv, ct) base64url, the store's wire form. */
    fun sealHistory(entryId: String, plainJson: ByteArray): Pair<String, String> {
        val iv = Bytes.random(12)
        val ct = Primitives.aesGcmEncrypt(histKey, iv, Primitives.pad(plainJson), histAad(entryId))
        return Bytes.b64u(iv) to Bytes.b64u(ct)
    }

    fun openHistory(entryId: String, ivB64: String, ctB64: String): ByteArray? {
        val iv = Bytes.unb64u(ivB64) ?: return null
        val ct = Bytes.unb64u(ctB64) ?: return null
        val padded = Primitives.aesGcmDecrypt(histKey, iv, ct, histAad(entryId)) ?: return null
        return Primitives.unpad(padded)
    }
}
