package com.dashworldng.ai.ui.settings

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.ArrowDropDown
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.RadioButtonDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
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
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.dashworldng.ai.BuildConfig
import com.dashworldng.ai.core.data.DataExport
import com.dashworldng.ai.core.demo.DemoFailure
import com.dashworldng.ai.core.model.AssistantMode
import com.dashworldng.ai.core.model.ModelChoice
import com.dashworldng.ai.core.remote.DashApiClient
import com.dashworldng.ai.core.remote.ProvidersResponseDto
import com.dashworldng.ai.core.stream.ApiException
import com.dashworldng.ai.data.settings.AppSettings
import com.dashworldng.ai.di.AppServices
import com.dashworldng.ai.ui.components.SectionTitle
import com.dashworldng.ai.ui.dashViewModel
import com.dashworldng.ai.ui.theme.DashColors
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

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

    init {
        if (!settings.value.demoMode) testConnection()
    }

    private fun update(transform: (AppSettings) -> AppSettings) {
        viewModelScope.launch { services.settings.update(transform) }
    }

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
                _extras.update { it.copy(checking = false, connection = "Connected · Dash AI API ${health.version}", providers = providers) }
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
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(services: AppServices, onBack: () -> Unit, onSignIn: () -> Unit) {
    val vm = dashViewModel { SettingsViewModel(services) }
    val settings by vm.settings.collectAsStateWithLifecycle()
    val extras by vm.extras.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val snackbar = remember { SnackbarHostState() }
    var editingServer by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }

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

    Scaffold(
        containerColor = DashColors.Black,
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            TopAppBar(
                title = { Text("Settings") },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = "Back") } },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = DashColors.Black),
            )
        },
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp, vertical = 8.dp)
                .testTag("settings_screen"),
        ) {
            SectionTitle("Mode")
            SettingCard {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Demo Mode", style = MaterialTheme.typography.titleSmall, color = DashColors.White)
                        Text(
                            if (settings.demoMode) {
                                "On · answers are simulated on this device and never sent anywhere."
                            } else {
                                "Off · prompts go to the Dash AI server and the provider you choose."
                            },
                            style = MaterialTheme.typography.bodySmall,
                            color = DashColors.Grey,
                        )
                    }
                    Switch(
                        checked = settings.demoMode,
                        onCheckedChange = { vm.setDemoMode(it, onSignIn) },
                        modifier = Modifier.testTag("demo_switch"),
                        colors = SwitchDefaults.colors(checkedTrackColor = DashColors.Gold, checkedThumbColor = DashColors.Black),
                    )
                }
                if (settings.demoMode) {
                    Text("Simulate errors (for testing)", style = MaterialTheme.typography.labelMedium, color = DashColors.GoldLight, modifier = Modifier.padding(top = 12.dp))
                    DemoFailure.entries.forEach { failure ->
                        Row(
                            Modifier.fillMaxWidth().clickable { vm.setDemoFailure(failure) },
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            RadioButton(
                                selected = settings.demoFailure == failure,
                                onClick = { vm.setDemoFailure(failure) },
                                colors = RadioButtonDefaults.colors(selectedColor = DashColors.Gold),
                            )
                            Text(failure.label, style = MaterialTheme.typography.bodyMedium, color = DashColors.White)
                        }
                    }
                }
            }

            SectionTitle("Server")
            SettingCard {
                Text("Dash AI server", style = MaterialTheme.typography.titleSmall, color = DashColors.White)
                Text(settings.serverUrl.ifBlank { "Not set" }, style = MaterialTheme.typography.bodySmall, color = DashColors.Grey, modifier = Modifier.testTag("server_url"))
                Row {
                    TextButton(onClick = { editingServer = true }) { Text("Change", color = DashColors.Gold) }
                    TextButton(onClick = vm::testConnection, enabled = !extras.checking) { Text(if (extras.checking) "Checking…" else "Test connection", color = DashColors.Gold) }
                }
                extras.connection?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = DashColors.Grey) }
                Text(
                    "The app only ever talks to this server. OpenAI and Anthropic keys stay on the server and never reach your phone.",
                    style = MaterialTheme.typography.bodySmall,
                    color = DashColors.GreyDim,
                    modifier = Modifier.padding(top = 6.dp),
                )
            }

            SectionTitle("Providers")
            SettingCard {
                val providers = extras.providers
                if (settings.demoMode) {
                    Text("Demo Mode is on: no provider is used.", style = MaterialTheme.typography.bodyMedium, color = DashColors.Grey)
                } else if (providers == null) {
                    Text("Test the connection to see which providers the server has configured.", style = MaterialTheme.typography.bodyMedium, color = DashColors.Grey)
                } else {
                    providers.providers.forEach { p ->
                        Row(Modifier.padding(vertical = 4.dp)) {
                            Text(p.displayName, style = MaterialTheme.typography.titleSmall, color = DashColors.White, modifier = Modifier.width(88.dp))
                            Text(
                                when (p.mode) {
                                    "live" -> "Configured · ${p.model}"
                                    "fake" -> "Test adapter (demonstration answers)"
                                    else -> "Not configured"
                                },
                                style = MaterialTheme.typography.bodySmall,
                                color = if (p.configured) DashColors.Grey else DashColors.GoldLight,
                            )
                        }
                    }
                    Text(providers.research.note, style = MaterialTheme.typography.bodySmall, color = DashColors.GreyDim, modifier = Modifier.padding(top = 6.dp))
                }
            }

            SectionTitle("Defaults")
            SettingCard {
                ChoiceRow("Default model", settings.defaultModelChoice.label, ModelChoice.entries.map { it.label }) { vm.setDefaultChoice(ModelChoice.entries[it]) }
                ChoiceRow("Default mode", settings.defaultMode.label, AssistantMode.entries.map { it.label }) { vm.setDefaultMode(AssistantMode.entries[it]) }
            }

            SectionTitle("Privacy and data")
            SettingCard {
                Text(
                    "Each answer shows which provider produced it. Prompts go only to the provider you choose (both for Compare), and one provider's answers are never sent to the other. Conversations are stored on this device and excluded from cloud backups.",
                    style = MaterialTheme.typography.bodySmall,
                    color = DashColors.Grey,
                )
                Row {
                    TextButton(onClick = { exporter.launch("dash-ai-export.json") }, modifier = Modifier.testTag("export_data")) {
                        Text("Export my data", color = DashColors.Gold)
                    }
                    TextButton(onClick = { confirmDelete = true }, modifier = Modifier.testTag("delete_local_data")) {
                        Text("Delete local data", color = DashColors.Error)
                    }
                }
            }

            SectionTitle("About")
            SettingCard {
                Text("Dash AI ${BuildConfig.VERSION_NAME}", style = MaterialTheme.typography.titleSmall, color = DashColors.White)
                Text("Think. Create. Execute.", style = MaterialTheme.typography.bodySmall, color = DashColors.Grey)
                Text(
                    "The Dash AI mark in this build is a temporary typographic placeholder. The official Dash World logo is still required.",
                    style = MaterialTheme.typography.bodySmall,
                    color = DashColors.GreyDim,
                    modifier = Modifier.padding(top = 6.dp),
                )
            }
            Spacer(Modifier.padding(24.dp))
        }
    }

    if (editingServer) {
        ServerDialog(
            initial = settings.serverUrl,
            onDismiss = { editingServer = false },
            onSave = {
                vm.setServer(it)
                editingServer = false
            },
        )
    }
    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("Delete all local data?") },
            text = { Text("All conversations, custom prompts, favourites and documents on this device will be deleted. Your account on the server is not affected. This can't be undone.") },
            confirmButton = {
                TextButton(onClick = {
                    vm.deleteLocalData()
                    confirmDelete = false
                }) { Text("Delete", color = DashColors.Error) }
            },
            dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("Cancel") } },
            containerColor = DashColors.SurfaceHigh,
        )
    }
}

