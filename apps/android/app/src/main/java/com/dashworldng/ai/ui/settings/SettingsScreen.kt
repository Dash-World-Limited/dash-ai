package com.dashworldng.ai.ui.settings

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.rounded.Logout
import androidx.compose.material.icons.rounded.CloudSync
import androidx.compose.material.icons.rounded.DeleteOutline
import androidx.compose.material.icons.rounded.Dns
import androidx.compose.material.icons.rounded.Extension
import androidx.compose.material.icons.rounded.FileDownload
import androidx.compose.material.icons.rounded.Shield
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.dashworldng.ai.BuildConfig
import com.dashworldng.ai.core.data.DataExport
import com.dashworldng.ai.core.demo.DemoFailure
import com.dashworldng.ai.core.model.AssistantMode
import com.dashworldng.ai.core.model.ModelChoice
import com.dashworldng.ai.core.presentation.SyncStatus
import com.dashworldng.ai.core.presentation.SyncStatuses
import com.dashworldng.ai.core.remote.DashApiClient
import com.dashworldng.ai.core.remote.ProvidersResponseDto
import com.dashworldng.ai.core.stream.ApiException
import com.dashworldng.ai.data.settings.AppSettings
import com.dashworldng.ai.data.settings.ThemePreference
import com.dashworldng.ai.di.AppServices
import com.dashworldng.ai.ui.chat.SelectionDot
import com.dashworldng.ai.ui.components.BrandWordmark
import com.dashworldng.ai.ui.components.ConfirmDialog
import com.dashworldng.ai.ui.components.ContentWidth
import com.dashworldng.ai.ui.components.DashTextField
import com.dashworldng.ai.ui.components.DashTopBar
import com.dashworldng.ai.ui.components.SettingsDivider
import com.dashworldng.ai.ui.components.SettingsGroup
import com.dashworldng.ai.ui.components.SettingsRow
import com.dashworldng.ai.ui.components.StatusBadge
import com.dashworldng.ai.ui.components.TextAction
import com.dashworldng.ai.ui.dashViewModel
import com.dashworldng.ai.ui.theme.DashTheme
import com.dashworldng.ai.ui.theme.Spacing
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.text.DateFormat
import java.util.Date

data class SettingsExtras(
    val providers: ProvidersResponseDto? = null,
    val connection: String? = null,
    val checking: Boolean = false,
    val notice: String? = null,
)

class SettingsViewModel(private val services: AppServices) : ViewModel() {
    val settings: StateFlow<AppSettings> = services.settings.settings
    private val _extras = MutableStateFlow(SettingsExtras())
    val extras: StateFlow<SettingsExtras> = _extras.asStateFlow()

    /** Synced / Syncing / Offline / Sync issue for the signed-in account (local only in Demo Mode). */
    val sync: StateFlow<SyncStatus> = combine(services.syncTracker.snapshot, services.connectivity.isOnline, settings) { snapshot, online, s ->
        SyncStatuses.derive(snapshot, signedInUserId(s), online)
    }.stateIn(viewModelScope, SharingStarted.Eagerly, SyncStatuses.derive(services.syncTracker.snapshot.value, signedInUserId(settings.value), true))

    init {
        if (!settings.value.demoMode) testConnection()
    }

    private fun update(transform: (AppSettings) -> AppSettings) {
        viewModelScope.launch { services.settings.update(transform) }
    }

    fun setTheme(value: ThemePreference) = update { it.copy(theme = value) }
    fun setDemoFailure(value: DemoFailure) = update { it.copy(demoFailure = value) }
    fun setDefaultChoice(value: ModelChoice) = update { it.copy(defaultModelChoice = value) }
    fun setDefaultMode(value: AssistantMode) = update { it.copy(defaultMode = value) }

    /** Turning Demo Mode on is always allowed; turning it off needs a signed-in live account. */
    fun setDemoMode(on: Boolean, onNeedsSignIn: () -> Unit) {
        val account = settings.value.account
        if (!on && (account == null || account.isDemo || services.tokens.get() == null)) {
            onNeedsSignIn()
            return
        }
        update { it.copy(demoMode = on) }
    }

    fun setServer(url: String) {
        val normalized = DashApiClient.normalizeBaseUrl(url)?.toString()
        if (normalized == null) {
            _extras.update { it.copy(notice = "That doesn't look like a valid server address.") }
            return
        }
        update { it.copy(serverUrl = normalized) }
        _extras.update { it.copy(providers = null, connection = null) }
    }

