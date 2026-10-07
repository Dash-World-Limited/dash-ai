package com.dashworldng.ai.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.Logout
import androidx.compose.material.icons.rounded.CloudSync
import androidx.compose.material.icons.rounded.DeleteForever
import androidx.compose.material.icons.rounded.Devices
import androidx.compose.material.icons.rounded.PhoneAndroid
import androidx.compose.material.icons.rounded.Science
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.dashworldng.ai.core.presentation.Greeting
import com.dashworldng.ai.core.presentation.StatusTone
import com.dashworldng.ai.core.presentation.SyncStatus
import com.dashworldng.ai.core.presentation.SyncStatuses
import com.dashworldng.ai.core.remote.UsageSummaryDto
import com.dashworldng.ai.core.stream.ApiException
import com.dashworldng.ai.data.settings.AppSettings
import com.dashworldng.ai.di.AppServices
import com.dashworldng.ai.ui.components.Avatar
import com.dashworldng.ai.ui.components.ConfirmDialog
import com.dashworldng.ai.ui.components.ContentWidth
import com.dashworldng.ai.ui.components.DashTopBar
import com.dashworldng.ai.ui.components.DemoBadge
import com.dashworldng.ai.ui.components.Notice
import com.dashworldng.ai.ui.components.PrimaryButton
import com.dashworldng.ai.ui.components.SettingsDivider
import com.dashworldng.ai.ui.components.SettingsGroup
import com.dashworldng.ai.ui.components.SettingsRow
import com.dashworldng.ai.ui.components.StatusBadge
import com.dashworldng.ai.ui.dashViewModel
import com.dashworldng.ai.ui.theme.DashTheme
import com.dashworldng.ai.ui.theme.Spacing
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class AccountExtras(
    val usage: UsageSummaryDto? = null,
    val busy: Boolean = false,
    val error: String? = null,
    /** Local changes not yet on the server; signing out discards them, so the user is told first. */
    val pendingChanges: Int = 0,
)

enum class SignOutKind { THIS_DEVICE, EVERYWHERE }

class AccountViewModel(private val services: AppServices) : ViewModel() {
    val settings: StateFlow<AppSettings> = services.settings.settings
    private val _extras = MutableStateFlow(AccountExtras())
    val extras: StateFlow<AccountExtras> = _extras.asStateFlow()

    val sync: StateFlow<SyncStatus> = combine(services.syncTracker.snapshot, services.connectivity.isOnline, settings) { snapshot, online, s ->
        SyncStatuses.derive(snapshot, signedInUserId(s), online)
    }.stateIn(viewModelScope, SharingStarted.Eagerly, SyncStatuses.derive(services.syncTracker.snapshot.value, signedInUserId(settings.value), true))

    init {
        if (signedInUserId(settings.value) != null) loadUsage()
        viewModelScope.launch { _extras.update { it.copy(pendingChanges = services.accountGuard.pendingLocalChanges()) } }
    }

    private fun signedInUserId(s: AppSettings): String? = if (s.demoMode) null else s.account?.takeUnless { it.isDemo }?.userId

    private fun loadUsage() {
        val client = services.apiClient() ?: return
        viewModelScope.launch {
            try {
                val usage = client.call { usage() }
                _extras.update { it.copy(usage = usage) }
            } catch (e: ApiException) {
                _extras.update { it.copy(error = if (e.httpStatus == 401) "Your session has expired. Sign out and sign in again." else e.error.message) }
            }
        }
    }

