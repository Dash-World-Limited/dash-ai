package com.dashworldng.ai.core.chat

import com.dashworldng.ai.core.model.AttachmentRef
import com.dashworldng.ai.core.model.ChatMessage
import com.dashworldng.ai.core.model.DocumentKind
import com.dashworldng.ai.core.model.ToolCallStatus
import com.dashworldng.ai.core.model.ToolUse
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json

/** What the message list renders: single messages, or both Compare answers side by side. */
sealed interface ChatItem {
    val key: String

    data class User(val message: ChatMessage) : ChatItem {
        override val key: String get() = message.id
    }

    data class Assistant(val message: ChatMessage) : ChatItem {
        override val key: String get() = message.id
    }

    data class Compare(val groupId: String, val answers: List<ChatMessage>) : ChatItem {
        override val key: String get() = "compare-$groupId"
    }
}

object ChatItems {
    fun build(messages: List<ChatMessage>): List<ChatItem> {
        val items = mutableListOf<ChatItem>()
        val seenGroups = mutableSetOf<String>()
        for (m in messages) {
            val group = m.compareGroupId
            when {
                m.isUser -> items += ChatItem.User(m)
                group == null -> items += ChatItem.Assistant(m)
                seenGroups.add(group) -> items += ChatItem.Compare(group, messages.filter { it.isAssistant && it.compareGroupId == group })
            }
        }
        return items
    }
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
