package com.dashworldng.ai.core.presentation

import com.dashworldng.ai.core.model.AnswerRecovery
import com.dashworldng.ai.core.model.ChatMessage
import com.dashworldng.ai.core.model.MessageStatus
import com.dashworldng.ai.core.model.ModelChoice
import com.dashworldng.ai.core.model.ProviderId
import com.dashworldng.ai.core.remote.ProvidersResponseDto

/** Which providers the server has configured. In Demo Mode every choice is simulated and available. */
data class ProviderAvailability(
    val configured: Set<ProviderId> = ProviderId.entries.toSet(),
    val models: Map<ProviderId, String> = emptyMap(),
    val fake: Boolean = false,
    val loading: Boolean = false,
    val error: String? = null,
) {
    fun isAvailable(choice: ModelChoice): Boolean = when (choice) {
        ModelChoice.SMART -> configured.isNotEmpty()
        ModelChoice.OPENAI -> ProviderId.OPENAI in configured
        ModelChoice.CLAUDE -> ProviderId.ANTHROPIC in configured
        ModelChoice.COMPARE -> configured.size == ProviderId.entries.size
    }

    companion object {
        fun from(response: ProvidersResponseDto): ProviderAvailability {
            val statuses = response.providers.mapNotNull { p -> ProviderId.fromWire(p.id)?.let { it to p } }
            return ProviderAvailability(
                configured = statuses.filter { it.second.configured }.map { it.first }.toSet(),
                models = statuses.mapNotNull { (id, p) -> p.model?.let { id to it } }.toMap(),
                fake = statuses.any { it.second.mode == "fake" },
            )
        }
    }
}

/** One row of the provider sheet. */
data class ProviderOption(
    val choice: ModelChoice,
    val title: String,
    val description: String,
    val selected: Boolean,
    val available: Boolean,
    /** Why the row cannot be chosen; null when it can. */
    val unavailableReason: String?,
    /** The server-configured model, when known (never shown for Demo Mode). */
    val model: String?,
)

object ProviderOptions {
    fun description(choice: ModelChoice): String = when (choice) {
        ModelChoice.SMART -> "Automatic. DASH AI chooses OpenAI or Claude for the mode you are in."
        ModelChoice.OPENAI -> "Every message in this chat goes to OpenAI."
        ModelChoice.CLAUDE -> "Every message in this chat goes to Anthropic's Claude."
        ModelChoice.COMPARE -> "Asks OpenAI and Claude and shows both answers. Uses two requests."
    }

    fun build(availability: ProviderAvailability, selected: ModelChoice, demoMode: Boolean): List<ProviderOption> =
        ModelChoice.entries.map { choice ->
            val available = demoMode || availability.isAvailable(choice)
            val model = when (choice) {
                ModelChoice.OPENAI -> availability.models[ProviderId.OPENAI]
                ModelChoice.CLAUDE -> availability.models[ProviderId.ANTHROPIC]
                else -> null
            }
            ProviderOption(
                choice = choice,
                title = choice.label,
                description = if (demoMode) "${description(choice)} Simulated in Demo Mode." else description(choice),
                selected = choice == selected,
                available = available,
                unavailableReason = when {
                    available -> null
                    choice == ModelChoice.COMPARE -> "Needs both OpenAI and Claude on this server."
                    choice == ModelChoice.SMART -> "No provider is configured on this server."
                    else -> "Not configured on this server."
                },
                model = if (demoMode) null else model,
            )
        }

    /**
     * Whether switching to [choice] is safe right now. Switching never interrupts an answer that is
     * still streaming, and never picks a provider on the user's behalf.
     */
    fun canSwitch(choice: ModelChoice, availability: ProviderAvailability, demoMode: Boolean, generating: Boolean): Boolean =
        !generating && (demoMode || availability.isAvailable(choice))
}

enum class RecoveryAction { RETRY, CHANGE_PROVIDER, CONTINUE_LATER }

/** What the failed-answer card shows. */
data class RecoveryCard(
    val title: String,
    val message: String,
    val attemptsNote: String?,
    val actions: List<RecoveryAction>,
    /** Providers offered under "Change provider" (explicit choice only). */
    val alternatives: List<ProviderId>,
)

object Recovery {
    const val TEMPORARY_TITLE = "Provider temporarily unavailable"
    const val PERMANENT_TITLE = "This answer couldn't be completed"

    /**
     * Builds the recovery card for a failed answer. The server's recovery metadata decides which other
     * providers are offered; without it (an answer reopened from history) the other configured
     * provider is offered. Compare answers are retried as a pair, so they never offer a switch.
     * The app never switches provider by itself.
     */
    fun card(message: ChatMessage, recovery: AnswerRecovery?, configured: Set<ProviderId>, online: Boolean): RecoveryCard? {
        if (!message.isAssistant || message.status != MessageStatus.FAILED) return null
        val alternatives = when {
            message.compareGroupId != null -> emptyList()
            recovery != null -> recovery.alternatives
            else -> listOfNotNull(message.provider?.other)
        }.filter { it in configured && it != message.provider }.distinct()
        val retryable = message.errorRetryable
        val actions = buildList {
            if (retryable && online) add(RecoveryAction.RETRY)
            if (alternatives.isNotEmpty() && online) add(RecoveryAction.CHANGE_PROVIDER)
            add(RecoveryAction.CONTINUE_LATER)
        }
        val attempts = recovery?.attempts ?: 1
        return RecoveryCard(
            title = if (retryable) TEMPORARY_TITLE else PERMANENT_TITLE,
            message = when {
                !online -> "You're offline. Your conversation is saved; try again when you're connected."
                else -> message.errorMessage ?: "The provider did not finish this answer. Your conversation is saved."
            },
            attemptsNote = if (attempts > 1) "DASH AI tried $attempts times before stopping." else null,
            actions = actions,
            alternatives = alternatives,
        )
    }
}
