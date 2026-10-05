@file:Suppress("unused", "UNUSED_PARAMETER")
package com.dashworldng.ai.data.security
/** STUB copies of TokenStore's public API (the real file needs the Android Keystore). */
interface TokenStore { fun get(): String?; fun set(token: String?) }
class InMemoryTokenStore(private var token: String? = null) : TokenStore { override fun get() = token; override fun set(token: String?) { this.token = token } }
class KeystoreTokenStore(context: android.content.Context) : TokenStore { override fun get(): String? = null; override fun set(token: String?) = Unit }
