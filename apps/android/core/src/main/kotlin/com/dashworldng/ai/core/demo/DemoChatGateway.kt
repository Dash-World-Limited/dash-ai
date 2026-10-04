package com.dashworldng.ai.core.demo

import com.dashworldng.ai.core.chat.ChatGateway
import com.dashworldng.ai.core.chat.ChatRequest
import com.dashworldng.ai.core.model.FinishReason
import com.dashworldng.ai.core.model.ModelChoice
import com.dashworldng.ai.core.model.ProviderId
import com.dashworldng.ai.core.routing.RoutingResult
import com.dashworldng.ai.core.routing.SmartRouting
import com.dashworldng.ai.core.stream.ApiError
import com.dashworldng.ai.core.stream.ApiException
import com.dashworldng.ai.core.stream.ChatStreamEvent
import com.dashworldng.ai.core.stream.StreamTarget
import com.dashworldng.ai.core.util.IdGenerator
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.launch

/** Lets testers see error states in Demo Mode (Settings → Demo Mode → Simulate). */
enum class DemoFailure(val label: String) {
    NONE("No errors"),
    CONNECTION("Connection error"),
    PROVIDER("Provider error"),
}

/**
 * Simulates streaming answers on the device. Nothing is sent to any server or AI provider, and
 * every answer says so. Model labels start with "demo-" and messages are flagged as demos.
 */
class DemoChatGateway(
    private val chunkDelayMillis: Long = 22,
    private val failure: () -> DemoFailure = { DemoFailure.NONE },
    private val ids: IdGenerator = IdGenerator.Uuid,
) : ChatGateway {
    override val isDemo: Boolean = true

    override fun stream(request: ChatRequest): Flow<ChatStreamEvent> = channelFlow {
        val mode = failure()
        if (mode == DemoFailure.CONNECTION) {
            delay(chunkDelayMillis * 10)
            throw ApiException(
                ApiError("network", "Demo Mode simulated a connection problem. Turn off simulated errors in Settings to continue.", retryable = true),
            )
        }
        val routing = SmartRouting.resolve(request.modelChoice, request.mode, ProviderId.entries.toSet()) as RoutingResult.Routed
        val streamId = ids.newId()
        val targets = routing.providers.map { StreamTarget(ids.newId(), it, "demo-${it.wire}", demo = true) }
        send(
            ChatStreamEvent.Started(
                streamId = streamId,
                conversationId = request.conversationId,
                compareGroupId = if (request.modelChoice == ModelChoice.COMPARE) request.messageId else null,
                targets = targets,
                routingReason = "Demo Mode: ${routing.reason}",
            ),
        )
        coroutineScope {
            targets.forEachIndexed { index, target ->
                launch {
                    if (mode == DemoFailure.PROVIDER && index == targets.lastIndex) {
                        delay(chunkDelayMillis * 12)
                        send(
                            ChatStreamEvent.MessageFailed(
                                target.messageId,
                                ApiError(
                                    "provider_error",
                                    "Demo Mode simulated a ${target.provider.displayName} error so you can see how failures look.",
                                    retryable = true,
                                ),
                                attempts = 1,
                                alternatives = listOf(target.provider.other),
                            ),
                        )
                        return@launch
                    }
                    for (chunk in DemoResponses.chunks(DemoResponses.compose(request, target.provider))) {
                        delay(chunkDelayMillis)
                        send(ChatStreamEvent.Delta(target.messageId, chunk))
                    }
                    send(ChatStreamEvent.MessageEnded(target.messageId, FinishReason.STOP, null, null))
                }
            }
        }
        send(ChatStreamEvent.Ended(streamId))
    }
}
