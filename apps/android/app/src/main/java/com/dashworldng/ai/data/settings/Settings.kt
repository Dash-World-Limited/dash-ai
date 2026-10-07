package com.dashworldng.ai.data.settings

import com.dashworldng.ai.core.demo.DemoFailure
import com.dashworldng.ai.core.model.AssistantMode
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/** The signed-in account, or the local demo profile. Tokens are stored separately (TokenStore). */
data class AccountInfo(
    val userId: String,
    val email: String?,
    val displayName: String,
    val isDemo: Boolean,
)

data class AppSettings(
    val loaded: Boolean = false,
    val onboardingComplete: Boolean = false,
    /** Demo Mode is on until the user signs in to a live server. */
    val demoMode: Boolean = true,
    val serverUrl: String = "",
    val defaultMode: AssistantMode = AssistantMode.GENERAL,
    val demoFailure: DemoFailure = DemoFailure.NONE,
    val account: AccountInfo? = null,
    val theme: ThemePreference = ThemePreference.SYSTEM,
    /** The person has answered DASH AI's "notify me when results are ready" offer on this device. */
    val notificationPromptAnswered: Boolean = false,
)

/** Light, dark, or follow the system. Stored in settings (Settings → Appearance). */
enum class ThemePreference(val wire: String, val label: String) {
    SYSTEM("system", "System default"),
    LIGHT("light", "Light"),
    DARK("dark", "Dark");

    companion object {
        fun fromWire(value: String?): ThemePreference = entries.firstOrNull { it.wire == value } ?: SYSTEM
    }
}

interface SettingsRepository {
    val settings: StateFlow<AppSettings>
    suspend fun update(transform: (AppSettings) -> AppSettings)
}

class InMemorySettingsRepository(initial: AppSettings = AppSettings(loaded = true)) : SettingsRepository {
    private val state = MutableStateFlow(initial)
    override val settings: StateFlow<AppSettings> = state.asStateFlow()

    override suspend fun update(transform: (AppSettings) -> AppSettings) {
        state.update(transform)
    }
}
