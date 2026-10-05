@file:Suppress("unused", "UNUSED_PARAMETER")
package com.dashworldng.ai.data.settings
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
/** STUB of DataStoreSettings.kt (DataStore is Google Maven only). */
class DataStoreSettingsRepository(context: android.content.Context, scope: CoroutineScope, defaultServerUrl: String) : SettingsRepository {
    override val settings: StateFlow<AppSettings> = MutableStateFlow(AppSettings())
    override suspend fun update(transform: (AppSettings) -> AppSettings) = Unit
}
