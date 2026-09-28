package com.dashworldng.ai.core.stream

import com.dashworldng.ai.core.model.FinishReason
import com.dashworldng.ai.core.model.ProviderId
import com.dashworldng.ai.core.remote.ConversationTitleDto
import com.dashworldng.ai.core.remote.DashJson
import com.dashworldng.ai.core.remote.MessageDeltaDto
import com.dashworldng.ai.core.remote.MessageEndDto
import com.dashworldng.ai.core.remote.MessageErrorDto
import com.dashworldng.ai.core.remote.StreamEndDto
import com.dashworldng.ai.core.remote.StreamErrorDto
import com.dashworldng.ai.core.remote.StreamStartDto
import kotlinx.serialization.json.Json

data class RawSseEvent(val event: String, val data: String)

/**
 * Incremental text/event-stream parser (WHATWG rules for the fields the API uses): feed it one
 * line at a time; it returns an event when a blank line completes one. Comments are ignored.
 */
class SseParser {
    private var eventName = "message"
    private val data = StringBuilder()
    private var hasData = false

    fun feed(line: String): RawSseEvent? {
        if (line.isEmpty()) return dispatch()
        if (line.startsWith(":")) return null
        val colon = line.indexOf(':')
        val field = if (colon == -1) line else line.substring(0, colon)
        var value = if (colon == -1) "" else line.substring(colon + 1)
        if (value.startsWith(" ")) value = value.substring(1)
        when (field) {
            "event" -> eventName = value
            "data" -> {
                if (hasData) data.append('\n')
                data.append(value)
                hasData = true
            }
        }
        return null
    }

    /** Flushes an event that was not followed by a blank line (end of stream). */
    fun finish(): RawSseEvent? = dispatch()

    private fun dispatch(): RawSseEvent? {
        val out = if (hasData) RawSseEvent(eventName, data.toString()) else null
        eventName = "message"
        data.setLength(0)
        hasData = false
        return out
    }

    companion object {
        fun parseAll(text: String): List<RawSseEvent> {
            val parser = SseParser()
            val out = mutableListOf<RawSseEvent>()
            for (line in text.split("\r\n", "\n", "\r")) parser.feed(line)?.let(out::add)
            parser.finish()?.let(out::add)
            return out
        }
    }
}

/** Maps raw server-sent events to domain events. Unknown event names are ignored (forward compatible). */
object StreamEventDecoder {
    fun decode(raw: RawSseEvent, json: Json = DashJson.default): ChatStreamEvent? = when (raw.event) {
        "stream.start" -> json.decodeFromString<StreamStartDto>(raw.data).let { dto ->
            ChatStreamEvent.Started(
                streamId = dto.streamId,
                conversationId = dto.conversationId,
                compareGroupId = dto.compareGroupId,
                targets = dto.targets.mapNotNull { t ->
                    ProviderId.fromWire(t.provider)?.let { StreamTarget(t.messageId, it, t.model, t.demo) }
                },
                routingReason = dto.routingReason,
            )
        }
        "message.delta" -> json.decodeFromString<MessageDeltaDto>(raw.data).let {
            ChatStreamEvent.Delta(it.messageId, it.text)
        }
        "message.end" -> json.decodeFromString<MessageEndDto>(raw.data).let {
            ChatStreamEvent.MessageEnded(it.messageId, FinishReason.fromWire(it.finishReason), it.usage.inputTokens, it.usage.outputTokens)
        }
        "message.error" -> json.decodeFromString<MessageErrorDto>(raw.data).let {
            ChatStreamEvent.MessageFailed(it.messageId, ApiError(it.error.code, it.error.message, it.error.retryable))
        }
        "conversation.title" -> json.decodeFromString<ConversationTitleDto>(raw.data).let {
            ChatStreamEvent.TitleChanged(it.conversationId, it.title)
        }
        "stream.end" -> ChatStreamEvent.Ended(json.decodeFromString<StreamEndDto>(raw.data).streamId)
        "stream.error" -> json.decodeFromString<StreamErrorDto>(raw.data).let {
            ChatStreamEvent.Failed(ApiError(it.error.code, it.error.message, it.error.retryable))
        }
        else -> null
    }
}
