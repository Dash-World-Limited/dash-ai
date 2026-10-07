package com.dashworldng.ai.core.routing

import com.dashworldng.ai.core.Limits
import com.dashworldng.ai.core.model.ChatMessage
import com.dashworldng.ai.core.model.MessageRole
import com.dashworldng.ai.core.model.MessageStatus

/** One prior turn sent as context. Assistant turns are DASH AI's own earlier answers, as plain text. */
data class HistoryItem(val role: MessageRole, val content: String)

/**
 * Decides which earlier messages may be sent as context.
 *
 * - Demo answers are never sent anywhere.
 * - Failed or still-streaming answers are skipped.
 * - Every other answer is DASH AI's, whichever AI infrastructure produced it, so the conversation
 *   stays one thread (mirrors the API's history handling).
 * - The oldest turns are dropped to respect the API's message and character limits.
 */
object ContextBuilder {
    fun history(earlier: List<ChatMessage>): List<HistoryItem> {
        val items = earlier.mapNotNull { m ->
            if (m.content.isBlank()) return@mapNotNull null
            when (m.role) {
                MessageRole.USER -> HistoryItem(MessageRole.USER, m.content)
                MessageRole.ASSISTANT -> {
                    val usable = !m.isDemo && (m.status == MessageStatus.COMPLETE || m.status == MessageStatus.STOPPED)
                    if (usable) HistoryItem(MessageRole.ASSISTANT, m.content) else null
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