    fun testConnection() {
        val client = services.apiClient()
        if (client == null) {
            _extras.update { it.copy(connection = "The server address is not valid.") }
            return
        }
        _extras.update { it.copy(checking = true, connection = null) }
        viewModelScope.launch {
            try {
                val health = client.call { health() }
                val providers = client.call { providers() }
                _extras.update { it.copy(checking = false, connection = "Connected · DASH AI API ${health.version}", providers = providers) }
            } catch (e: ApiException) {
                _extras.update { it.copy(checking = false, connection = e.error.message, providers = null) }
            }
        }
    }

    fun export(uri: Uri, write: (Uri, String) -> Unit) {
        viewModelScope.launch {
            try {
                val conversations = services.conversations.allConversations().map { it to services.conversations.getMessages(it.id) }
                val file = DataExport.build(
                    conversations = conversations,
                    customPrompts = services.prompts.observeCustomPrompts().first(),
                    favorites = services.prompts.observeFavoriteIds().first(),
                    documents = services.documents.observeDocuments().first(),
                    now = services.clock.now(),
                )
                val json = DataExport.toJson(file)
                withContext(Dispatchers.IO) { write(uri, json) }
                _extras.update { it.copy(notice = "Exported ${conversations.size} conversations") }
            } catch (e: Exception) {
                _extras.update { it.copy(notice = "Export failed. Please try again.") }
            }
        }
    }

    fun deleteLocalData() {
        viewModelScope.launch {
            services.conversations.deleteAll()
            services.prompts.deleteAll()
            services.documents.deleteAll()
            _extras.update { it.copy(notice = "All conversations, prompts and documents were deleted from this device") }
        }
    }

    fun clearNotice() = _extras.update { it.copy(notice = null) }

    private fun signedInUserId(s: AppSettings): String? = if (s.demoMode) null else s.account?.takeUnless { it.isDemo }?.userId
}