    /**
     * Signs out and removes this account's conversations, documents, prompts and sync state from the
     * device, online or offline (see LocalAccountGuard). "Everywhere" first revokes every session of the
     * account on the server; if that fails nothing is signed out, and the reason is shown.
     */
    fun signOut(kind: SignOutKind, onDone: () -> Unit) {
        if (_extras.value.busy) return
        _extras.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            val account = settings.value.account
            val signedIn = account != null && !account.isDemo
            val auth = services.authService()
            if (kind == SignOutKind.EVERYWHERE) {
                try {
                    auth?.signOutEverywhere() ?: throw ApiException(com.dashworldng.ai.core.stream.ApiError("server_not_configured", "The server address is not valid.", false))
                } catch (e: CancellationException) {
                    throw e
                } catch (e: ApiException) {
                    _extras.update { it.copy(busy = false, error = "Couldn't sign out everywhere: ${e.error.message}") }
                    return@launch
                }
                services.accountGuard.signOut(revokeServerSession = {})
            } else {
                services.accountGuard.signOut(revokeServerSession = { if (signedIn) auth?.logout() })
            }
            services.syncTracker.reset()
            services.settings.update { it.copy(account = null, demoMode = true) }
            onDone()
        }
    }

    /** Deletes the server account and all of its data, then clears this device. */
    fun deleteAccount(onDone: () -> Unit) {
        val auth = services.authService() ?: return
        _extras.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            try {
                auth.deleteAccount()
                // The server already ended every session; this removes the account's local data too.
                services.accountGuard.signOut(revokeServerSession = {})
                services.syncTracker.reset()
                services.settings.update { it.copy(account = null, demoMode = true) }
                onDone()
            } catch (e: ApiException) {
                _extras.update { it.copy(busy = false, error = e.error.message) }
            }
        }
    }

    /** Leaves Demo Mode's profile (the demo chats stay on this device, separate from any account). */
    fun leaveDemo(onDone: () -> Unit) {
        viewModelScope.launch {
            services.settings.update { it.copy(account = null, demoMode = true) }
            onDone()
        }
    }
}

