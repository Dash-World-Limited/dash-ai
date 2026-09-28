package com.dashworldng.ai.core.routing

import com.dashworldng.ai.core.model.AssistantMode
import com.dashworldng.ai.core.model.ModelChoice
import com.dashworldng.ai.core.model.ProviderId

sealed interface RoutingResult {
    data class Routed(val providers: List<ProviderId>, val reason: String) : RoutingResult

    data class Unavailable(val code: String, val message: String) : RoutingResult
}

/**
 * Mirror of packages/contracts/src/routing.ts. The API is authoritative for live requests; Demo
 * Mode uses this copy. A contract test checks the table against fixtures/smart-routing.json.
 */
object SmartRouting {
    val table: Map<AssistantMode, List<ProviderId>> = mapOf(
        AssistantMode.GENERAL to listOf(ProviderId.OPENAI, ProviderId.ANTHROPIC),
        AssistantMode.BUSINESS to listOf(ProviderId.OPENAI, ProviderId.ANTHROPIC),
        AssistantMode.WRITING to listOf(ProviderId.ANTHROPIC, ProviderId.OPENAI),
        AssistantMode.DOCUMENTS to listOf(ProviderId.ANTHROPIC, ProviderId.OPENAI),
        AssistantMode.RESEARCH to listOf(ProviderId.OPENAI, ProviderId.ANTHROPIC),
    )

    private val reasons: Map<AssistantMode, String> = mapOf(
        AssistantMode.GENERAL to "General conversations default to OpenAI when it is configured.",
        AssistantMode.BUSINESS to "Business planning defaults to OpenAI when it is configured.",
        AssistantMode.WRITING to "Long-form writing defaults to Claude when it is configured.",
        AssistantMode.DOCUMENTS to "Document work defaults to Claude when it is configured.",
        AssistantMode.RESEARCH to "Research defaults to OpenAI when it is configured.",
    )

    fun resolve(choice: ModelChoice, mode: AssistantMode, configured: Set<ProviderId>): RoutingResult =
        when (choice) {
            ModelChoice.OPENAI ->
                if (ProviderId.OPENAI in configured) RoutingResult.Routed(listOf(ProviderId.OPENAI), "You selected OpenAI.")
                else RoutingResult.Unavailable("provider_not_configured", "OpenAI is not configured on this server.")
            ModelChoice.CLAUDE ->
                if (ProviderId.ANTHROPIC in configured) RoutingResult.Routed(listOf(ProviderId.ANTHROPIC), "You selected Claude.")
                else RoutingResult.Unavailable("provider_not_configured", "Claude is not configured on this server.")
            ModelChoice.COMPARE ->
                if (configured.containsAll(ProviderId.entries)) {
                    RoutingResult.Routed(
                        listOf(ProviderId.OPENAI, ProviderId.ANTHROPIC),
                        "Compare sends the same prompt to OpenAI and Claude.",
                    )
                } else {
                    RoutingResult.Unavailable(
                        "provider_not_configured",
                        "Compare needs both OpenAI and Claude to be configured on this server.",
                    )
                }
            ModelChoice.SMART -> {
                val preferred = table.getValue(mode)
                val pick = preferred.firstOrNull { it in configured }
                when {
                    pick == null -> RoutingResult.Unavailable("no_provider_available", "No AI provider is configured on this server.")
                    pick == preferred.first() -> RoutingResult.Routed(listOf(pick), reasons.getValue(mode))
                    else -> RoutingResult.Routed(
                        listOf(pick),
                        "Dash Smart used ${pick.displayName} because the preferred provider is not configured.",
                    )
                }
            }
        }

    /** A short sentence for the composer saying who will receive the next prompt. */
    fun recipientLabel(choice: ModelChoice, mode: AssistantMode, demo: Boolean): String = when {
        demo -> "Demo Mode · simulated answers · nothing leaves this device"
        choice == ModelChoice.COMPARE -> "Sends to OpenAI + Claude · uses both providers and may cost more"
        choice == ModelChoice.SMART -> "Dash Smart · usually ${table.getValue(mode).first().displayName} for ${mode.label}"
        choice == ModelChoice.OPENAI -> "Sends to OpenAI"
        else -> "Sends to Claude (Anthropic)"
    }
}
