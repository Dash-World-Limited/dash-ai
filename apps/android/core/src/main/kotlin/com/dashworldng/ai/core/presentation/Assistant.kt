package com.dashworldng.ai.core.presentation

import com.dashworldng.ai.core.model.AnswerRecovery
import com.dashworldng.ai.core.model.ChatMessage
import com.dashworldng.ai.core.model.MessageStatus
import com.dashworldng.ai.core.remote.AssistantStatusDto

/**
 * Whether DASH AI can answer right now. There is no provider choice: DASH AI decides how to handle
 * each request, and the AI infrastructure behind it is never shown.
 */
data class AssistantAvailability(
    val available: Boolean = true,
    val demo: Boolean = false,
    val loading: Boolean = false,
    val error: String? = null,
) {
    companion object {
        fun from(response: AssistantStatusDto): AssistantAvailability =
            AssistantAvailability(available = response.available, demo = response.demo)
    }
}

enum class RecoveryAction { RETRY, CONTINUE_LATER }

/** What the failed-answer card shows. */
data class RecoveryCard(
    val title: String,
    val message: String,
    val attemptsNote: String?,
    val actions: List<RecoveryAction>,
)

object Recovery {
    const val TEMPORARY_TITLE = "DASH AI couldn't complete that response"
    const val PERMANENT_TITLE = "This answer couldn't be completed"

    /**
     * Builds the recovery card for a failed answer: Retry (when it can work) and Continue later.
     * DASH AI handles any rerouting itself; the app never offers another provider.
     */
    fun card(message: ChatMessage, recovery: AnswerRecovery?, online: Boolean): RecoveryCard? {
        if (!message.isAssistant || message.status != MessageStatus.FAILED) return null
        val retryable = message.errorRetryable
        val actions = buildList {
            if (retryable && online) add(RecoveryAction.RETRY)
            add(RecoveryAction.CONTINUE_LATER)
        }
        val attempts = recovery?.attempts ?: 1
        return RecoveryCard(
            title = if (retryable) TEMPORARY_TITLE else PERMANENT_TITLE,
            message = when {
                !online -> "You're offline. Your conversation is saved; try again when you're connected."
                else -> message.errorMessage ?: "DASH AI couldn't complete that response. Your conversation is saved."
            },
            attemptsNote = if (attempts > 1) "DASH AI tried $attempts times before stopping." else null,
            actions = actions,
        )
    }
}
