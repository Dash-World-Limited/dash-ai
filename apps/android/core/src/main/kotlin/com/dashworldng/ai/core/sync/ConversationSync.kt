package com.dashworldng.ai.core.sync

import com.dashworldng.ai.core.Limits
import com.dashworldng.ai.core.data.ConversationRepository
import com.dashworldng.ai.core.model.AssistantMode
import com.dashworldng.ai.core.model.ChatMessage
import com.dashworldng.ai.core.model.Conversation
import com.dashworldng.ai.core.model.FinishReason
import com.dashworldng.ai.core.model.MessageRole
import com.dashworldng.ai.core.model.MessageStatus
import com.dashworldng.ai.core.model.ProviderId
import com.dashworldng.ai.core.model.ToolCallStatus
import com.dashworldng.ai.core.model.ToolUse
import com.dashworldng.ai.core.remote.ConversationMessageDto
import com.dashworldng.ai.core.remote.DashApiClient
import com.dashworldng.ai.core.remote.PushConversationDto
import com.dashworldng.ai.core.remote.PushMessageDto
import com.dashworldng.ai.core.remote.SyncChangeDto
import com.dashworldng.ai.core.remote.SyncOperationDto
import com.dashworldng.ai.core.remote.SyncOperationResultDto
import com.dashworldng.ai.core.remote.SyncPageDto
import com.dashworldng.ai.core.remote.SyncPushRequestDto
import com.dashworldng.ai.core.remote.SyncPushResponseDto
import com.dashworldng.ai.core.stream.ApiError
import com.dashworldng.ai.core.stream.ApiException
import com.dashworldng.ai.core.util.IdGenerator
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.time.Instant
import java.time.OffsetDateTime

/** The server operations sync needs. [DashApiSyncRemote] talks to the API; tests use fakes. */
interface SyncRemote {
    suspend fun changes(cursor: String, limit: Int): SyncPageDto
    suspend fun push(request: SyncPushRequestDto): SyncPushResponseDto
}

class DashApiSyncRemote(private val client: DashApiClient) : SyncRemote {
    override suspend fun changes(cursor: String, limit: Int): SyncPageDto = client.call { syncConversations(cursor, limit) }
    override suspend fun push(request: SyncPushRequestDto): SyncPushResponseDto = client.call { syncPush(request) }
}

data class SyncResult(
    val inserted: Int = 0,
    val updated: Int = 0,
    val deleted: Int = 0,
    /** Server changes ignored because the user deleted that conversation locally and it is not confirmed yet. */
    val skippedPendingDelete: Int = 0,
    /** Ids removed from this device because they were deleted elsewhere. */
    val deletedIds: Set<String> = emptySet(),
    val cursor: String = "0",
    /** True when the pull was not attempted because a response was being generated. */
    val deferred: Boolean = false,
    /** Operations the server accepted (applied, or already true). */
    val pushed: Int = 0,
    /** Stale renames that lost to a newer title on the server (the server title is kept). */
    val renameConflicts: Int = 0,
    /** Uploads refused because the id is not available to this account (the local copy is kept). */
    val rejectedUploads: Set<String> = emptySet(),
    /** Operations the server refused as invalid; dropped so they cannot block sync forever. */
    val droppedOperations: Int = 0,
    /** Server changes that could not be understood and were skipped. */
    val malformedChanges: Int = 0,
)

