package com.dashworldng.ai.core.model

/**
 * Internal id of the AI infrastructure behind an answer, kept only for local bookkeeping when a server
 * reports it (engineering builds). It is never shown: DASH AI is the product, and the app never talks
 * to an AI service directly — only through the DASH AI API.
 */
enum class ProviderId(val wire: String) {
    OPENAI("openai"),
    ANTHROPIC("anthropic");

    companion object {
        fun fromWire(value: String): ProviderId? = entries.firstOrNull { it.wire == value }
    }
}

/**
 * The routing value sent with each request. There is no provider choice in the app: DASH AI routes
 * every request itself, so the app always sends [SMART]. Older stored values read back as null.
 */
enum class ModelChoice(val wire: String) {
    SMART("smart");

    companion object {
        fun fromWire(value: String): ModelChoice? = entries.firstOrNull { it.wire == value }
    }
}

enum class MessageRole { USER, ASSISTANT }

enum class MessageStatus { STREAMING, COMPLETE, STOPPED, FAILED }

enum class FinishReason(val wire: String) {
    STOP("stop"),
    LENGTH("length"),
    REFUSAL("refusal"),
    CANCELLED("cancelled");

    companion object {
        fun fromWire(value: String): FinishReason = entries.firstOrNull { it.wire == value } ?: STOP
    }
}

enum class DocumentKind(val wire: String, val label: String) {
    PDF("pdf", "PDF"),
    DOCX("docx", "Word"),
    TXT("txt", "Text"),
    IMAGE("image", "Image");

    companion object {
        fun fromWire(value: String): DocumentKind? = entries.firstOrNull { it.wire == value }
    }
}

/** A document attached to a user message. */
data class AttachmentRef(
    val documentId: String,
    val remoteId: String?,
    val name: String,
    val kind: DocumentKind,
    val sizeBytes: Long,
)

data class Conversation(
    val id: String,
    val title: String,
    val mode: AssistantMode,
    val createdAt: Long,
    val updatedAt: Long,
    val titleIsCustom: Boolean = false,
    /** Created in Demo Mode: its answers are simulated and nothing is sent anywhere. */
    val isDemo: Boolean = false,
)

data class ChatMessage(
    val id: String,
    val conversationId: String,
    val role: MessageRole,
    val content: String,
    val createdAt: Long,
    val status: MessageStatus = MessageStatus.COMPLETE,
    /** Internal: the AI infrastructure behind an answer, when a server reports it. Never shown. */
    val provider: ProviderId? = null,
    /** Internal: the model a server reported, when it reports one. Never shown. */
    val model: String? = null,
    /** True when the answer is a demonstration, not a real DASH AI answer. */
    val isDemo: Boolean = false,
    val modelChoice: ModelChoice? = null,
    /** Legacy: set on answers stored by older versions that offered Compare. Not used for display. */
    val compareGroupId: String? = null,
    /** For assistant messages: the user message being answered. */
    val replyToId: String? = null,
    val attachments: List<AttachmentRef> = emptyList(),
    val errorMessage: String? = null,
    val errorRetryable: Boolean = false,
    val finishReason: FinishReason? = null,
    val routingReason: String? = null,
    /** Tools used while writing this answer, as recorded (names and outcomes only). Kept with the message. */
    val tools: List<ToolUse> = emptyList(),
) {
    val isUser: Boolean get() = role == MessageRole.USER
    val isAssistant: Boolean get() = role == MessageRole.ASSISTANT
    val isStreaming: Boolean get() = status == MessageStatus.STREAMING

    /** Who wrote this answer, as shown to people: always DASH AI (simulated in Demo Mode). */
    val sourceLabel: String?
        get() = when {
            !isAssistant -> null
            isDemo -> "Demo · DASH AI (simulated)"
            else -> "DASH AI"
        }
}

data class UserProfile(
    val id: String,
    val email: String?,
    val displayName: String,
    val isDemo: Boolean,
)
