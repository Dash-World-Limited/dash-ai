package com.dashworldng.ai.core.routing

import com.dashworldng.ai.core.model.AssistantMode
import com.dashworldng.ai.core.model.ProviderId

sealed interface RoutingResult {
    data class Routed(val providers: List<ProviderId>, val reason: String) : RoutingResult

    data class Unavailable(val code: String, val message: String) : RoutingResult
}

/**
 * Mirror of packages/contracts/src/routing.ts (internal: never shown to people). The API is
 * authoritative for live requests; Demo Mode uses this copy. A contract test checks the table
 * against fixtures/smart-routing.json.
 */
object SmartRouting {
    val table: Map<AssistantMode, List<ProviderId>> = mapOf(
        AssistantMode.GENERAL to listOf(ProviderId.OPENAI, ProviderId.ANTHROPIC),
        AssistantMode.BUSINESS to listOf(ProviderId.OPENAI, ProviderId.ANTHROPIC),
        AssistantMode.WRITING to listOf(ProviderId.ANTHROPIC, ProviderId.OPENAI),
        AssistantMode.DOCUMENTS to listOf(ProviderId.ANTHROPIC, ProviderId.OPENAI),
        AssistantMode.RESEARCH to listOf(ProviderId.OPENAI, ProviderId.ANTHROPIC),
    )

    /**
     * Internal routing for Demo Mode (the API decides for live requests). The reason is a neutral
     * sentence: which AI infrastructure is preferred is never shown.
     */
    fun resolve(mode: AssistantMode, configured: Set<ProviderId>): RoutingResult {
        val pick = table.getValue(mode).firstOrNull { it in configured }
            ?: return RoutingResult.Unavailable("no_provider_available", "DASH AI is temporarily unavailable.")
        return RoutingResult.Routed(listOf(pick), "DASH AI chose how to answer.")
    }

    /** A short line under the composer saying who receives the next message: DASH AI. */
    fun recipientLabel(mode: AssistantMode, demo: Boolean): String =
        if (demo) "Demo Mode · simulated answers · nothing leaves this device" else "DASH AI · ${mode.label}"
}