/**
 * Two-way conversation sync between Room (via [ConversationRepository], the local cache the UI reads)
 * and the server. Every sync first pushes this device's pending work, then pulls server changes.
 *
 * Deterministic rules (the same inputs always give the same result; see docs/sync.md):
 *
 *  Push (device → server)
 *  1. Only conversations marked by [onLocalConversationChanged] while signed in to the same account are
 *     uploaded, and only their user messages; the server creates assistant messages itself.
 *  2. Deletes go first, then uploads, then renames. A pending delete cancels any upload or rename of
 *     the same conversation.
 *  3. Every operation is idempotent on the server, so a retry after a lost response is always safe.
 *  4. Network, rate-limit and server errors keep the operation for the next sync. An operation the server
 *     rejects as invalid is dropped so it cannot block sync forever.
 *  5. A rename carries the title revision the device last pulled: a stale rename loses to a newer title
 *     on the server (it is dropped and the server title is pulled).
 *  6. "deleted" from the server deletes the local copy and every pending operation for it; "rejected"
 *     keeps the local copy but never retries the upload.
 *
 *  Pull (server → device)
 *  7. Demo conversations are never touched.
 *  8. A conversation deleted locally but not yet confirmed is skipped (never resurrected).
 *  9. A server tombstone deletes the local conversation and its messages; there is no undelete.
 * 10. A new server conversation is inserted with all its messages.
 * 11. When both exist: mode, creation time and the message set come from the server; the title is the
 *     server's unless a local rename is still unconfirmed; `updatedAt` never moves backwards.
 * 12. Messages merge by id: server content wins, device-only fields (attachments, routing reason, model
 *     choice, error text) are kept, and messages only on the device are never deleted by a pull.
 * 13. Nothing syncs while a response is being generated.
 * 14. Another account starts from scratch: cursor, revisions and pending work are dropped.
 * 15. A sync for an account that is no longer the device's owner (signed out meanwhile) writes nothing.
 *
 * The cursor advances only after a whole page has been applied. A change that cannot be understood is
 * skipped and counted (otherwise one bad record would block sync forever); a page that does not move
 * the cursor forward is rejected.
 */