@Composable
fun SettingsScreen(
    services: AppServices,
    onBack: () -> Unit,
    onSignIn: () -> Unit,
    onOpenTools: () -> Unit,
    onOpenAccount: () -> Unit,
    onSyncNow: () -> Unit,
) {
    val vm = dashViewModel { SettingsViewModel(services) }
    val settings by vm.settings.collectAsStateWithLifecycle()
    val extras by vm.extras.collectAsStateWithLifecycle()
    val sync by vm.sync.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val snackbar = remember { SnackbarHostState() }
    var editingServer by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }
    val signedIn = !settings.demoMode && settings.account?.isDemo == false

    val exporter = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { uri ->
        if (uri != null) {
            vm.export(uri) { target, json ->
                context.contentResolver.openOutputStream(target)?.use { it.write(json.toByteArray(Charsets.UTF_8)) }
            }
        }
    }

    LaunchedEffect(extras.notice) {
        extras.notice?.let {
            snackbar.showSnackbar(it)
            vm.clearNotice()
        }
    }

    val c = DashTheme.colors
    Scaffold(
        containerColor = c.background,
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = { DashTopBar("Settings", onBack = onBack) },
    ) { padding ->
        ContentWidth(Modifier.fillMaxSize().padding(padding)) {
            Column(
                Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = Spacing.gutter)
                    .navigationBarsPadding()
                    .testTag("settings_screen"),
            ) {
                SettingsGroup("Appearance") {
                    ThemePreference.entries.forEachIndexed { i, theme ->
                        if (i > 0) SettingsDivider()
                        RadioRow(theme.label, selected = settings.theme == theme, tag = "theme_${theme.wire}") { vm.setTheme(theme) }
                    }
                }

                SettingsGroup("Chat defaults") {
                    Text(
                        "Provider for new chats",
                        style = MaterialTheme.typography.labelMedium,
                        color = c.inkTertiary,
                        modifier = Modifier.padding(start = Spacing.lg, top = Spacing.md),
                    )
                    ModelChoice.entries.filter { it != ModelChoice.COMPARE }.forEach { choice ->
                        RadioRow(choice.label, selected = settings.defaultModelChoice == choice, tag = "default_${choice.wire}") { vm.setDefaultChoice(choice) }
                    }
                    SettingsDivider()
                    Text(
                        "Mode for new chats",
                        style = MaterialTheme.typography.labelMedium,
                        color = c.inkTertiary,
                        modifier = Modifier.padding(start = Spacing.lg, top = Spacing.md),
                    )
                    AssistantMode.entries.forEach { mode ->
                        RadioRow(mode.label, selected = settings.defaultMode == mode, tag = "default_mode_${mode.wire}") { vm.setDefaultMode(mode) }
                    }
                }

                SettingsGroup("Privacy & Security") {
                    DataProtectionRow()
                    if (signedIn) {
                        SettingsDivider()
                        SettingsRow(
                            "Sign out and sessions",
                            subtitle = "Sign out on this phone or everywhere",
                            icon = Icons.AutoMirrored.Rounded.Logout,
                            onClick = onOpenAccount,
                            trailing = { Chevron() },
                        )
                    }
                }

                SettingsGroup("Connected tools") {
                    SettingsRow(
                        "Tools & Connections",
                        subtitle = "Choose which tools DASH AI may use",
                        icon = Icons.Rounded.Extension,
                        onClick = onOpenTools,
                        trailing = { Chevron() },
                        modifier = Modifier.testTag("settings_tools"),
                    )
                }

                SettingsGroup("Data & Sync") {
                    SettingsRow(
                        "Sync",
                        subtitle = syncSubtitle(sync),
                        icon = Icons.Rounded.CloudSync,
                        trailing = { StatusBadge(sync.title, sync.tone) },
                        modifier = Modifier.testTag("sync_status"),
                    )
                    if (signedIn) {
                        SettingsDivider()
                        SettingsRow("Sync now", onClick = onSyncNow, modifier = Modifier.testTag("sync_now"))
                    }
                    SettingsDivider()
                    SettingsRow(
                        "Export data",
                        subtitle = "Chats, prompts and document details on this device, as a JSON file",
                        icon = Icons.Rounded.FileDownload,
                        onClick = { exporter.launch("dash-ai-export.json") },
                        modifier = Modifier.testTag("export_data"),
                    )
                    SettingsDivider()
                    SettingsRow(
                        "Delete data on this device",
                        subtitle = if (signedIn) "Your account keeps its synced chats" else "Removes Demo Mode chats, prompts and documents",
                        icon = Icons.Rounded.DeleteOutline,
                        destructive = true,
                        onClick = { confirmDelete = true },
                        modifier = Modifier.testTag("delete_local_data"),
                    )
                }

                SettingsGroup("Demo Mode") {
                    SettingsRow(
                        "Demo Mode",
                        subtitle = if (settings.demoMode) {
                            "On. Answers are simulated on this device; no AI provider is used."
                        } else {
                            "Off. Answers come from the providers on your DASH AI server."
                        },
                        trailing = {
                            Switch(
                                checked = settings.demoMode,
                                onCheckedChange = { vm.setDemoMode(it, onSignIn) },
                                colors = SwitchDefaults.colors(checkedTrackColor = c.accent, checkedThumbColor = c.surface, uncheckedTrackColor = c.surfaceMuted, uncheckedBorderColor = c.outlineStrong, uncheckedThumbColor = c.inkTertiary),
                                modifier = Modifier.semantics { contentDescription = "Demo Mode" }.testTag("demo_switch"),
                            )
                        },
                    )
                    if (settings.demoMode) {
                        SettingsDivider()
                        Text(
                            "Simulate errors (to see how failures look)",
                            style = MaterialTheme.typography.labelMedium,
                            color = c.inkTertiary,
                            modifier = Modifier.padding(start = Spacing.lg, top = Spacing.md),
                        )
                        DemoFailure.entries.forEach { failure ->
                            RadioRow(failure.label, selected = settings.demoFailure == failure, tag = "demo_failure_${failure.name.lowercase()}") { vm.setDemoFailure(failure) }
                        }
                    }
                }

                SettingsGroup("Server") {
                    SettingsRow(
                        settings.serverUrl.ifBlank { "Not set" },
                        subtitle = extras.connection ?: if (extras.checking) "Checking…" else "DASH AI server address",
                        icon = Icons.Rounded.Dns,
                        onClick = { editingServer = true },
                        trailing = { TextAction("Test", vm::testConnection, enabled = !extras.checking) },
                        modifier = Modifier.testTag("server_url"),
                    )
                    extras.providers?.let { providers ->
                        providers.providers.forEach { p ->
                            SettingsDivider()
                            SettingsRow(
                                p.displayName,
                                subtitle = when {
                                    !p.configured -> "Not configured on this server"
                                    p.mode == "fake" -> "Test adapter (simulated answers)"
                                    else -> "Configured${p.model?.let { m -> " · $m" } ?: ""}"
                                },
                            )
                        }
                    }
                }

                SettingsGroup("About") {
                    Column(Modifier.padding(Spacing.lg), verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                        BrandWordmark()
                        Text("Beyond the Digital.", style = MaterialTheme.typography.bodyMedium, color = c.inkSecondary)
                        Text("A Dash World product · Version ${BuildConfig.VERSION_NAME}", style = MaterialTheme.typography.bodySmall, color = c.inkTertiary)
                    }
                }
                Spacer(Modifier.height(Spacing.xxl))
            }
        }
    }

    if (editingServer) {
        ServerDialog(initial = settings.serverUrl, onDismiss = { editingServer = false }, onSave = {
            vm.setServer(it)
            editingServer = false
        })
    }
    if (confirmDelete) {
        ConfirmDialog(
            title = "Delete data on this device?",
            text = "Chats, custom prompts and documents stored on this phone are removed. " +
                if (signedIn) "Chats already synced to your account come back at the next sync." else "This can't be undone.",
            confirmLabel = "Delete",
            destructive = true,
            onConfirm = {
                confirmDelete = false
                vm.deleteLocalData()
            },
            onDismiss = { confirmDelete = false },
        )
    }
}

