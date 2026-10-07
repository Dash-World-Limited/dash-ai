package com.dashworldng.ai.core.tools

import com.dashworldng.ai.core.remote.DashApiClient
import com.dashworldng.ai.core.remote.PluginDto
import com.dashworldng.ai.core.remote.PluginsResponseDto
import com.dashworldng.ai.core.remote.ToolActivityResponseDto
import com.dashworldng.ai.core.remote.UpdatePluginRequestDto

/** The server's plugin registry and this user's choices (GET/PUT /v1/plugins). */
class ToolsService(private val client: () -> DashApiClient) {
    suspend fun plugins(): PluginsResponseDto = client().call { plugins() }

    /** Turns a plugin on or off. With [grantedScopes] null the server grants the plugin's read scopes. */
    suspend fun setEnabled(id: String, enabled: Boolean, grantedScopes: List<String>? = null): PluginDto =
        client().call { updatePlugin(id, UpdatePluginRequestDto(enabled, grantedScopes)) }

    suspend fun activity(): ToolActivityResponseDto = client().call { toolActivity() }
}
