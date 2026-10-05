package com.dashworldng.ai.ui.tools

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Extension
import androidx.compose.material.icons.rounded.Lock
import androidx.compose.material.icons.rounded.Visibility
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
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
import com.dashworldng.ai.core.presentation.ConnectionState
import com.dashworldng.ai.core.presentation.StatusTone
import com.dashworldng.ai.core.presentation.ToolConnection
import com.dashworldng.ai.core.presentation.ToolConnections
import com.dashworldng.ai.core.stream.ApiException
import com.dashworldng.ai.di.AppServices
import com.dashworldng.ai.ui.components.ContentWidth
import com.dashworldng.ai.ui.components.DashTopBar
import com.dashworldng.ai.ui.components.EmptyState
import com.dashworldng.ai.ui.components.ErrorState
import com.dashworldng.ai.ui.components.LoadingState
import com.dashworldng.ai.ui.components.Notice
import com.dashworldng.ai.ui.components.PrimaryButton
import com.dashworldng.ai.ui.components.QuietCard
import com.dashworldng.ai.ui.components.StatusBadge
import com.dashworldng.ai.ui.dashViewModel
import com.dashworldng.ai.ui.theme.DashTheme
import com.dashworldng.ai.ui.theme.Spacing
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class ToolsUiState(
    /** Tools run on the server: Demo Mode and signed-out users have none. */
    val signedIn: Boolean = false,
    val loading: Boolean = false,
    val error: String? = null,
    val toolsEnabled: Boolean = true,
    val connections: List<ToolConnection> = emptyList(),
    val busyId: String? = null,
    val actionError: String? = null,
)

/** The server's real plugin registry (GET /v1/plugins). Nothing here is invented on the device. */
class ToolsViewModel(private val services: AppServices) : ViewModel() {
    private val _state = MutableStateFlow(ToolsUiState())
    val state: StateFlow<ToolsUiState> = _state.asStateFlow()

    init {
        val s = services.settings.settings.value
        val signedIn = !s.demoMode && s.account?.isDemo == false
        _state.value = ToolsUiState(signedIn = signedIn)
        if (signedIn) load()
    }

    fun load() {
        val tools = services.toolsService() ?: return _state.update { it.copy(error = "The server address is not valid. Check it in Settings.") }
        _state.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            try {
                val response = tools.plugins()
                _state.update { it.copy(loading = false, toolsEnabled = response.toolsEnabled, connections = ToolConnections.from(response)) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException) {
                _state.update { it.copy(loading = false, error = e.error.message) }
            }
        }
    }

