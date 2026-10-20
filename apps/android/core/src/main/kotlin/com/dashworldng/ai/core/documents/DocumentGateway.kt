package com.dashworldng.ai.core.documents

import com.dashworldng.ai.core.model.DocumentItem
import com.dashworldng.ai.core.model.DocumentStatus
import com.dashworldng.ai.core.stream.ApiError
import com.dashworldng.ai.core.stream.ApiException
import com.dashworldng.ai.core.util.Clock
import com.dashworldng.ai.core.util.IdGenerator
import kotlinx.coroutines.delay
import java.io.InputStream

/** A file chosen by the user. [open] is only called when the bytes are actually uploaded. */
class UploadSource(
    val name: String,
    val mimeType: String?,
    val sizeBytes: Long,
    val open: () -> InputStream,
)

interface DocumentGateway {
    val isDemo: Boolean

    /** Validates and uploads a file, reporting progress from 0 to 1. Throws [ApiException] on failure. */
    suspend fun upload(source: UploadSource, onProgress: (Float) -> Unit): DocumentItem

    suspend fun delete(document: DocumentItem)
}

/**
 * Demo Mode documents: the file is validated by name, type and size only. Its contents are never
 * read, uploaded or analysed, and the resulting document is labelled accordingly.
 */
class DemoDocumentGateway(
    private val stepDelayMillis: Long = 60,
    private val clock: Clock = Clock.System,
    private val ids: IdGenerator = IdGenerator.Uuid,
) : DocumentGateway {
    override val isDemo: Boolean = true

    override suspend fun upload(source: UploadSource, onProgress: (Float) -> Unit): DocumentItem {
        val kind = when (val check = FileRules.check(source.name, source.mimeType, source.sizeBytes)) {
            is FileCheck.Ok -> check.kind
            is FileCheck.Rejected -> throw ApiException(ApiError(check.code, check.message, retryable = false))
        }
        for (step in 1..10) {
            delay(stepDelayMillis)
            onProgress(step / 10f)
        }
        return DocumentItem(
            id = ids.newId(),
            remoteId = null,
            name = source.name,
            kind = kind,
            mimeType = FileRules.canonicalMimeType(kind, source.name),
            sizeBytes = source.sizeBytes,
            status = DocumentStatus.DEMO,
            statusDetail = "Demo Mode: checked on this device only. The contents were not uploaded or analysed.",
            createdAt = clock.now(),
            isDemo = true,
            progress = 1f,
        )
    }

    override suspend fun delete(document: DocumentItem) = Unit
}

/** How removing a document ended. A failure keeps it listed, so the person can try again. */
sealed interface DocumentRemoval {
    data object Removed : DocumentRemoval
    data class Failed(val message: String) : DocumentRemoval

    companion object {
        /**
         * Removes [document] from the DASH AI server first when it is stored there, and from this device
         * only once that worked (a document the server no longer has counts as removed). Nothing is
         * reported as removed while the server still holds the document's text.
         */
        suspend fun remove(
            document: DocumentItem,
            demoMode: Boolean,
            server: () -> DocumentGateway,
            deleteLocal: suspend (String) -> Unit,
        ): DocumentRemoval {
            if (!document.isDemo && document.remoteId != null) {
                if (demoMode) return Failed("Turn off Demo Mode to remove a document stored on the DASH AI server.")
                try {
                    server().delete(document)
                } catch (e: ApiException) {
                    if (e.error.code != "not_found") {
                        return Failed("“${document.name}” couldn't be removed from the DASH AI server. ${e.error.message}")
                    }
                }
            }
            deleteLocal(document.id)
            return Removed
        }
    }
}
