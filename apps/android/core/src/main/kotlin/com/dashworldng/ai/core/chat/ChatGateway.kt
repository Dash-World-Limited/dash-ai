package com.dashworldng.ai.core.chat

import com.dashworldng.ai.core.model.AssistantMode
import com.dashworldng.ai.core.model.AttachmentRef
import com.dashworldng.ai.core.model.ModelChoice
import com.dashworldng.ai.core.routing.HistoryItem
import com.dashworldng.ai.core.stream.ChatStreamEvent
import kotlinx.coroutines.flow.Flow

data class ChatRequest(
    val conversationId: String,
    val mode: AssistantMode,
    val modelChoice: ModelChoice,
    val messageId: String,
    val content: String,
    val attachments: List<AttachmentRef>,
    val history: List<HistoryItem>,
)

/**
 * Where answers come from. The live implementation talks only to the Dash AI API (never to a
 * provider directly); the demo implementation simulates answers on the device.
 */
interface ChatGateway {
    val isDemo: Boolean

    /** A cold stream of events for one request. Cancelling collection must stop generation. */
    fun stream(request: ChatRequest): Flow<ChatStreamEvent>

    /** Best-effort server-side cancellation, used in addition to closing the stream. */
    suspend fun cancel(streamId: String) {}
}
