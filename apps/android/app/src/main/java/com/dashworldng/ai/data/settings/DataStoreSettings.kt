package com.dashworldng.ai.data.settings

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.dashworldng.ai.core.demo.DemoFailure
import com.dashworldng.ai.core.model.AssistantMode
import com.dashworldng.ai.core.model.ModelChoice
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn

private val Context.dataStore: DataStore<Preferences> by preferencesDataStore(name = "dash_settings")

class DataStoreSettingsRepository(
    context: Context,
    scope: CoroutineScope,
    private val defaultServerUrl: String,
) : SettingsRepository {
    private val store = context.applicationContext.dataStore

    private object Keys {
        val onboarding = booleanPreferencesKey("onboarding_complete")
        val demo = booleanPreferencesKey("demo_mode")
        val server = stringPreferencesKey("server_url")
        val model = stringPreferencesKey("default_model")
        val mode = stringPreferencesKey("default_mode")
        val demoFailure = stringPreferencesKey("demo_failure")
        val userId = stringPreferencesKey("account_user_id")
        val email = stringPreferencesKey("account_email")
        val name = stringPreferencesKey("account_name")
        val accountDemo = booleanPreferencesKey("account_demo")
        val theme = stringPreferencesKey("theme")
    }

    override val settings: StateFlow<AppSettings> = store.data
        .map(::read)
        .stateIn(scope, SharingStarted.Eagerly, AppSettings(serverUrl = defaultServerUrl))

    override suspend fun update(transform: (AppSettings) -> AppSettings) {
        store.edit { prefs -> write(prefs, transform(read(prefs))) }
    }

    private fun read(p: Preferences): AppSettings {
        val userId = p[Keys.userId]
        return AppSettings(
            loaded = true,
            onboardingComplete = p[Keys.onboarding] ?: false,
            demoMode = p[Keys.demo] ?: true,
            serverUrl = p[Keys.server] ?: defaultServerUrl,
            defaultModelChoice = p[Keys.model]?.let { ModelChoice.fromWire(it) } ?: ModelChoice.SMART,
            defaultMode = p[Keys.mode]?.let { AssistantMode.fromWire(it) } ?: AssistantMode.GENERAL,
            demoFailure = p[Keys.demoFailure]?.let { v -> DemoFailure.entries.firstOrNull { it.name == v } } ?: DemoFailure.NONE,
            theme = ThemePreference.fromWire(p[Keys.theme]),
            account = userId?.let {
                AccountInfo(it, p[Keys.email], p[Keys.name] ?: "Dash AI user", p[Keys.accountDemo] ?: true)
            },
        )
    }

    private fun write(p: androidx.datastore.preferences.core.MutablePreferences, s: AppSettings) {
        p[Keys.onboarding] = s.onboardingComplete
        p[Keys.demo] = s.demoMode
        p[Keys.server] = s.serverUrl
        p[Keys.model] = s.defaultModelChoice.wire
        p[Keys.mode] = s.defaultMode.wire
        p[Keys.demoFailure] = s.demoFailure.name
        p[Keys.theme] = s.theme.wire
        val account = s.account
        if (account == null) {
            p.remove(Keys.userId)
            p.remove(Keys.email)
            p.remove(Keys.name)
            p.remove(Keys.accountDemo)
        } else {
            p[Keys.userId] = account.userId
            if (account.email != null) p[Keys.email] = account.email else p.remove(Keys.email)
            p[Keys.name] = account.displayName
            p[Keys.accountDemo] = account.isDemo
        }
    }
}