class ConversationSyncService(
    private val remote: SyncRemote,
    private val conversations: ConversationRepository,
    private val state: SyncStateStore,
    private val canSync: () -> Boolean = { true },
    private val pageSize: Int = 20,
    private val ids: IdGenerator = IdGenerator.Uuid,
    /**
     * Whether [userId]'s data is still the data on this device (see LocalAccountGuard). Checked before
     * a sync starts and before each change is written, so a sync that was running when the account
     * signed out writes nothing more.
     */
    private val isOwner: suspend (userId: String) -> Boolean = { true },
) {
    private val lock = Mutex()

    /** Runs [block] while no sync is running (and none can start): used to wipe data safely. */
    suspend fun exclusive(block: suspend () -> Unit) = lock.withLock { block() }

    /** Pushes pending local work, then pulls every change after the saved cursor. */
    suspend fun sync(userId: String): SyncResult = lock.withLock {
        if (!canSync() || !isOwner(userId)) return SyncResult(cursor = state.load().cursor, deferred = true)
        var result = SyncResult()
        var current = loadFor(userId)
        state.save(current)

        val pushed = push(current, result)
        current = pushed.first
        result = pushed.second

        var restarted = false
        while (true) {
            val page = remote.changes(current.cursor, pageSize)
            val from = current.cursor.toLongOrNull() ?: 0L
            val latest = page.latest.toLongOrNull()
            if (!restarted && latest != null && from > latest) {
                // The server's history is older than our cursor (e.g. restored from backup): start over.
                restarted = true
                current = current.copy(cursor = "0")
                state.save(current)
                continue
            }
            val next = page.cursor.toLongOrNull()
            if (next == null || next < from || (page.hasMore && next == from)) {
                throw ApiException(ApiError("bad_response", "The server sent an invalid sync position.", retryable = true))
            }
            for (change in page.changes) {
                // The account signed out while this page was downloading: write nothing, keep no state.
                if (!isOwner(userId)) return SyncResult(cursor = "0", deferred = true)
                val applied = applyChange(change, current, result)
                current = applied.first
                result = applied.second
            }
            if (!isOwner(userId)) return SyncResult(cursor = "0", deferred = true)
            current = current.copy(cursor = page.cursor)
            state.save(current)
            result = result.copy(cursor = current.cursor)
            if (!page.hasMore) break
        }
        result
    }

    /** A conversation was created or extended on this device: upload it at the next sync. */
    suspend fun onLocalConversationChanged(userId: String, id: String) = lock.withLock {
        if (!isOwner(userId)) return@withLock
        val current = loadFor(userId)
        if (id in current.pendingDeletes) return@withLock
        state.save(current.copy(pendingUploads = current.pendingUploads + id))
    }

    /** The user deleted a conversation on this device. Sends it now if possible; otherwise remembers it. */
    suspend fun onLocalDelete(userId: String, id: String) = lock.withLock {
        if (!isOwner(userId)) return@withLock
        val current = loadFor(userId)
        val next = current.forget(id).copy(pendingDeletes = current.pendingDeletes + id, titleRevs = current.titleRevs)
        state.save(next)
        state.save(push(next, SyncResult()).first)
    }

    /** The user renamed a conversation on this device. Sends it now if possible; otherwise remembers it. */
    suspend fun onLocalRename(userId: String, id: String, title: String) = lock.withLock {
        if (!isOwner(userId)) return@withLock
        val current = loadFor(userId)
        if (id in current.pendingDeletes) return@withLock
        val base = current.titleRevs[id]
        val next = current.copy(
            pendingRenames = current.pendingRenames + (id to title),
            renameBases = if (base != null) current.renameBases + (id to base) else current.renameBases - id,
        )
        state.save(next)
        state.save(push(next, SyncResult()).first)
    }

    private suspend fun loadFor(userId: String): SyncState =
        state.load().let { if (it.userId != userId) SyncState(userId = userId) else it }

    // ---- push ----------------------------------------------------------------------------------------

    private sealed interface Pending {
        val id: String
        data class Delete(override val id: String) : Pending
        data class Upload(override val id: String) : Pending
        data class Rename(override val id: String, val title: String) : Pending
    }

    /** Sends pending operations one per request, so one bad operation can never block the others. */
    private suspend fun push(start: SyncState, startResult: SyncResult): Pair<SyncState, SyncResult> {
        var current = start
        var result = startResult
        val queue = start.pendingDeletes.sorted().map { Pending.Delete(it) } +
            start.pendingUploads.filter { it !in start.pendingDeletes }.sorted().map { Pending.Upload(it) } +
            start.pendingRenames.filterKeys { it !in start.pendingDeletes }.toSortedMap().map { (id, title) -> Pending.Rename(id, title) }

        for (op in queue) {
            val dto = buildOperation(op, current)
            if (dto == null) {
                // Nothing to upload (conversation gone locally, demo, or no user messages): forget it.
                current = current.copy(pendingUploads = current.pendingUploads - op.id)
                state.save(current)
                continue
            }
            val outcome: SyncOperationResultDto = try {
                remote.push(SyncPushRequestDto(listOf(dto))).results.singleOrNull { it.opId == dto.opId }
                    ?: throw ApiException(ApiError("bad_response", "The server sent an invalid sync result.", retryable = true))
            } catch (e: ApiException) {
                if (isPermanent(e)) {
                    current = dropOperation(current, op)
                    result = result.copy(droppedOperations = result.droppedOperations + 1)
                    state.save(current)
                    continue
                }
                if (e.httpStatus == 401) throw e
                // Offline, rate limited or the server is unwell: keep everything for the next sync.
                break
            }
            val handled = applyOutcome(op, outcome.status, current, result)
            current = handled.first
            result = handled.second
            state.save(current)
        }
        return current to result
    }

    private fun isPermanent(e: ApiException): Boolean {
        val status = e.httpStatus ?: return false
        return status in 400..499 && status != 401 && status != 408 && status != 429
    }

    private fun dropOperation(s: SyncState, op: Pending): SyncState = when (op) {
        is Pending.Delete -> s.copy(pendingDeletes = s.pendingDeletes - op.id)
        is Pending.Upload -> s.copy(pendingUploads = s.pendingUploads - op.id)
        is Pending.Rename -> s.copy(pendingRenames = s.pendingRenames - op.id, renameBases = s.renameBases - op.id)
    }

    private suspend fun buildOperation(op: Pending, s: SyncState): SyncOperationDto? = when (op) {
        is Pending.Delete -> SyncOperationDto(opId = ids.newId(), type = "delete", conversationId = op.id)
        is Pending.Rename -> SyncOperationDto(
            opId = ids.newId(),
            type = "rename",
            conversationId = op.id,
            title = op.title.trim().take(Limits.MAX_TITLE_CHARS),
            baseTitleRev = s.renameBases[op.id],
        )
        is Pending.Upload -> {
            val conversation = conversations.getConversation(op.id)
            if (conversation == null || conversation.isDemo) {
                null
            } else {
                val messages = conversations.getMessages(op.id)
                    .filter { it.isUser && !it.isDemo && it.content.isNotBlank() && it.content.length <= Limits.MAX_MESSAGE_CHARS }
                    .sortedWith(compareBy({ it.createdAt }, { it.id }))
                    .takeLast(MAX_UPLOAD_MESSAGES)
                    .map { PushMessageDto(it.id, it.content, iso(it.createdAt)) }
                if (messages.isEmpty()) {
                    null
                } else {
                    SyncOperationDto(
                        opId = ids.newId(),
                        type = "upload",
                        conversation = PushConversationDto(
                            id = conversation.id,
                            title = conversation.title.take(Limits.MAX_TITLE_CHARS),
                            titleIsCustom = conversation.titleIsCustom,
                            mode = conversation.mode.wire,
                            createdAt = iso(conversation.createdAt),
                        ),
                        messages = messages,
                    )
                }
            }
        }
    }

    private suspend fun applyOutcome(op: Pending, status: String, s: SyncState, r: SyncResult): Pair<SyncState, SyncResult> {
        if (status == "deleted") {
            // Deleted on the server: delete here too and forget everything about it (never resurrect).
            val local = conversations.getConversation(op.id)
            if (local != null && !local.isDemo) conversations.deleteConversation(op.id)
            return s.forget(op.id) to r.copy(
                deleted = r.deleted + if (local != null) 1 else 0,
                deletedIds = r.deletedIds + op.id,
                pushed = r.pushed + 1,
            )
        }
        val next = dropOperation(s, op)
        return when {
            op is Pending.Rename && status == "conflict" -> next to r.copy(renameConflicts = r.renameConflicts + 1)
            op is Pending.Upload && status == "rejected" -> next to r.copy(rejectedUploads = r.rejectedUploads + op.id)
            else -> next to r.copy(pushed = r.pushed + 1)
        }
    }

    // ---- pull ----------------------------------------------------------------------------------------

    private suspend fun applyChange(change: SyncChangeDto, s: SyncState, so: SyncResult): Pair<SyncState, SyncResult> {
        val id = change.conversation.id
        val local = conversations.getConversation(id)
        if (local?.isDemo == true) return s to so
        if (id in s.pendingDeletes) return s to so.copy(skippedPendingDelete = so.skippedPendingDelete + 1)

        if (change.deleted) {
            val cleared = s.forget(id)
            if (local == null) return cleared to so
            conversations.deleteConversation(id)
            return cleared to so.copy(deleted = so.deleted + 1, deletedIds = so.deletedIds + id)
        }

        val parsed = parse(change) ?: return s to so.copy(malformedChanges = so.malformedChanges + 1)
        val server = change.conversation
        val localMessages = if (local != null) conversations.getMessages(id).associateBy { it.id } else emptyMap()
        val pendingTitle = s.pendingRenames[id]
        val merged = Conversation(
            id = id,
            title = pendingTitle ?: server.title,
            mode = AssistantMode.fromWire(server.mode) ?: local?.mode ?: AssistantMode.GENERAL,
            createdAt = parsed.createdAt,
            updatedAt = maxOf(parsed.updatedAt, local?.updatedAt ?: 0L),
            titleIsCustom = if (pendingTitle != null) true else server.titleIsCustom,
            isDemo = false,
        )
        conversations.upsertConversation(merged)
        val tools = toolsByMessage(change)
        for (message in mapMessages(id, change.messages, parsed.messageTimes, localMessages, tools)) conversations.upsertMessage(message)
        val next = s.copy(titleRevs = s.titleRevs + (id to server.titleRev))
        return next to if (local == null) so.copy(inserted = so.inserted + 1) else so.copy(updated = so.updated + 1)
    }

    private class Parsed(val createdAt: Long, val updatedAt: Long, val messageTimes: Map<String, Long>)

    /** Validates a change before anything is written, so a bad record never half-applies. */
    private fun parse(change: SyncChangeDto): Parsed? {
        val createdAt = parseTime(change.conversation.createdAt) ?: return null
        val updatedAt = parseTime(change.conversation.updatedAt) ?: return null
        if (change.conversation.id.isBlank()) return null
        val times = HashMap<String, Long>()
        for (m in change.messages) {
            if (m.id.isBlank() || (m.role != "user" && m.role != "assistant")) return null
            times[m.id] = parseTime(m.createdAt) ?: return null
        }
        return Parsed(createdAt, updatedAt, times)
    }

    private fun mapMessages(
        conversationId: String,
        server: List<ConversationMessageDto>,
        times: Map<String, Long>,
        local: Map<String, ChatMessage>,
        tools: Map<String, List<ToolUse>>,
    ): List<ChatMessage> {
        var lastUserId: String? = null
        return server.map { dto ->
            val role = if (dto.role == "user") MessageRole.USER else MessageRole.ASSISTANT
            if (role == MessageRole.USER) lastUserId = dto.id
            val existing = local[dto.id]
            val status = when (dto.status) {
                "stopped" -> MessageStatus.STOPPED
                "failed" -> MessageStatus.FAILED
                else -> MessageStatus.COMPLETE
            }
            ChatMessage(
                id = dto.id,
                conversationId = conversationId,
                role = role,
                content = dto.content,
                createdAt = times.getValue(dto.id),
                status = status,
                provider = dto.origin?.let { ProviderId.fromWire(it) },
                model = dto.model,
                isDemo = dto.demo,
                // Device-only fields survive a merge; for new messages they are inferred or left empty.
                modelChoice = existing?.modelChoice,
                compareGroupId = dto.compareGroupId,
                replyToId = existing?.replyToId ?: if (role == MessageRole.ASSISTANT) dto.compareGroupId ?: lastUserId else null,
                attachments = existing?.attachments ?: emptyList(),
                errorMessage = existing?.errorMessage ?: if (status == MessageStatus.FAILED) "This response failed. You can try again." else null,
                errorRetryable = existing?.errorRetryable ?: (status == MessageStatus.FAILED),
                finishReason = existing?.finishReason ?: if (status == MessageStatus.STOPPED) FinishReason.CANCELLED else null,
                routingReason = existing?.routingReason,
                // The server's record wins; an older server sends none, so what this device saved is kept.
                tools = tools[dto.id] ?: existing?.tools.orEmpty(),
            )
        }
    }

    /** The recorded tool calls of a change, by message. Only messages in the change are kept. */
    private fun toolsByMessage(change: SyncChangeDto): Map<String, List<ToolUse>> {
        val ids = change.messages.mapTo(HashSet()) { it.id }
        return change.toolActivity
            .filter { it.messageId in ids }
            .groupBy({ it.messageId }) { ToolUse(it.callId, it.plugin, it.tool, ToolCallStatus.fromWire(it.status), it.durationMs) }
    }

    private fun parseTime(iso: String): Long? = runCatching { OffsetDateTime.parse(iso).toInstant().toEpochMilli() }.getOrNull()

    private fun iso(epochMillis: Long): String = Instant.ofEpochMilli(epochMillis).toString()

    companion object {
        /** Matches the server's per-upload limit. */
        const val MAX_UPLOAD_MESSAGES = 100
    }
}