fun syncSubtitle(status: SyncStatus): String {
    val last = status.lastSyncAt?.let { "Last synced ${DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(it))}. " }.orEmpty()
    return last + status.detail
}

@Composable
private fun Chevron() {
    Icon(Icons.AutoMirrored.Rounded.KeyboardArrowRight, contentDescription = null, tint = DashTheme.colors.inkTertiary)
}

@Composable
private fun RadioRow(label: String, selected: Boolean, tag: String, onClick: () -> Unit) {
    val c = DashTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 52.dp)
            .clickable(role = Role.RadioButton, onClick = onClick)
            .semantics { stateDescription = if (selected) "Selected" else "Not selected" }
            .padding(horizontal = Spacing.lg)
            .testTag(tag),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = MaterialTheme.typography.bodyLarge, color = c.ink, modifier = Modifier.weight(1f))
        SelectionDot(selected)
    }
}

/** An accurate account of how data is protected. Deliberately does not claim end-to-end encryption. */
@Composable
fun DataProtectionRow() {
    val c = DashTheme.colors
    var open by rememberSaveable { mutableStateOf(false) }
    SettingsRow(
        "How your data is protected",
        subtitle = "Encryption in transit and at rest, and what that means",
        icon = Icons.Rounded.Shield,
        onClick = { open = !open },
        modifier = Modifier.testTag("data_protection"),
    )
    AnimatedVisibility(open) {
        Column(Modifier.padding(start = Spacing.lg, end = Spacing.lg, bottom = Spacing.lg), verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
            listOf(
                "In transit: release builds only talk to the server over HTTPS.",
                "On the server: chats, documents and tool activity are encrypted at rest (AES-256-GCM). The server decrypts them to answer you and sends your messages to the AI provider you choose, so this is not end-to-end encryption.",
                "On this phone: your session token is encrypted with a key kept in the Android Keystore. Chats are cached in the app's private storage, protected by Android's app sandbox and your device encryption, and are excluded from backups.",
                "Signing out removes this account's chats, documents and prompts from this phone.",
            ).forEach { Text(it, style = MaterialTheme.typography.bodySmall, color = c.inkSecondary) }
        }
    }
}

@Composable
fun ServerDialog(initial: String, onDismiss: () -> Unit, onSave: (String) -> Unit) {
    val c = DashTheme.colors
    var text by rememberSaveable { mutableStateOf(initial) }
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = c.surface,
        titleContentColor = c.ink,
        title = { Text("DASH AI server") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                Text(
                    "Emulator: http://10.0.2.2:8787 · Phone on the same Wi-Fi: http://<your computer's IP>:8787 (debug builds only). Production servers must use https://.",
                    style = MaterialTheme.typography.bodySmall,
                    color = c.inkSecondary,
                )
                DashTextField(value = text, onValueChange = { text = it.trim() }, label = "Server address", modifier = Modifier.testTag("server_input"))
            }
        },
        confirmButton = { TextAction("Save", { onSave(text) }, enabled = DashApiClient.normalizeBaseUrl(text) != null) },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel", color = c.inkSecondary) } },
    )
}
