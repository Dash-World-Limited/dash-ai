package com.dashworldng.ai.core.presentation

import com.dashworldng.ai.core.model.ToolCallStatus
import com.dashworldng.ai.core.model.ToolUse
import com.dashworldng.ai.core.remote.PluginDto
import com.dashworldng.ai.core.remote.PluginsResponseDto

enum class ConnectionState(val label: String, val tone: StatusTone) {
    AVAILABLE("Available", StatusTone.NEUTRAL),
    CONNECTED("Connected", StatusTone.SUCCESS),
    DISABLED("Disabled", StatusTone.NEUTRAL),
    REQUIRES_PERMISSION("Requires permission", StatusTone.WARNING),
}

data class ToolEntry(val name: String, val label: String, val description: String, val runnable: Boolean)

data class PermissionEntry(val id: String, val description: String, val write: Boolean, val granted: Boolean)

/** One plugin from the server's registry, as the Tools & Connections screen shows it. */
data class ToolConnection(
    val id: String,
    val name: String,
    val description: String,
    val builtIn: Boolean,
    val state: ConnectionState,
    val detail: String,
    val tools: List<ToolEntry>,
    val permissions: List<PermissionEntry>,
    val enabled: Boolean,
    /** Whether the switch can be used. */
    val canToggle: Boolean,
    /** Scopes to grant when the user allows access (read scopes needed by runnable tools). */
    val scopesToGrant: List<String>,
)

object ToolConnections {
    fun from(response: PluginsResponseDto): List<ToolConnection> = response.plugins.map { from(it, response.toolsEnabled) }

    fun from(plugin: PluginDto, toolsEnabled: Boolean): ToolConnection {
        val runnable = plugin.tools.filter { it.executable }
        val writeScopes = plugin.scopes.filter { it.risk != "read" }.map { it.id }.toSet()
        val needed = runnable.map { it.scope }.filterNot { it in writeScopes }.distinct()
        val missing = needed.filterNot { it in plugin.grantedScopes }
        val (state, detail) = when {
            !toolsEnabled -> ConnectionState.DISABLED to "Tools are turned off on this server."
            runnable.isEmpty() -> ConnectionState.DISABLED to "Not available on this server yet."
            plugin.enabled && missing.isEmpty() -> ConnectionState.CONNECTED to "DASH AI can use these tools when they help with your request."
            plugin.enabled -> ConnectionState.REQUIRES_PERMISSION to "Allow access so DASH AI can use these tools."
            else -> ConnectionState.AVAILABLE to "Off. Turn it on to let DASH AI use these tools."
        }
        return ToolConnection(
            id = plugin.id,
            name = plugin.name,
            description = plugin.description,
            builtIn = plugin.kind == "builtin",
            state = state,
            detail = detail,
            tools = plugin.tools.map { ToolEntry(it.name, ToolLabels.toolLabel(it.name), it.description, it.executable) },
            permissions = plugin.scopes.map { PermissionEntry(it.id, it.description, it.risk != "read", it.id in plugin.grantedScopes) },
            enabled = plugin.enabled,
            canToggle = toolsEnabled && (runnable.isNotEmpty() || plugin.enabled),
            scopesToGrant = (plugin.grantedScopes.filterNot { it in writeScopes } + needed).distinct().sorted(),
        )
    }
}

/** A compact line in an answer: "Used Text stats". Names only; never arguments or results. */
data class ToolActivityLabel(val title: String, val detail: String, val tone: StatusTone, val running: Boolean)

object ToolLabels {
    /** "text_stats" → "Text stats". */
    fun toolLabel(name: String): String =
        name.replace('_', ' ').replace('-', ' ').trim().replaceFirstChar { it.uppercaseChar() }.ifEmpty { "Tool" }

    fun pluginLabel(id: String, knownNames: Map<String, String>): String =
        knownNames[id] ?: id.replace('-', ' ').replaceFirstChar { it.uppercaseChar() }

    fun label(use: ToolUse, pluginNames: Map<String, String> = emptyMap()): ToolActivityLabel {
        val tool = toolLabel(use.tool)
        val plugin = pluginLabel(use.plugin, pluginNames)
        val took = use.durationMs?.let { " in ${formatDuration(it)}" }.orEmpty()
        return when (use.status) {
            null -> ToolActivityLabel("Using $tool", plugin, StatusTone.PROGRESS, running = true)
            ToolCallStatus.OK, ToolCallStatus.DUPLICATE -> ToolActivityLabel("Used $tool", "$plugin · finished$took", StatusTone.SUCCESS, false)
            ToolCallStatus.DENIED -> ToolActivityLabel("$tool not permitted", "$plugin · access is not allowed in Tools & Connections", StatusTone.WARNING, false)
            ToolCallStatus.CANCELLED -> ToolActivityLabel("$tool stopped", plugin, StatusTone.NEUTRAL, false)
            ToolCallStatus.TIMEOUT -> ToolActivityLabel("$tool timed out", plugin, StatusTone.WARNING, false)
            else -> ToolActivityLabel("Couldn't use $tool", plugin, StatusTone.WARNING, false)
        }
    }

    /** One-line summary for a collapsed group of tool uses. */
    fun summary(uses: List<ToolUse>): String = when {
        uses.isEmpty() -> ""
        uses.any { it.running } -> "Using tools…"
        uses.size == 1 -> label(uses.single()).title
        else -> "Used ${uses.size} tools"
    }

    private fun formatDuration(ms: Long): String = if (ms < 1000) "$ms ms" else String.format(java.util.Locale.ROOT, "%.1f s", ms / 1000.0)
}
