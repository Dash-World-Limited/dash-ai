package com.dashworldng.ai.core.demo

import com.dashworldng.ai.core.chat.ChatGateway
import com.dashworldng.ai.core.chat.ChatRequest
import com.dashworldng.ai.core.model.FinishReason
import com.dashworldng.ai.core.stream.ApiError
import com.dashworldng.ai.core.stream.ApiException
import com.dashworldng.ai.core.stream.ChatStreamEvent
import com.dashworldng.ai.core.stream.StreamTarget
import com.dashworldng.ai.core.util.IdGenerator
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow

/** Lets testers see error states in Demo Mode (Settings → Demo Mode → Simulate). */
enum class DemoFailure(val label: String) {
    NONE("No errors"),
    CONNECTION("Connection error"),
    SERVICE("DASH AI couldn't answer");

    companion object {
        /** Reads a stored value; older versions stored PROVIDER for what is now [SERVICE]. */
        fun fromStored(value: String?): DemoFailure = when (value) {
            "PROVIDER" -> SERVICE
            else -> entries.firstOrNull { it.name == value } ?: NONE
        }
    }
}

/**
 * Simulates streaming answers on the device. Nothing is sent to any server or AI service, and
 * every answer says so. Messages are flagged as demos and carry no provider.
 */
class DemoChatGateway(
    private val chunkDelayMillis: Long = 22,
    private val failure: () -> DemoFailure = { DemoFailure.NONE },
    private val ids: IdGenerator = IdGenerator.Uuid,
) : ChatGateway {
    override val isDemo: Boolean = true

    override fun stream(request: ChatRequest): Flow<ChatStreamEvent> = flow {
        val mode = failure()
        if (mode == DemoFailure.CONNECTION) {
            delay(chunkDelayMillis * 10)
            throw ApiException(
                ApiError("network", "Demo Mode simulated a connection problem. Turn off simulated errors in Settings to continue.", retryable = true),
            )
        }
        val streamId = ids.newId()
        val target = StreamTarget(ids.newId(), demo = true)
        emit(ChatStreamEvent.Started(streamId, request.conversationId, compareGroupId = null, targets = listOf(target), routingReason = "Demo Mode"))
        if (mode == DemoFailure.SERVICE) {
            delay(chunkDelayMillis * 12)
            emit(
                ChatStreamEvent.MessageFailed(
                    target.messageId,
                    ApiError("provider_error", "Demo Mode simulated DASH AI not completing a response so you can see how failures look.", retryable = true),
                    attempts = 1,
                ),
            )
        } else {
            for (chunk in DemoResponses.chunks(DemoResponses.compose(request))) {
                delay(chunkDelayMillis)
                emit(ChatStreamEvent.Delta(target.messageId, chunk))
            }
            emit(ChatStreamEvent.MessageEnded(target.messageId, FinishReason.STOP, null, null))
        }
        emit(ChatStreamEvent.Ended(streamId))
    }
}
