package com.najvaa.app.vault

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * A hardware-backed AES key in the Android Keystore that only works right
 * after a strong biometric check (every single use needs a fresh prompt) and
 * dies when a fingerprint is added or removed. It wraps the vault master key
 * so a fingerprint can open the app; the master key itself is never stored
 * in the clear anywhere.
 */
object DeviceKey {

    private const val ALIAS = "najvaa.master.v2"

    private fun keyStore() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    fun exists(): Boolean = runCatching { keyStore().containsAlias(ALIAS) }.getOrDefault(false)

    fun delete() {
        runCatching { keyStore().deleteEntry(ALIAS) }
    }

    private fun create(context: Context): SecretKey {
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        fun spec(strongBox: Boolean): KeyGenParameterSpec {
            val b = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setUserAuthenticationRequired(true)
                .setInvalidatedByBiometricEnrollment(true)
            if (Build.VERSION.SDK_INT >= 30) {
                b.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
            } else {
                @Suppress("DEPRECATION")
                b.setUserAuthenticationValidityDurationSeconds(-1)
            }
            if (Build.VERSION.SDK_INT >= 28 && strongBox) b.setIsStrongBoxBacked(true)
            return b.build()
        }
        val hasStrongBox = Build.VERSION.SDK_INT >= 28 &&
            context.packageManager.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE)
        if (hasStrongBox) {
            runCatching {
                generator.init(spec(true))
                return generator.generateKey()
            }
        }
        generator.init(spec(false))
        return generator.generateKey()
    }

    private fun key(context: Context): SecretKey {
        (keyStore().getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        return create(context)
    }

    /** A cipher to hand to BiometricPrompt before wrapping. */
    fun encryptCipher(context: Context): Cipher? = runCatching {
        Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key(context)) }
    }.getOrNull()

    /** A cipher to hand to BiometricPrompt before unwrapping [blob]. */
    fun decryptCipher(context: Context, blob: ByteArray): Cipher? = runCatching {
        val iv = blob.copyOfRange(0, 12)
        Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(Cipher.DECRYPT_MODE, key(context), GCMParameterSpec(128, iv))
        }
    }.getOrNull()

    /** After the prompt succeeded: iv || sealed master key. */
    fun wrap(authenticated: Cipher, masterKey: ByteArray): ByteArray? = runCatching {
        val sealed = authenticated.doFinal(masterKey)
        val iv = authenticated.iv
        ByteArray(iv.size + sealed.size).also {
            System.arraycopy(iv, 0, it, 0, iv.size)
            System.arraycopy(sealed, 0, it, iv.size, sealed.size)
        }
    }.getOrNull()

    fun unwrap(authenticated: Cipher, blob: ByteArray): ByteArray? = runCatching {
        authenticated.doFinal(blob.copyOfRange(12, blob.size))
    }.getOrNull()
}
