package com.dashworldng.ai.core.sync

import com.dashworldng.ai.core.data.ConversationRepository
import com.dashworldng.ai.core.model.AssistantMode
import com.dashworldng.ai.core.model.ChatMessage
import com.dashworldng.ai.core.model.Conversation
import com.dashworldng.ai.core.model.FinishReason
import com.dashworldng.ai.core.model.MessageRole
import com.dashworldng.ai.core.model.MessageStatus
import com.dashworldng.ai.core.model.ProviderId
import com.dashworldng.ai.core.remote.ConversationMessageDto
import com.dashworldng.ai.core.remote.DashApiClient
import com.dashworldng.ai.core.remote.SyncChangeDto
import com.dashworldng.ai.core.remote.SyncPageDto
import com.dashworldng.ai.core.remote.UpdateConversationRequestDto
import com.dashworldng.ai.core.stream.ApiException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.time.OffsetDateTime

/** The server operations sync needs. [DashApiSyncRemote] talks to the API; tests use fakes. */
interface SyncRemote {
    suspend fun changes(cursor: String, limit: Int): SyncPageDto
    suspend fun deleteConversation(id: String)
    suspend fun renameConversation(id: String, title: String)
}

class DashApiSyncRemote(private val client: DashApiClient) : SyncRemote {
    override suspend fun changes(cursor: String, limit: Int): SyncPageDto = client.call { syncConversations(cursor, limit) }
    override suspend fun deleteConversation(id: String) = client.callNoContent { deleteConversation(id) }
    override suspend fun renameConversation(id: String, title: String) {
        client.call { renameConversation(id, UpdateConversationRequestDto(title)) }
    }
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
)

/**
 * Server → device conversation sync. Room (via [ConversationRepository]) stays the local cache the
 * UI reads; this service only pulls what the server holds and merges it in.
 *
 * Deterministic merge rules (the same inputs always give the same result; see docs/sync.md):
 *
 *  1. Demo conversations are never touched.
 *  2. A conversation the user deleted locally but whose deletion the server has not confirmed is
 *     skipped: the local deletion wins and is re-sent first on every sync.
 *  3. A server tombstone deletes the local conversation and its messages. Deletion wins over any
 *     local content (there is no undelete), and tombstones are idempotent.
 *  4. A server conversation with no local copy is inserted with all its messages.
 *  5. When both exist: mode, creation time and the message set come from the server; the title is
 *     the server's unless a local rename is still unconfirmed (then the local title wins and is
 *     re-sent); `updatedAt` is the later of the two so ordering never moves backwards.
 *  6. Messages merge by id. A message on both sides takes the server's content, status, origin and
 *     model, but keeps device-only fields (attachments, routing reason, model choice, error text).
 *     A message only on the device is kept: a pull never deletes local messages.
 *  7. A pull is skipped while a response is being generated, so a stream is never overwritten.
 *
 * The cursor advances only after a whole page has been applied, so an interrupted sync resumes
 * safely, and applying the same page twice changes nothing.
 */
class ConversationSyncService(
    private val remote: SyncRemote,
    private val conversations: ConversationRepository,
    private val state: SyncStateStore,
    private val canSync: () -> Boolean = { true },
    private val pageSize: Int = 20,
) {
    private val lock = Mutex()

    /** Flushes unconfirmed local deletions/renames, then pulls every change after the saved cursor. */
    suspend fun sync(userId: String): SyncResult = lock.withLock {
        if (!canSync()) return SyncResult(cursor = state.load().cursor, deferred = true)
        var current = state.load().let { if (it.userId != userId) SyncState(userId = userId) else it }
        state.save(current)
        current = flushPending(current)

        var result = SyncResult(cursor = current.cursor)
        var restarted = false
        while (true) {
            val page = remote.changes(current.cursor, pageSize)
            if (!restarted && current.cursor.toLongOrNull()?.let { it > (page.latest.toLongOrNull() ?: 0L) } == true) {
                // The server's history is older than our cursor (e.g. restored from backup): start over.
                restarted = true
                current = current.copy(cursor = "0")
                state.save(current)
                continue
            }
            for (change in page.changes) result = applyChange(change, current, result)
            current = current.copy(cursor = page.cursor)
            state.save(current)
            result = result.copy(cursor = current.cursor)
            if (!page.hasMore) break
        }
        result
    }

    /** The user deleted a conversation on this device. Mirrors it to the server or remembers to. */
    suspend fun onLocalDelete(userId: String, id: String) = lock.withLock {
        var current = state.load().let { if (it.userId != userId) SyncState(userId = userId) else it }
        current = current.copy(pendingDeletes = current.pendingDeletes + id, pendingRenames = current.pendingRenames - id)
        state.save(current)
        state.save(flushPending(current))
    }

    /** The user renamed a conversation on this device. */
    suspend fun onLocalRename(userId: String, id: String, title: String) = lock.withLock {
        var current = state.load().let { if (it.userId != userId) SyncState(userId = userId) else it }
        current = current.copy(pendingRenames = current.pendingRenames + (id to title))
        state.save(current)
        state.save(flushPending(current))
    }

    private suspend fun flushPending(start: SyncState): SyncState {
        var current = start
        for (id in start.pendingDeletes) {
            if (attempt { remote.deleteConversation(id) }) current = current.copy(pendingDeletes = current.pendingDeletes - id)
        }
        for ((id, title) in start.pendingRenames) {
            if (id in current.pendingDeletes) continue
            if (attempt { remote.renameConversation(id, title) }) current = current.copy(pendingRenames = current.pendingRenames - id)
        }
        return current
    }

    /** True when the server has settled the operation: done, or the conversation does not exist (404). */
    private suspend fun attempt(block: suspend () -> Unit): Boolean = try {
        block()
        true
    } catch (e: ApiException) {
        e.httpStatus == 404
    }

    private suspend fun applyChange(change: SyncChangeDto, state: SyncState, so: SyncResult): SyncResult {
        val id = change.conversation.id
        val local = conversations.getConversation(id)
        if (local?.isDemo == true) return so
        if (id in state.pendingDeletes) return so.copy(skippedPendingDelete = so.skippedPendingDelete + 1)

        if (change.deleted) {
            if (local == null) return so
            conversations.deleteConversation(id)
            return so.copy(deleted = so.deleted + 1, deletedIds = so.deletedIds + id)
        }

        val server = change.conversation
        val localMessages = if (local != null) conversations.getMessages(id).associateBy { it.id } else emptyMap()
        val pendingTitle = state.pendingRenames[id]
        val serverUpdated = parseTime(server.updatedAt)
        val merged = Conversation(
            id = id,
            title = pendingTitle ?: server.title,
            mode = AssistantMode.fromWire(server.mode) ?: local?.mode ?: AssistantMode.GENERAL,
            createdAt = parseTime(server.createdAt),
            updatedAt = maxOf(serverUpdated, local?.updatedAt ?: 0L),
            titleIsCustom = if (pendingTitle != null) true else server.titleIsCustom,
            isDemo = false,
        )
        conversations.upsertConversation(merged)
        for (message in mapMessages(id, change.messages, localMessages)) conversations.upsertMessage(message)
        return if (local == null) so.copy(inserted = so.inserted + 1) else so.copy(updated = so.updated + 1)
    }

    private fun mapMessages(conversationId: String, server: List<ConversationMessageDto>, local: Map<String, ChatMessage>): List<ChatMessage> {
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
                createdAt = parseTime(dto.createdAt),
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
            )
        }
    }

    private fun parseTime(iso: String): Long = OffsetDateTime.parse(iso).toInstant().toEpochMilli()
}
