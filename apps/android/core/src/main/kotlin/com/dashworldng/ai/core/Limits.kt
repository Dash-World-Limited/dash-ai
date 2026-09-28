package com.dashworldng.ai.core

/** Mirror of LIMITS in packages/contracts (checked against fixtures/limits.json). */
object Limits {
    const val MAX_MESSAGE_CHARS = 32_000
    const val MAX_HISTORY_MESSAGES = 60
    const val MAX_HISTORY_CHARS = 200_000
    const val MAX_ATTACHMENTS_PER_MESSAGE = 5
    const val MAX_TITLE_CHARS = 120
    const val MAX_DISPLAY_NAME_CHARS = 80
    const val MIN_PASSWORD_CHARS = 8
    const val MAX_PASSWORD_CHARS = 200
    const val MAX_UPLOAD_BYTES = 10L * 1024 * 1024
    const val MAX_EXTRACTED_CHARS = 200_000

    val asMap: Map<String, Long> = mapOf(
        "maxMessageChars" to MAX_MESSAGE_CHARS.toLong(),
        "maxHistoryMessages" to MAX_HISTORY_MESSAGES.toLong(),
        "maxHistoryChars" to MAX_HISTORY_CHARS.toLong(),
        "maxAttachmentsPerMessage" to MAX_ATTACHMENTS_PER_MESSAGE.toLong(),
        "maxTitleChars" to MAX_TITLE_CHARS.toLong(),
        "maxDisplayNameChars" to MAX_DISPLAY_NAME_CHARS.toLong(),
        "minPasswordChars" to MIN_PASSWORD_CHARS.toLong(),
        "maxPasswordChars" to MAX_PASSWORD_CHARS.toLong(),
        "maxUploadBytes" to MAX_UPLOAD_BYTES,
        "maxExtractedChars" to MAX_EXTRACTED_CHARS.toLong(),
    )
}
