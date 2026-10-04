package com.dashworldng.ai.data.sync

import android.content.Context
import com.dashworldng.ai.core.sync.SyncState
import com.dashworldng.ai.core.sync.SyncStateStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Keeps the sync cursor and unconfirmed local deletions/renames in app-private preferences.
 * It holds conversation ids and titles only, and is excluded from backup and device transfer
 * (see res/xml/data_extraction_rules.xml). Losing it is safe: the next sync simply pulls everything.
 */
class PrefsSyncStateStore(context: Context) : SyncStateStore {
    private val prefs = context.applicationContext.getSharedPreferences("dash_sync_state", Context.MODE_PRIVATE)

    override suspend fun load(): SyncState = withContext(Dispatchers.IO) { SyncState.decode(prefs.getString(KEY, null)) }

    override suspend fun save(state: SyncState) = withContext(Dispatchers.IO) {
        prefs.edit().putString(KEY, SyncState.encode(state)).apply()
    }

    private companion object {
        const val KEY = "state"
    }
}
