package com.dashworldng.ai.core.presentation

/**
 * The DASH AI server address can only change while no account is signed in. The session token was
 * issued by the current server; a new address would receive it with every request (and this device's
 * account data would sit under the wrong server).
 */
object ServerAddress {
    const val SIGN_OUT_FIRST = "Sign out before changing the server address. Your session belongs to the current server."

    /** Why [next] cannot replace [current] now, or null when it can. Addresses are already normalized. */
    fun changeRefusal(signedIn: Boolean, current: String, next: String): String? =
        if (signedIn && current.isNotBlank() && next != current) SIGN_OUT_FIRST else null
}