@Composable
fun SettingCard(content: @Composable () -> Unit) {
    Surface(
        shape = RoundedCornerShape(16.dp),
        color = DashColors.Surface,
        border = BorderStroke(1.dp, DashColors.OutlineSoft),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) { content() }
    }
}

@Composable
private fun ChoiceRow(label: String, value: String, options: List<String>, onSelect: (Int) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = DashColors.White, modifier = Modifier.weight(1f))
        Box {
            TextButton(onClick = { open = true }) {
                Text(value, color = DashColors.Gold)
                Icon(Icons.Rounded.ArrowDropDown, contentDescription = null, tint = DashColors.Gold)
            }
            DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                options.forEachIndexed { index, option ->
                    DropdownMenuItem(text = { Text(option) }, onClick = {
                        open = false
                        onSelect(index)
                    })
                }
            }
        }
    }
}

@Composable
fun ServerDialog(initial: String, onDismiss: () -> Unit, onSave: (String) -> Unit) {
    var text by rememberSaveable { mutableStateOf(initial) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Dash AI server") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    "Emulator: http://10.0.2.2:8787 · Phone on the same Wi-Fi: http://<your computer's IP>:8787 (debug builds only). Production servers must use https://.",
                    style = MaterialTheme.typography.bodySmall,
                    color = DashColors.Grey,
                )
                OutlinedTextField(value = text, onValueChange = { text = it.trim() }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("server_input"))
            }
        },
        confirmButton = {
            TextButton(onClick = { onSave(text) }, enabled = DashApiClient.normalizeBaseUrl(text) != null) { Text("Save", color = DashColors.Gold) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
        containerColor = DashColors.SurfaceHigh,
    )
}