    /** Turns a plugin on (granting the read access its tools need) or off. Always the user's explicit choice. */
    fun setEnabled(connection: ToolConnection, enabled: Boolean) {
        val tools = services.toolsService() ?: return
        if (_state.value.busyId != null) return
        _state.update { it.copy(busyId = connection.id, actionError = null) }
        viewModelScope.launch {
            try {
                val scopes = if (enabled && connection.state == ConnectionState.REQUIRES_PERMISSION) connection.scopesToGrant else null
                val updated = tools.setEnabled(connection.id, enabled, scopes)
                val row = ToolConnections.from(updated, _state.value.toolsEnabled)
                _state.update { s -> s.copy(busyId = null, connections = s.connections.map { if (it.id == row.id) row else it }) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException) {
                _state.update { it.copy(busyId = null, actionError = e.error.message) }
            }
        }
    }
}

@Composable
fun ToolsScreen(services: AppServices, onBack: () -> Unit, onSignIn: () -> Unit) {
    val vm = dashViewModel { ToolsViewModel(services) }
    val state by vm.state.collectAsStateWithLifecycle()
    ToolsContent(state, onBack = onBack, onRetry = vm::load, onToggle = vm::setEnabled, onSignIn = onSignIn)
}

@Composable
fun ToolsContent(
    state: ToolsUiState,
    onBack: () -> Unit,
    onRetry: () -> Unit,
    onToggle: (ToolConnection, Boolean) -> Unit,
    onSignIn: () -> Unit,
) {
    val c = DashTheme.colors
    Scaffold(containerColor = c.background, topBar = { DashTopBar("Tools & Connections", onBack = onBack) }) { padding ->
        ContentWidth(Modifier.fillMaxSize().padding(padding)) {
            LazyColumn(
                Modifier.fillMaxSize().testTag("tools_screen"),
                contentPadding = PaddingValues(start = Spacing.gutter, end = Spacing.gutter, bottom = Spacing.xxl),
                verticalArrangement = Arrangement.spacedBy(Spacing.md),
            ) {
                item {
                    Text(
                        "Connect tools to give DASH AI access to the information and actions you choose.",
                        style = MaterialTheme.typography.bodyLarge,
                        color = c.inkSecondary,
                    )
                }
                when {
                    !state.signedIn -> item {
                        EmptyState(
                            icon = Icons.Rounded.Extension,
                            title = "Sign in to use tools",
                            message = "Tools run on your DASH AI server for your account. Demo Mode doesn't use any tools.",
                            action = { PrimaryButton("Sign in", onSignIn) },
                            modifier = Modifier.testTag("tools_signed_out"),
                        )
                    }
                    state.loading -> item { LoadingState("Loading tools…") }
                    state.error != null -> item { ErrorState("Couldn't load tools", state.error, onRetry = onRetry) }
                    else -> {
                        if (!state.toolsEnabled) {
                            item { Notice("Tools are turned off on this server. Your choices are kept for when they're turned on.", tone = StatusTone.WARNING) }
                        }
                        state.actionError?.let { item { Notice(it, tone = StatusTone.ERROR) } }
                        if (state.connections.isEmpty()) {
                            item {
                                EmptyState(
                                    icon = Icons.Rounded.Extension,
                                    title = "No tools available",
                                    message = "This server doesn't offer any tools yet.",
                                    modifier = Modifier.testTag("tools_empty"),
                                )
                            }
                        }
                        items(state.connections, key = { it.id }) { connection ->
                            ConnectionCard(connection, busy = state.busyId == connection.id, onToggle = { onToggle(connection, it) })
                        }
                        item {
                            Text(
                                "Only names and outcomes of tool use are shown in chats. Tool inputs and results stay on the server.",
                                style = MaterialTheme.typography.bodySmall,
                                color = c.inkTertiary,
                                modifier = Modifier.padding(top = Spacing.sm),
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ConnectionCard(connection: ToolConnection, busy: Boolean, onToggle: (Boolean) -> Unit) {
    val c = DashTheme.colors
    QuietCard(Modifier.fillMaxWidth().testTag("tool_connection")) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(connection.name, style = MaterialTheme.typography.titleMedium, color = c.ink, modifier = Modifier.semantics { heading() })
                Spacer(Modifier.height(Spacing.xs))
                Row(horizontalArrangement = Arrangement.spacedBy(Spacing.sm), verticalAlignment = Alignment.CenterVertically) {
                    StatusBadge(connection.state.label, connection.state.tone, Modifier.testTag("tool_state"))
                    if (connection.builtIn) Text("Built in", style = MaterialTheme.typography.labelMedium, color = c.inkTertiary)
                }
            }
            Switch(
                checked = connection.enabled && connection.state != ConnectionState.REQUIRES_PERMISSION,
                onCheckedChange = onToggle,
                enabled = connection.canToggle && !busy,
                colors = SwitchDefaults.colors(
                    checkedThumbColor = c.surface,
                    checkedTrackColor = c.accent,
                    uncheckedThumbColor = c.inkTertiary,
                    uncheckedTrackColor = c.surfaceMuted,
                    uncheckedBorderColor = c.outlineStrong,
                ),
                modifier = Modifier
                    .semantics { contentDescription = "${connection.name}: ${connection.state.label}" }
                    .testTag("tool_switch_${connection.id}"),
            )
        }
        Spacer(Modifier.height(Spacing.md))
        Text(connection.description, style = MaterialTheme.typography.bodyMedium, color = c.inkSecondary)
        Spacer(Modifier.height(Spacing.xs))
        Text(connection.detail, style = MaterialTheme.typography.bodySmall, color = c.inkTertiary)
        if (connection.state == ConnectionState.REQUIRES_PERMISSION) {
            Spacer(Modifier.height(Spacing.md))
            PrimaryButton("Allow access", onClick = { onToggle(true) }, enabled = !busy, modifier = Modifier.testTag("tool_allow"))
        }
        if (connection.tools.isNotEmpty()) {
            Spacer(Modifier.height(Spacing.lg))
            Text("Tools", style = MaterialTheme.typography.labelMedium, color = c.inkTertiary)
            connection.tools.forEach { tool ->
                Row(Modifier.padding(top = Spacing.sm), verticalAlignment = Alignment.Top) {
                    Column(Modifier.weight(1f)) {
                        Text(tool.label, style = MaterialTheme.typography.bodyMedium, color = c.ink)
                        Text(tool.description, style = MaterialTheme.typography.bodySmall, color = c.inkSecondary)
                    }
                    if (!tool.runnable) Text("Not available yet", style = MaterialTheme.typography.labelSmall, color = c.inkTertiary)
                }
            }
        }
        if (connection.permissions.isNotEmpty()) {
            Spacer(Modifier.height(Spacing.lg))
            Text("Access", style = MaterialTheme.typography.labelMedium, color = c.inkTertiary)
            connection.permissions.forEach { p ->
                Row(Modifier.padding(top = Spacing.sm), verticalAlignment = Alignment.CenterVertically) {
                    Icon(if (p.write) Icons.Rounded.Lock else Icons.Rounded.Visibility, contentDescription = null, tint = c.inkTertiary, modifier = Modifier.size(16.dp))
                    Spacer(Modifier.width(Spacing.sm))
                    Text(
                        "${p.description}${if (p.write) " (changes data)" else " (read only)"}${if (p.granted) " · allowed" else ""}",
                        style = MaterialTheme.typography.bodySmall,
                        color = c.inkSecondary,
                    )
                }
            }
        }
    }
}
