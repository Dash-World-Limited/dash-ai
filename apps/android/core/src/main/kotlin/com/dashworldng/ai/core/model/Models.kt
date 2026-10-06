package com.dashworldng.ai.core.model

/** The two real AI providers. The app never talks to them directly — only through the Dash AI API. */
enum class ProviderId(val wire: String, val displayName: String, val company: String) {
    OPENAI("openai", "OpenAI", "OpenAI"),
    ANTHROPIC("anthropic", "Claude", "Anthropic");

    val other: ProviderId get() = if (this == OPENAI) ANTHROPIC else OPENAI

    companion object {
        fun fromWire(value: String): ProviderId? = entries.firstOrNull { it.wire == value }
    }
}

/** What the user picks in the model selector. */
enum class ModelChoice(val wire: String, val label: String, val description: String) {
    SMART("smart", "Dash Smart", "Dash AI picks the most suitable configured model for the mode."),
    OPENAI("openai", "OpenAI", "Every prompt in this chat goes to OpenAI."),
    CLAUDE("claude", "Claude", "Every prompt in this chat goes to Anthropic's Claude."),
    COMPARE("compare", "Compare", "Sends the same prompt to OpenAI and Claude and shows both answers side by side.");

    companion object {
        fun fromWire(value: String): ModelChoice? = entries.firstOrNull { it.wire == value }

        /** The explicit choice that targets a single provider. */
        fun forProvider(provider: ProviderId): ModelChoice = if (provider == ProviderId.OPENAI) OPENAI else CLAUDE
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
    /** Created in Demo Mode: its answers are simulated and never sent to a real provider. */
    val isDemo: Boolean = false,
)

data class ChatMessage(
    val id: String,
    val conversationId: String,
    val role: MessageRole,
    val content: String,
    val createdAt: Long,
    val status: MessageStatus = MessageStatus.COMPLETE,
    /** Provider that produced an assistant message (null for user messages). */
    val provider: ProviderId? = null,
    /** Model label reported by the server (or the demo engine). */
    val model: String? = null,
    /** True when the answer is a demonstration, not a real provider response. */
    val isDemo: Boolean = false,
    val modelChoice: ModelChoice? = null,
    /** Shared by the two answers of a Compare request. */
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

    /** Human-readable label saying exactly who produced this answer. */
    val sourceLabel: String?
        get() = when {
            !isAssistant -> null
            isDemo -> "Demo · ${provider?.displayName ?: "Dash AI"}-style (simulated)"
            provider != null -> listOfNotNull(provider.displayName, model).joinToString(" · ")
            else -> null
        }
}

data class UserProfile(
    val id: String,
    val email: String?,
    val displayName: String,
    val isDemo: Boolean,
)
