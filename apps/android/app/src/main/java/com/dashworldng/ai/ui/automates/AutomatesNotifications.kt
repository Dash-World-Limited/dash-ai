package com.dashworldng.ai.ui.automates

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.NotificationsNone
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.dashworldng.ai.core.remote.PushPreferencesDto
import com.dashworldng.ai.core.stream.ApiException
import com.dashworldng.ai.di.AppServices
import com.dashworldng.ai.ui.components.PrimaryButton
import com.dashworldng.ai.ui.components.QuietCard
import com.dashworldng.ai.ui.components.SettingsDivider
import com.dashworldng.ai.ui.components.SettingsGroup
import com.dashworldng.ai.ui.components.SettingsRow
import com.dashworldng.ai.ui.components.TextAction
import com.dashworldng.ai.ui.dashViewModel
import com.dashworldng.ai.ui.theme.DashTheme
import com.dashworldng.ai.ui.theme.Spacing
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** Android 13+'s runtime permission (a literal, so older SDK stubs need no constant). */
private const val POST_NOTIFICATIONS = "android.permission.POST_NOTIFICATIONS"

/**
 * Asks for notification permission the DASH AI way: the system prompt only after the person chose to
 * turn notifications on (Android 13+), otherwise this app's notification settings. Whatever they
 * decide, Automates keep running and results wait in the app.
 */
@Composable
fun rememberNotificationRequest(services: AppServices, onAnswered: () -> Unit = {}): () -> Unit {
    val permission = services.notificationPermission
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { _ ->
        permission.refresh()
        onAnswered()
    }
    return {
        if (permission.canPrompt) {
            launcher.launch(POST_NOTIFICATIONS)
        } else {
            permission.openSystemSettings()
            onAnswered()
        }
    }
}

/**
 * Shown on Automates (signed in, notifications not allowed yet, not answered before): explains what
 * DASH AI notifies about before any system prompt appears.
 */
@Composable
fun NotificationOfferCard(onTurnOn: () -> Unit, onNotNow: () -> Unit, modifier: Modifier = Modifier) {
    val c = DashTheme.colors
    QuietCard(modifier.fillMaxWidth().testTag("notification_offer")) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Rounded.NotificationsNone, contentDescription = null, tint = c.accentInk, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(Spacing.sm))
            Text("Know when results are ready", style = MaterialTheme.typography.titleSmall, color = c.ink, modifier = Modifier.semantics { heading() })
        }
        Spacer(Modifier.height(Spacing.xs))
        Text(
            "DASH AI can notify you when a scheduled task finishes or needs your attention, even when the app is closed. " +
                "Notifications never show your prompts or results.",
            style = MaterialTheme.typography.bodySmall,
            color = c.inkSecondary,
        )
        Spacer(Modifier.height(Spacing.md))
        Row(horizontalArrangement = Arrangement.spacedBy(Spacing.sm), verticalAlignment = Alignment.CenterVertically) {
            PrimaryButton("Turn on notifications", onTurnOn, modifier = Modifier.testTag("notification_offer_on"))
            TextAction("Not now", onNotNow, modifier = Modifier.testTag("notification_offer_later"))
        }
    }
}

data class AutomatesNotificationsState(
    /** Null until the server answered (or when it could not be reached). */
    val preferences: PushPreferencesDto? = null,
    val saving: Boolean = false,
    val error: String? = null,
)

/** The account's Automates notifications choice, kept on the server (it applies to every device). */
class AutomatesNotificationsViewModel(private val services: AppServices) : ViewModel() {
    private val _state = MutableStateFlow(AutomatesNotificationsState())
    val state: StateFlow<AutomatesNotificationsState> = _state.asStateFlow()

    fun load() {
        val api = services.pushApi() ?: return
        viewModelScope.launch {
            try {
                val prefs = api.preferences()
                _state.update { it.copy(preferences = prefs, error = null) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException) {
                _state.update { it.copy(error = e.error.message) }
            } catch (e: Exception) {
                _state.update { it.copy(error = "Couldn't load your notification setting.") }
            }
        }
    }

    fun setAutomates(on: Boolean) {
        val api = services.pushApi() ?: return
        if (_state.value.saving) return
        _state.update { it.copy(saving = true, error = null) }
        viewModelScope.launch {
            try {
                val prefs = api.setAutomates(on)
                _state.update { it.copy(preferences = prefs, saving = false) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException) {
                _state.update { it.copy(saving = false, error = e.error.message) }
            } catch (e: Exception) {
                _state.update { it.copy(saving = false, error = "Couldn't save your notification setting.") }
            }
        }
    }
}

/** What the Automates notifications row says, from the account's choice, the server and the phone. */
fun automatesNotificationsSubtitle(prefs: PushPreferencesDto?, allowedOnPhone: Boolean, error: String?): String = when {
    prefs == null -> error ?: "Results that are ready and tasks that need attention"
    !prefs.available -> "This DASH AI server isn't sending notifications yet. Results still appear in Automates."
    !prefs.automates -> "Off. Automations still run, and results appear in Automates."
    !allowedOnPhone -> "Notifications are turned off for DASH AI on this phone, so none can appear."
    else -> "On. DASH AI tells you when a scheduled result is ready or needs attention."
}

/** Settings → Notifications (signed in only). */
@Composable
fun AutomatesNotificationsGroup(services: AppServices) {
    val vm = dashViewModel { AutomatesNotificationsViewModel(services) }
    val state by vm.state.collectAsStateWithLifecycle()
    val allowed by services.notificationPermission.granted.collectAsStateWithLifecycle()
    val request = rememberNotificationRequest(services)
    LaunchedEffect(Unit) { vm.load() }
    val c = DashTheme.colors
    val prefs = state.preferences
    SettingsGroup("Notifications") {
        SettingsRow(
            "Automates notifications",
            subtitle = automatesNotificationsSubtitle(prefs, allowed, state.error),
            icon = Icons.Rounded.NotificationsNone,
            trailing = {
                Switch(
                    checked = prefs?.automates == true,
                    enabled = prefs != null && !state.saving,
                    onCheckedChange = vm::setAutomates,
                    colors = SwitchDefaults.colors(checkedTrackColor = c.accent, checkedThumbColor = c.surface, uncheckedTrackColor = c.surfaceMuted, uncheckedBorderColor = c.outlineStrong, uncheckedThumbColor = c.inkTertiary),
                    modifier = Modifier.semantics { contentDescription = "Automates notifications" }.testTag("automates_notifications_switch"),
                )
            },
            modifier = Modifier.testTag("automates_notifications"),
        )
        if (!allowed && prefs?.available != false && prefs?.automates != false) {
            SettingsDivider()
            SettingsRow(
                "Allow notifications on this phone",
                subtitle = "Android decides whether DASH AI may show notifications.",
                onClick = request,
                modifier = Modifier.testTag("allow_notifications"),
            )
        }
    }
}
