package com.dashworldng.ai.core.chat

import com.dashworldng.ai.core.model.AttachmentRef
import com.dashworldng.ai.core.model.ChatMessage
import com.dashworldng.ai.core.model.DocumentKind
import com.dashworldng.ai.core.model.ToolCallStatus
import com.dashworldng.ai.core.model.ToolUse
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json

/** What the message list renders: each question and DASH AI's answer, in order. */
sealed interface ChatItem {
    val key: String

    data class User(val message: ChatMessage) : ChatItem {
        override val key: String get() = message.id
    }

    data class Assistant(val message: ChatMessage) : ChatItem {
        override val key: String get() = message.id
    }
}

object ChatItems {
    /** Answers kept from older Compare chats appear one after another, as DASH AI's. */
    fun build(messages: List<ChatMessage>): List<ChatItem> =
        messages.map { m -> if (m.isUser) ChatItem.User(m) else ChatItem.Assistant(m) }
}

@Serializable
private data class AttachmentJson(
    val documentId: String,
    val remoteId: String? = null,
    val name: String,
    val kind: String,
    val sizeBytes: Long,
)

/** Stores message attachments as a JSON column in the local database. */
object AttachmentCodec {
    private val json = Json { ignoreUnknownKeys = true }
    private val serializer = ListSerializer(AttachmentJson.serializer())

    fun encode(attachments: List<AttachmentRef>): String = json.encodeToString(
        serializer,
        attachments.map { AttachmentJson(it.documentId, it.remoteId, it.name, it.kind.wire, it.sizeBytes) },
    )

    fun decode(value: String?): List<AttachmentRef> {
        if (value.isNullOrBlank()) return emptyList()
        return runCatching {
            json.decodeFromString(serializer, value).map {
                AttachmentRef(it.documentId, it.remoteId, it.name, DocumentKind.fromWire(it.kind) ?: DocumentKind.TXT, it.sizeBytes)
            }
        }.getOrDefault(emptyList())
    }
}

@Serializable
private data class ToolUseJson(
    val callId: String,
    val plugin: String,
    val tool: String,
    val status: String,
    val durationMs: Long? = null,
)

/**
 * Stores the tools an answer used as a JSON column. Only calls that finished are stored: a call that
 * was still running has no outcome to show later, and none is invented for it.
 */
object ToolUseCodec {
    private val json = Json { ignoreUnknownKeys = true }
    private val serializer = ListSerializer(ToolUseJson.serializer())

    fun encode(tools: List<ToolUse>): String = json.encodeToString(
        serializer,
        tools.mapNotNull { use -> use.status?.let { ToolUseJson(use.callId, use.plugin, use.tool, it.wire, use.durationMs) } },
    )

    fun decode(value: String?): List<ToolUse> {
        if (value.isNullOrBlank()) return emptyList()
        return runCatching {
            json.decodeFromString(serializer, value).map { ToolUse(it.callId, it.plugin, it.tool, ToolCallStatus.fromWire(it.status), it.durationMs) }
        }.getOrDefault(emptyList())
    }
}
