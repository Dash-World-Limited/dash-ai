package com.dashworldng.ai.di

import com.dashworldng.ai.core.account.SignOutResult
import com.dashworldng.ai.core.auth.AuthSession
import com.dashworldng.ai.data.settings.AccountInfo

/**
 * Every change of who is using the app goes through here: signing in, continuing in Demo Mode and
 * signing out. A screen that asks the person to sign in only opens the sign-in screen; it never edits
 * `account` or `demoMode` itself, so [com.dashworldng.ai.core.account.LocalAccountGuard]'s rules
 * always apply, whichever screen the person came from:
 * - signing in as the account whose data is on this device keeps that data and its unsynced changes;
 * - signing in as another account removes the previous account's data first;
 * - Demo Mode never shows an account's data as a demo. With a real account still recorded, Demo Mode
 *   runs on top of it (as the Settings switch does) and the account stays. Without one, data an
 *   account still owns is removed through the normal sign-out first.
 */
class AccountTransitions(private val services: AppServices) {
    /** After the server accepted the credentials: before anything of the account is stored or shown. */
    suspend fun signedIn(session: AuthSession) {
        services.accountGuard.onSignedIn(session.user.id)
        services.tokens.set(session.token)
        services.syncTracker.reset()
        services.settings.update {
            it.copy(demoMode = false, account = AccountInfo(session.user.id, session.user.email, session.user.displayName, isDemo = false))
        }
    }

    suspend fun continueInDemo() {
        val account = services.settings.settings.value.account
        if (account != null && !account.isDemo) {
            services.settings.update { it.copy(demoMode = true) }
            return
        }
        releaseAccountDataForDemo()
        services.settings.update { it.copy(demoMode = true, account = DEMO_PROFILE) }
    }

    /** Signs out on this device (see LocalAccountGuard.signOut) and returns to the signed-out state. */
    suspend fun signedOut(revokeServerSession: suspend () -> Unit): SignOutResult {
        val result = services.accountGuard.signOut(revokeServerSession)
        services.syncTracker.reset()
        services.settings.update { it.copy(account = null, demoMode = true) }
        return result
    }

    /** Leaves the demo profile. Its chats stay on this device, separate from any account. */
    suspend fun leaveDemoProfile() {
        services.settings.update { it.copy(account = null, demoMode = true) }
    }

    /**
     * At start-up: an earlier version could put the demo profile over data an account still owned.
     * That data is removed the same way, before any screen shows it.
     */
    suspend fun repairAtStart() {
        if (services.settings.settings.value.account?.isDemo == true) releaseAccountDataForDemo()
    }

    private suspend fun releaseAccountDataForDemo() {
        val released = services.accountGuard.releaseForDemo(revokeServerSession = {
            // Best effort, bounded by the guard: the session the device still holds is ended too.
            if (services.tokens.get() != null) services.authService()?.logout()
        })
        if (released != null) services.syncTracker.reset()
    }

    companion object {
        val DEMO_PROFILE = AccountInfo("demo-local", null, "Demo user", isDemo = true)
    }
}
