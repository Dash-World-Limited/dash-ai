package com.dashworldng.ai.data.security

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Holds the Dash AI session token. AI-provider keys never exist on the device. */
interface TokenStore {
    fun get(): String?
    fun set(token: String?)
}

class InMemoryTokenStore(private var token: String? = null) : TokenStore {
    override fun get(): String? = token

    override fun set(token: String?) {
        this.token = token
    }
}

/**
 * Encrypts the session token with an AES-256-GCM key that lives in the Android Keystore and
 * cannot be exported. Only the ciphertext is written to app-private preferences, which are also
 * excluded from backups (see data_extraction_rules.xml).
 */
class KeystoreTokenStore(context: Context) : TokenStore {
    private val prefs = context.applicationContext.getSharedPreferences("dash_secure", Context.MODE_PRIVATE)

    @Volatile
    private var cached: String? = null

    @Volatile
    private var loaded = false

    override fun get(): String? {
        if (loaded) return cached
        synchronized(this) {
            if (!loaded) {
                cached = decrypt()
                loaded = true
            }
            return cached
        }
    }

    @Synchronized
    override fun set(token: String?) {
        cached = token
        loaded = true
        if (token == null) {
            prefs.edit().remove(PREF_KEY).apply()
            return
        }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val payload = cipher.iv + cipher.doFinal(token.toByteArray(Charsets.UTF_8))
        prefs.edit().putString(PREF_KEY, Base64.encodeToString(payload, Base64.NO_WRAP)).apply()
    }

    private fun decrypt(): String? {
        val stored = prefs.getString(PREF_KEY, null) ?: return null
        return try {
            val bytes = Base64.decode(stored, Base64.NO_WRAP)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes, 0, IV_BYTES))
            String(cipher.doFinal(bytes, IV_BYTES, bytes.size - IV_BYTES), Charsets.UTF_8)
        } catch (e: Exception) {
            // Key invalidated or data corrupted: forget the token; the user signs in again.
            prefs.edit().remove(PREF_KEY).apply()
            null
        }
    }

    private fun key(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (keyStore.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    private companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val ALIAS = "dash_ai_session_key"
        const val PREF_KEY = "session_token"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val IV_BYTES = 12
    }
}
