package com.dashworldng.ai.data.sync

import android.content.Context
import com.dashworldng.ai.core.account.LocalOwnerState
import com.dashworldng.ai.core.account.LocalOwnerStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Which account the local data belongs to, and whether a sign-out is still removing it. App-private,
 * excluded from backup and device transfer. Written with commit() (synchronously): a sign-out must
 * be recorded before data is deleted, so an interrupted one is finished at the next start.
 */
class PrefsLocalOwnerStore(context: Context) : LocalOwnerStore {
    private val prefs = context.applicationContext.getSharedPreferences("dash_local_owner", Context.MODE_PRIVATE)

    override suspend fun load(): LocalOwnerState = withContext(Dispatchers.IO) { LocalOwnerState.decode(prefs.getString(KEY, null)) }

    override suspend fun save(state: LocalOwnerState) {
        withContext(Dispatchers.IO) { prefs.edit().putString(KEY, LocalOwnerState.encode(state)).commit() }
    }

    private companion object {
        const val KEY = "owner"
    }
}
