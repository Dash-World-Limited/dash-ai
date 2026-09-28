package com.dashworldng.ai.core.documents

import com.dashworldng.ai.core.Limits
import com.dashworldng.ai.core.model.DocumentKind
import java.util.Locale

data class FileRule(val kind: DocumentKind, val extensions: List<String>, val mimeTypes: List<String>)

sealed interface FileCheck {
    data class Ok(val kind: DocumentKind) : FileCheck

    data class Rejected(val code: String, val message: String) : FileCheck
}

/** Mirror of FILE_RULES in packages/contracts (checked against fixtures/file-rules.json). */
object FileRules {
    const val MAX_UPLOAD_BYTES: Long = Limits.MAX_UPLOAD_BYTES

    val rules: List<FileRule> = listOf(
        FileRule(DocumentKind.PDF, listOf("pdf"), listOf("application/pdf")),
        FileRule(
            DocumentKind.DOCX,
            listOf("docx"),
            listOf("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
        ),
        FileRule(DocumentKind.TXT, listOf("txt"), listOf("text/plain")),
        FileRule(DocumentKind.IMAGE, listOf("png", "jpg", "jpeg", "webp"), listOf("image/png", "image/jpeg", "image/webp")),
    )

    /** MIME types offered to the Android document picker. */
    val pickerMimeTypes: Array<String> = rules.flatMap { it.mimeTypes }.toTypedArray()

    fun check(name: String, mimeType: String?, sizeBytes: Long): FileCheck {
        if (sizeBytes <= 0) return FileCheck.Rejected("bad_request", "The file is empty.")
        if (sizeBytes > MAX_UPLOAD_BYTES) return FileCheck.Rejected("payload_too_large", "Files must be 10 MB or smaller.")
        val ext = name.substringAfterLast('.', "").lowercase(Locale.ROOT)
        val mime = (mimeType ?: "application/octet-stream").substringBefore(';').trim().lowercase(Locale.ROOT)
        val rule = rules.firstOrNull { ext in it.extensions }
            ?: return FileCheck.Rejected("unsupported_media_type", "Only PDF, DOCX, TXT, PNG, JPG and WEBP files are supported.")
        if (mime !in rule.mimeTypes && mime != "application/octet-stream") {
            return FileCheck.Rejected("unsupported_media_type", "The file type does not match its extension.")
        }
        return FileCheck.Ok(rule.kind)
    }

    fun canonicalMimeType(kind: DocumentKind, name: String): String {
        val ext = name.substringAfterLast('.', "").lowercase(Locale.ROOT)
        return when (kind) {
            DocumentKind.PDF -> "application/pdf"
            DocumentKind.DOCX -> "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            DocumentKind.TXT -> "text/plain"
            DocumentKind.IMAGE -> when (ext) {
                "png" -> "image/png"
                "webp" -> "image/webp"
                else -> "image/jpeg"
            }
        }
    }

    fun formatSize(bytes: Long): String = when {
        bytes >= 1024 * 1024 -> String.format(Locale.US, "%.1f MB", bytes / (1024.0 * 1024.0))
        bytes >= 1024 -> String.format(Locale.US, "%.0f KB", bytes / 1024.0)
        else -> "$bytes B"
    }
}
