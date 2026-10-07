package com.dashworldng.ai.core

import com.dashworldng.ai.core.chat.ChatGateway
import com.dashworldng.ai.core.chat.ChatRequest
import com.dashworldng.ai.core.model.FinishReason
import com.dashworldng.ai.core.model.ProviderId
import com.dashworldng.ai.core.stream.ChatStreamEvent
import com.dashworldng.ai.core.stream.StreamTarget
import com.dashworldng.ai.core.util.IdGenerator
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.FlowCollector
import kotlinx.coroutines.flow.flow
import java.io.File

/** A gateway whose behaviour is scripted per test. Records requests and cancellations. */
class ScriptedGateway(
    override val isDemo: Boolean = false,
    private val script: suspend FlowCollector<ChatStreamEvent>.(ChatRequest) -> Unit = { request ->
        answer(request, null, "Hello from DASH AI")
    },
) : ChatGateway {
    val requests = mutableListOf<ChatRequest>()
    val cancelledStreams = mutableListOf<String>()

    override fun stream(request: ChatRequest): Flow<ChatStreamEvent> = flow {
        requests += request
        script(request)
    }

    override suspend fun cancel(streamId: String) {
        cancelledStreams += streamId
    }
}

private var counter = 0

fun nextId(prefix: String = "id"): String = "$prefix-${++counter}"

/** Emits one complete answer. Production servers send no provider; engineering servers may. */
suspend fun FlowCollector<ChatStreamEvent>.answer(
    request: ChatRequest,
    provider: ProviderId?,
    text: String,
    messageId: String = nextId("answer"),
) {
    emit(
        ChatStreamEvent.Started(
            streamId = nextId("stream"),
            conversationId = request.conversationId,
            compareGroupId = null,
            targets = listOf(StreamTarget(messageId, provider, provider?.let { "model-${it.wire}" }, demo = false)),
            routingReason = "test",
        ),
    )
    text.chunked(5).forEach { emit(ChatStreamEvent.Delta(messageId, it)) }
    emit(ChatStreamEvent.MessageEnded(messageId, FinishReason.STOP, 10, 5))
    emit(ChatStreamEvent.Ended("stream"))
}

class SequentialIds(private val prefix: String = "gen") : IdGenerator {
    private var n = 0

    override fun newId(): String = "$prefix-${++n}"
}

object Fixtures {
    private val dir: File by lazy {
        val configured = System.getProperty("dash.contracts.fixtures")
        val candidates = listOfNotNull(configured, "../../../packages/contracts/fixtures")
        candidates.map(::File).firstOrNull { it.isDirectory }
            ?: error("Contract fixtures not found. Looked in: $candidates")
    }

    fun text(name: String): String = File(dir, name).readText()
}

/** Provider and model names a person must never see in DASH AI's interface. */
val PROVIDER_NAMES = Regex("(?i)\\b(openai|chatgpt|gpt[-\\s]?\\d|anthropic|claude|gemini|dash smart)\\b|\\b(ai|change|another|other|default) providers?\\b")

fun assertNoProviderName(text: String?, where: String = "text") {
    val hit = text?.let { PROVIDER_NAMES.find(it)?.value }
    kotlin.test.assertNull(hit, "provider wording in $where: $text")
}
