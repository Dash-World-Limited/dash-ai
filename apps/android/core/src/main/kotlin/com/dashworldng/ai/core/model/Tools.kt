package com.dashworldng.ai.core.model

/** How one tool call ended, as reported by the server (`tool.result`). Unknown values read as [ERROR]. */
enum class ToolCallStatus(val wire: String) {
    OK("ok"),
    DUPLICATE("duplicate"),
    INVALID_ARGUMENTS("invalid_arguments"),
    DENIED("denied"),
    UNKNOWN_TOOL("unknown_tool"),
    TIMEOUT("timeout"),
    ERROR("error"),
    CANCELLED("cancelled");

    companion object {
        fun fromWire(value: String): ToolCallStatus = entries.firstOrNull { it.wire == value } ?: ERROR
    }
}

/**
 * One tool the assistant used while answering. Metadata only: which plugin and tool, and how it
 * ended. Arguments and results never reach the app (the server does not send them).
 *
 * @property status null while the tool is still running.
 */
data class ToolUse(
    val callId: String,
    val plugin: String,
    val tool: String,
    val status: ToolCallStatus? = null,
    val durationMs: Long? = null,
) {
    val running: Boolean get() = status == null
}

/** Why an answer failed and what the user may do about it (`message.error` → `recovery`). */
data class AnswerRecovery(val attempts: Int)
