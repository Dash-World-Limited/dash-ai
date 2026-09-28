package com.dashworldng.ai.core.model

enum class DocumentStatus {
    /** Upload in progress. */
    UPLOADING,

    /** The server extracted text; the document can be used as chat context. */
    READY,

    /** Validated, but its contents cannot be read yet (e.g. images, scanned PDFs). */
    UNSUPPORTED,

    /** Upload or validation failed. */
    FAILED,

    /** Demo Mode: checked on the device only. Contents are never uploaded or analysed. */
    DEMO,
}

data class DocumentItem(
    val id: String,
    val remoteId: String?,
    val name: String,
    val kind: DocumentKind,
    val mimeType: String,
    val sizeBytes: Long,
    val status: DocumentStatus,
    val statusDetail: String,
    val extractedChars: Int = 0,
    val pageCount: Int? = null,
    val createdAt: Long,
    val isDemo: Boolean,
    val progress: Float = 0f,
) {
    val canAttach: Boolean get() = status == DocumentStatus.READY || status == DocumentStatus.DEMO

    fun toAttachment(): AttachmentRef = AttachmentRef(id, remoteId, name, kind, sizeBytes)
}
