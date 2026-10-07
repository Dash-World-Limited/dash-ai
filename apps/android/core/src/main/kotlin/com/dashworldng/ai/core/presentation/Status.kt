package com.dashworldng.ai.core.presentation

import com.dashworldng.ai.core.model.DocumentItem
import com.dashworldng.ai.core.model.DocumentKind
import com.dashworldng.ai.core.model.DocumentStatus
import com.dashworldng.ai.core.stream.ApiError
import com.dashworldng.ai.core.util.Clock
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/** Colour family of a status badge; the app maps it to semantic colours. */
enum class StatusTone { NEUTRAL, PROGRESS, SUCCESS, WARNING, ERROR }

data class StatusLabel(val text: String, val tone: StatusTone)

// ---- Sync ---------------------------------------------------------------------------------------

/** What this app session knows about sync for one account. Nothing is persisted or invented. */
data class SyncSnapshot(
    val userId: String? = null,
    val running: Boolean = false,
    /** Last successful sync in this app session; null until one completes. */
    val lastSuccessAt: Long? = null,
    val lastError: String? = null,
)

class SyncTracker(private val clock: Clock = Clock.System) {
    private val state = MutableStateFlow(SyncSnapshot())
    val snapshot: StateFlow<SyncSnapshot> = state.asStateFlow()

    fun started(userId: String) = state.update { s ->
        if (s.userId == userId) s.copy(running = true) else SyncSnapshot(userId = userId, running = true)
    }

    fun succeeded(userId: String) = state.update { s ->
        if (s.userId == userId) s.copy(running = false, lastSuccessAt = clock.now(), lastError = null) else s
    }

    /** The sync was postponed (an answer is streaming): nothing changed, nothing is claimed. */
    fun deferred(userId: String) = state.update { s -> if (s.userId == userId) s.copy(running = false) else s }

    fun failed(userId: String, message: String) = state.update { s ->
        if (s.userId == userId) s.copy(running = false, lastError = message) else s
    }

    /** Sign-out or account switch: nothing about the previous account is kept. */
    fun reset() {
        state.value = SyncSnapshot()
    }
}

enum class SyncStatusKind { LOCAL_ONLY, WAITING, SYNCING, SYNCED, OFFLINE, ISSUE }

data class SyncStatus(val kind: SyncStatusKind, val title: String, val detail: String, val lastSyncAt: Long?) {
    val tone: StatusTone
        get() = when (kind) {
            SyncStatusKind.SYNCED -> StatusTone.SUCCESS
            SyncStatusKind.SYNCING, SyncStatusKind.WAITING -> StatusTone.PROGRESS
            SyncStatusKind.OFFLINE -> StatusTone.WARNING
            SyncStatusKind.ISSUE -> StatusTone.ERROR
            SyncStatusKind.LOCAL_ONLY -> StatusTone.NEUTRAL
        }
}

object SyncStatuses {
    /** @param signedInUserId the live account, or null in Demo Mode / signed out. */
    fun derive(snapshot: SyncSnapshot, signedInUserId: String?, online: Boolean): SyncStatus {
        if (signedInUserId == null) {
            return SyncStatus(SyncStatusKind.LOCAL_ONLY, "On this device only", "Demo Mode conversations stay on this device and are never synced.", null)
        }
        val mine = snapshot.takeIf { it.userId == signedInUserId } ?: SyncSnapshot(signedInUserId)
        return when {
            !online -> SyncStatus(SyncStatusKind.OFFLINE, "Offline", "Changes are saved on this device and sync when you're back online.", mine.lastSuccessAt)
            mine.running -> SyncStatus(SyncStatusKind.SYNCING, "Syncing", "Bringing your conversations up to date.", mine.lastSuccessAt)
            mine.lastError != null -> SyncStatus(SyncStatusKind.ISSUE, "Sync issue", "${mine.lastError} Your conversations are still saved on this device.", mine.lastSuccessAt)
            mine.lastSuccessAt != null -> SyncStatus(SyncStatusKind.SYNCED, "Synced", "Your conversations are up to date with your account.", mine.lastSuccessAt)
            else -> SyncStatus(SyncStatusKind.WAITING, "Waiting to sync", "Conversations sync with your account automatically.", null)
        }
    }

