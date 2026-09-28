package com.dashworldng.ai.core.routing

import com.dashworldng.ai.core.Limits
import com.dashworldng.ai.core.model.ChatMessage
import com.dashworldng.ai.core.model.MessageRole
import com.dashworldng.ai.core.model.MessageStatus
import com.dashworldng.ai.core.model.ModelChoice
import com.dashworldng.ai.core.model.ProviderId

/** One prior turn sent as context. Assistant turns always name the provider that produced them. */
data class HistoryItem(val role: MessageRole, val content: String, val origin: ProviderId?)

/**
 * Decides which earlier messages may be sent as context.
 *
 * - Demo answers are never sent anywhere.
 * - Failed or still-streaming answers are skipped.
 * - For an explicit single-provider choice, only that provider's answers are included, so one
 *   provider never silently receives another provider's output. For Dash Smart and Compare the
 *   API applies the same rule per target provider.
 * - The oldest turns are dropped to respect the API's message and character limits.
 */
object ContextBuilder {
    fun history(earlier: List<ChatMessage>, choice: ModelChoice): List<HistoryItem> {
        val allowedProvider: ProviderId? = when (choice) {
            ModelChoice.OPENAI -> ProviderId.OPENAI
            ModelChoice.CLAUDE -> ProviderId.ANTHROPIC
            ModelChoice.SMART, ModelChoice.COMPARE -> null
        }
        val items = earlier.mapNotNull { m ->
            if (m.content.isBlank()) return@mapNotNull null
            when (m.role) {
                MessageRole.USER -> HistoryItem(MessageRole.USER, m.content, null)
                MessageRole.ASSISTANT -> {
                    val provider = m.provider
                    val usable = !m.isDemo && provider != null &&
                        (m.status == MessageStatus.COMPLETE || m.status == MessageStatus.STOPPED) &&
                        (allowedProvider == null || provider == allowedProvider)
                    if (usable) HistoryItem(MessageRole.ASSISTANT, m.content, provider) else null
                }
            }
        }
        return trim(items)
    }

    fun trim(
        items: List<HistoryItem>,
        maxMessages: Int = Limits.MAX_HISTORY_MESSAGES,
        maxChars: Int = Limits.MAX_HISTORY_CHARS,
    ): List<HistoryItem> {
        val kept = ArrayDeque<HistoryItem>()
        var total = 0
        for (item in items.asReversed()) {
            if (kept.size >= maxMessages) break
            val length = item.content.length.coerceAtMost(Limits.MAX_MESSAGE_CHARS)
            if (total + length > maxChars) break
            kept.addFirst(if (item.content.length > Limits.MAX_MESSAGE_CHARS) item.copy(content = item.content.take(Limits.MAX_MESSAGE_CHARS)) else item)
            total += length
        }
        return kept.toList()
    }
}