@Composable
fun AccountScreen(services: AppServices, onBack: () -> Unit, onSignedOut: () -> Unit, onSyncNow: () -> Unit) {
    val vm = dashViewModel { AccountViewModel(services) }
    val settings by vm.settings.collectAsStateWithLifecycle()
    val extras by vm.extras.collectAsStateWithLifecycle()
    val sync by vm.sync.collectAsStateWithLifecycle()
    var confirm by remember { mutableStateOf<SignOutKind?>(null) }
    var confirmDelete by remember { mutableStateOf(false) }
    val c = DashTheme.colors
    val account = settings.account
    val signedIn = !settings.demoMode && account?.isDemo == false

    Scaffold(containerColor = c.background, topBar = { DashTopBar("Account", onBack = onBack) }) { padding ->
        ContentWidth(Modifier.fillMaxSize().padding(padding)) {
            Column(
                Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = Spacing.gutter)
                    .navigationBarsPadding()
                    .testTag("account_screen"),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = Spacing.md)) {
                    Avatar(Greeting.initials(account?.displayName, account?.email), contentDescription = "Profile", onClick = null)
                    Spacer(Modifier.width(Spacing.md))
                    Column(Modifier.weight(1f)) {
                        Text(
                            if (account?.isDemo == true) "Demo Mode" else account?.displayName ?: "Not signed in",
                            style = MaterialTheme.typography.titleLarge,
                            color = c.ink,
                            modifier = Modifier.semantics { heading() }.testTag("account_name"),
                        )
                        Text(
                            account?.email ?: if (account?.isDemo == true) "No account · nothing leaves this device" else "",
                            style = MaterialTheme.typography.bodyMedium,
                            color = c.inkSecondary,
                        )
                    }
                    if (settings.demoMode) DemoBadge()
                }

                if (!signedIn) {
                    Spacer(Modifier.height(Spacing.xl))
                    Notice(
                        "Demo Mode answers are simulated on this device. Sign in or create an account to get real answers from DASH AI. Demo chats are kept separate from your account.",
                        title = "You're using Demo Mode",
                        modifier = Modifier.testTag("account_demo"),
                    )
                    Spacer(Modifier.height(Spacing.lg))
                    PrimaryButton("Sign in or create an account", onClick = { vm.leaveDemo(onSignedOut) }, modifier = Modifier.fillMaxWidth().testTag("account_sign_in"))
                }

                if (signedIn) {
                    SettingsGroup("Sync") {
                        SettingsRow(
                            sync.title,
                            subtitle = syncSubtitle(sync),
                            icon = Icons.Rounded.CloudSync,
                            trailing = { StatusBadge(sync.title, sync.tone) },
                            modifier = Modifier.testTag("sync_status"),
                        )
                        SettingsDivider()
                        SettingsRow("Sync now", onClick = onSyncNow, modifier = Modifier.testTag("sync_now"))
                    }

                    SettingsGroup("Sessions") {
                        SettingsRow(
                            "This phone",
                            subtitle = "Signed in here. Your chats are cached on this phone for offline use.",
                            icon = Icons.Rounded.PhoneAndroid,
                        )
                        SettingsDivider()
                        SettingsRow(
                            "Other devices",
                            subtitle = "DASH AI doesn't list your other sessions. Use “Sign out everywhere” to end all of them, including this one.",
                            icon = Icons.Rounded.Devices,
                        )
                    }

                    SettingsGroup("Usage") {
                        Column(Modifier.padding(Spacing.lg), verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                            val usage = extras.usage
                            if (usage == null || usage.totals.isEmpty()) {
                                Text("No usage recorded yet.", style = MaterialTheme.typography.bodyMedium, color = c.inkSecondary)
                            } else {
                                Text(
                                    "DASH AI · ${usage.totals.sumOf { it.requests }} answers · ${usage.totals.sumOf { it.inputTokens + it.outputTokens }} tokens",
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = c.ink,
                                    modifier = Modifier.testTag("usage_total"),
                                )
                            }
                        }
                    }
                }

                SettingsGroup("Privacy & Security") {
                    DataProtectionRow()
                }

                extras.error?.let {
                    Spacer(Modifier.height(Spacing.lg))
                    Notice(it, tone = StatusTone.ERROR, modifier = Modifier.testTag("account_error"))
                }

                if (signedIn) {
                    SettingsGroup(null) {
                        SettingsRow(
                            "Sign out",
                            subtitle = "Removes this account's chats and documents from this phone",
                            icon = Icons.AutoMirrored.Rounded.Logout,
                            onClick = { confirm = SignOutKind.THIS_DEVICE },
                            modifier = Modifier.testTag("sign_out"),
                        )
                        SettingsDivider()
                        SettingsRow(
                            "Sign out everywhere",
                            subtitle = "Ends every session of this account, on every device",
                            icon = Icons.AutoMirrored.Rounded.Logout,
                            onClick = { confirm = SignOutKind.EVERYWHERE },
                            modifier = Modifier.testTag("sign_out_everywhere"),
                        )
                        SettingsDivider()
                        SettingsRow(
                            "Delete account",
                            subtitle = "Permanently deletes your account and its data on the server",
                            icon = Icons.Rounded.DeleteForever,
                            destructive = true,
                            onClick = { confirmDelete = true },
                            modifier = Modifier.testTag("delete_account"),
                        )
                    }
                } else if (account?.isDemo == true) {
                    SettingsGroup(null) {
                        SettingsRow(
                            "About Demo Mode",
                            subtitle = "Demo chats stay on this device and are never sent anywhere.",
                            icon = Icons.Rounded.Science,
                        )
                    }
                }
                Spacer(Modifier.height(Spacing.xxl))
            }
        }
    }

    confirm?.let { kind ->
        val pending = extras.pendingChanges
        val warning = if (pending > 0) " $pending change${if (pending == 1) "" else "s"} not yet synced will be lost." else ""
        ConfirmDialog(
            title = if (kind == SignOutKind.EVERYWHERE) "Sign out everywhere?" else "Sign out?",
            text = when (kind) {
                SignOutKind.THIS_DEVICE -> "This account's chats, documents and prompts will be removed from this phone. They stay in your account.$warning"
                SignOutKind.EVERYWHERE -> "Every session of this account ends, on every device, and this phone's copy is removed. You'll need to sign in again everywhere.$warning"
            },
            confirmLabel = if (kind == SignOutKind.EVERYWHERE) "Sign out everywhere" else "Sign out",
            destructive = kind == SignOutKind.EVERYWHERE,
            onConfirm = {
                confirm = null
                vm.signOut(kind, onSignedOut)
            },
            onDismiss = { confirm = null },
            modifier = Modifier.testTag("confirm_sign_out"),
        )
    }
    if (confirmDelete) {
        ConfirmDialog(
            title = "Delete your account?",
            text = "This permanently deletes your DASH AI account and its data on the server, and clears this device. This can't be undone.",
            confirmLabel = "Delete account",
            destructive = true,
            onConfirm = {
                confirmDelete = false
                vm.deleteAccount(onSignedOut)
            },
            onDismiss = { confirmDelete = false },
        )
    }
}
