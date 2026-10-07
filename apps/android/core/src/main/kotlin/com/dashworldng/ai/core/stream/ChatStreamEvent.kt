package com.dashworldng.ai.core.stream

import com.dashworldng.ai.core.model.FinishReason
import com.dashworldng.ai.core.model.ProviderId
import com.dashworldng.ai.core.model.ToolCallStatus

/** A user-safe error from the API or a provider. */
data class ApiError(val code: String, val message: String, val retryable: Boolean) {
    companion object {
        fun network(detail: String? = null) = ApiError(
            code = "network",
            message = detail ?: "Couldn't reach the Dash AI server. Check your connection and the server address in Settings.",
            retryable = true,
        )

        val unexpected = ApiError("internal_error", "Something went wrong. Please try again.", retryable = true)
    }
}

class ApiException(val error: ApiError, val httpStatus: Int? = null, cause: Throwable? = null) :
    Exception(error.message, cause)

data class StreamTarget(val messageId: String, val provider: ProviderId, val model: String, val demo: Boolean)

/** Events produced while an answer streams, whether from the live API or from Demo Mode. */
sealed interface ChatStreamEvent {
    data class Started(
        val streamId: String,
        val conversationId: String,
        val compareGroupId: String?,
        val targets: List<StreamTarget>,
        val routingReason: String,
    ) : ChatStreamEvent

    data class Delta(val messageId: String, val text: String) : ChatStreamEvent

    data class MessageEnded(
        val messageId: String,
        val finishReason: FinishReason,
        val inputTokens: Int?,
        val outputTokens: Int?,
    ) : ChatStreamEvent

    /**
     * @property alternatives other providers the user may choose explicitly to retry this answer
     *   (the server never switches provider by itself). Unknown provider ids are dropped.
     */
    data class MessageFailed(
        val messageId: String,
        val error: ApiError,
        val attempts: Int = 1,
        val alternatives: List<ProviderId> = emptyList(),
    ) : ChatStreamEvent

    /** The assistant started using a tool (names only; arguments are never sent to the app). */
    data class ToolCalled(val messageId: String, val callId: String, val plugin: String, val tool: String) : ChatStreamEvent

    /** A tool call finished. Results are never sent to the app, only the outcome. */
    data class ToolFinished(
        val messageId: String,
        val callId: String,
        val plugin: String,
        val tool: String,
        val status: ToolCallStatus,
        val durationMs: Long,
    ) : ChatStreamEvent

    data class TitleChanged(val conversationId: String, val title: String) : ChatStreamEvent

    data class Ended(val streamId: String) : ChatStreamEvent

    data class Failed(val error: ApiError) : ChatStreamEvent
}