    fun messageFor(error: ApiError): String = when (error.code) {
        "network" -> "The server couldn't be reached."
        "unauthorized" -> "Your session has ended. Sign in again to sync."
        "rate_limited" -> "Too many requests; sync will try again shortly."
        else -> "The last sync did not finish."
    }
}

// ---- Documents ----------------------------------------------------------------------------------

enum class DocumentFilter(val label: String, val kinds: Set<DocumentKind>) {
    ALL("All", DocumentKind.entries.toSet()),
    PDF("PDF", setOf(DocumentKind.PDF)),
    WORD("Word", setOf(DocumentKind.DOCX)),
    TEXT("Text", setOf(DocumentKind.TXT)),
    IMAGE("Images", setOf(DocumentKind.IMAGE)),
}

object Documents {
    val SUGGESTIONS = listOf("Summarise this document", "What are the key risks?", "Extract the major points")

    /** Only states the server reports. "Ready" means text was extracted, never "analysed". */
    fun status(document: DocumentItem): StatusLabel = when (document.status) {
        DocumentStatus.READY -> StatusLabel("Ready", StatusTone.SUCCESS)
        DocumentStatus.UPLOADING -> StatusLabel("Processing", StatusTone.PROGRESS)
        DocumentStatus.UNSUPPORTED -> StatusLabel("Unsupported", StatusTone.WARNING)
        DocumentStatus.FAILED -> StatusLabel("Failed", StatusTone.ERROR)
        DocumentStatus.DEMO -> StatusLabel("Demo · not uploaded", StatusTone.NEUTRAL)
    }

    /** Live mode can only use documents whose text the server extracted. */
    fun usableInChat(document: DocumentItem, demoMode: Boolean): Boolean =
        if (demoMode) document.canAttach else document.status == DocumentStatus.READY && document.remoteId != null

    /** "All" plus one filter per kind actually present, so no filter is ever empty. */
    fun filtersFor(documents: List<DocumentItem>): List<DocumentFilter> {
        val kinds = documents.map { it.kind }.toSet()
        val specific = DocumentFilter.entries.filter { it != DocumentFilter.ALL && it.kinds.any(kinds::contains) }
        return if (specific.size <= 1) emptyList() else listOf(DocumentFilter.ALL) + specific
    }

    fun filter(documents: List<DocumentItem>, filter: DocumentFilter, query: String): List<DocumentItem> {
        val q = query.trim()
        return documents.filter { d -> d.kind in filter.kinds && (q.isEmpty() || d.name.contains(q, ignoreCase = true)) }
    }

    fun formatSize(bytes: Long): String = when {
        bytes < 0 -> "Unknown size"
        bytes < 1024 -> "$bytes B"
        bytes < 1024 * 1024 -> "${(bytes + 512) / 1024} KB"
        else -> String.format(java.util.Locale.ROOT, "%.1f MB", bytes / (1024.0 * 1024.0))
    }
}

// ---- Auth ---------------------------------------------------------------------------------------

enum class AuthFailureKind { OFFLINE, INVALID_CREDENTIALS, ACCOUNT_EXISTS, RATE_LIMITED, SESSION_EXPIRED, SERVER }

data class AuthFailure(val kind: AuthFailureKind, val message: String, val canRetry: Boolean)

object AuthFailures {
    fun from(error: ApiError, online: Boolean = true): AuthFailure = when {
        !online || error.code == "network" -> AuthFailure(
            AuthFailureKind.OFFLINE,
            if (!online) "You're offline. Connect to the internet and try again." else "DASH AI couldn't reach the server. Check your connection and try again.",
            canRetry = true,
        )
        error.code == "conflict" -> AuthFailure(AuthFailureKind.ACCOUNT_EXISTS, error.message, canRetry = false)
        error.code == "rate_limited" -> AuthFailure(AuthFailureKind.RATE_LIMITED, error.message, canRetry = true)
        error.code == "unauthorized" && error.message.contains("expired", ignoreCase = true) ->
            AuthFailure(AuthFailureKind.SESSION_EXPIRED, "Your session has expired. Sign in again.", canRetry = false)
        error.code == "unauthorized" || error.code == "bad_request" -> AuthFailure(AuthFailureKind.INVALID_CREDENTIALS, error.message, canRetry = false)
        else -> AuthFailure(AuthFailureKind.SERVER, if (error.retryable) "DASH AI is having trouble right now. Try again in a moment." else error.message, canRetry = error.retryable)
    }
}
