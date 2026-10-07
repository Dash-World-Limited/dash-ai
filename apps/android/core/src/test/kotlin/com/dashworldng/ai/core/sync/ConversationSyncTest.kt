package com.dashworldng.ai.core.sync

import com.dashworldng.ai.core.Fixtures
import com.dashworldng.ai.core.data.InMemoryConversationRepository
import com.dashworldng.ai.core.model.AssistantMode
import com.dashworldng.ai.core.model.AttachmentRef
import com.dashworldng.ai.core.model.ChatMessage
import com.dashworldng.ai.core.model.Conversation
import com.dashworldng.ai.core.model.DocumentKind
import com.dashworldng.ai.core.model.FinishReason
import com.dashworldng.ai.core.model.MessageRole
import com.dashworldng.ai.core.model.MessageStatus
import com.dashworldng.ai.core.model.ModelChoice
import com.dashworldng.ai.core.model.ProviderId
import com.dashworldng.ai.core.model.ToolCallStatus
import com.dashworldng.ai.core.model.ToolUse
import com.dashworldng.ai.core.remote.ConversationMessageDto
import com.dashworldng.ai.core.remote.DashApiClient
import com.dashworldng.ai.core.remote.DashJson
import com.dashworldng.ai.core.remote.MessageToolActivityDto
import com.dashworldng.ai.core.remote.SyncChangeDto
import com.dashworldng.ai.core.remote.SyncConversationDto
import com.dashworldng.ai.core.remote.SyncOperationDto
import com.dashworldng.ai.core.remote.SyncOperationResultDto
import com.dashworldng.ai.core.remote.SyncPageDto
import com.dashworldng.ai.core.remote.SyncPushRequestDto
import com.dashworldng.ai.core.remote.SyncPushResponseDto
import com.dashworldng.ai.core.stream.ApiError
import com.dashworldng.ai.core.stream.ApiException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

private fun iso(offsetSeconds: Long) = Instant.parse("2026-03-04T05:00:00Z").plusSeconds(offsetSeconds).toString()
private fun ms(offsetSeconds: Long) = Instant.parse("2026-03-04T05:00:00Z").plusSeconds(offsetSeconds).toEpochMilli()

/**
 * An in-memory model of the server's sync API with the same rules as apps/api: per-user change
 * sequence, title revisions, tombstones, upload = create or append a newer tail of user messages,
 * compare-and-set renames, idempotent deletes, other users' ids rejected.
 */
private class FakeServer {
    class Msg(val dto: ConversationMessageDto)
    class Conv(val owner: String, var dto: SyncConversationDto, var messages: MutableList<ConversationMessageDto>, var deleted: Boolean, var seq: Long) {
        var tools: List<MessageToolActivityDto> = emptyList()
    }

    val conversations = linkedMapOf<String, Conv>()
    private val counters = mutableMapOf<String, Long>()
    var online = true
    var failPullAfterPages: Int? = null
    var pagesServed = 0
    /** Applies the push but then "loses" the response, like a dropped connection. */
    var loseNextPushResponse = false
    var rejectPushWith: Int? = null
    val pushes = mutableListOf<SyncOperationDto>()
    var overrideLatest: String? = null
    var pageOverride: ((SyncPageDto) -> SyncPageDto)? = null
    var resultOverride: ((SyncPushResponseDto) -> SyncPushResponseDto)? = null

    private fun bump(owner: String, c: Conv) {
        val n = (counters[owner] ?: 0L) + 1
        counters[owner] = n
        c.seq = n
    }

    /** Server-side writes made by "another device" or by chat on the server. */
    fun put(
        owner: String,
        id: String,
        title: String = "Chat $id",
        titleIsCustom: Boolean = false,
        mode: String = "general",
        messages: List<ConversationMessageDto> = emptyList(),
        tools: List<MessageToolActivityDto> = emptyList(),
    ) {
        val existing = conversations[id]
        if (existing == null) {
            val c = Conv(owner, SyncConversationDto(id, title, mode, iso(1_000), iso(2_000), titleIsCustom, 0), messages.toMutableList(), false, 0)
            c.tools = tools
            conversations[id] = c
            bump(owner, c)
        } else {
            val rev = if (existing.dto.title != title) existing.dto.titleRev + 1 else existing.dto.titleRev
            existing.dto = existing.dto.copy(title = title, titleIsCustom = titleIsCustom, mode = mode, titleRev = rev)
            existing.messages = messages.toMutableList()
            existing.tools = tools
            bump(owner, existing)
        }
    }

    fun tombstone(id: String) {
        val c = conversations[id] ?: return
        c.deleted = true
        c.messages = mutableListOf()
        c.dto = c.dto.copy(title = "")
        bump(c.owner, c)
    }

    fun remoteFor(user: String) = object : SyncRemote {
        override suspend fun changes(cursor: String, limit: Int): SyncPageDto {
            if (!online) throw ApiException(ApiError.network())
            failPullAfterPages?.let { if (pagesServed >= it) throw ApiException(ApiError.network()) }
            pagesServed += 1
            val after = cursor.toLong()
            val rows = conversations.values.filter { it.owner == user && it.seq > after }.sortedBy { it.seq }
            val page = rows.take(limit)
            val dto = SyncPageDto(
                changes = page.map { SyncChangeDto(it.seq, it.deleted, it.dto, it.messages.toList(), if (it.deleted) emptyList() else it.tools) },
                cursor = (page.lastOrNull()?.seq ?: after).toString(),
                latest = overrideLatest ?: (counters[user] ?: 0L).toString(),
                hasMore = rows.size > limit,
            )
            return pageOverride?.invoke(dto) ?: dto
        }

        override suspend fun push(request: SyncPushRequestDto): SyncPushResponseDto {
            if (!online) throw ApiException(ApiError.network())
            rejectPushWith?.let { throw ApiException(ApiError("bad_request", "invalid", false), it) }
            val results = request.operations.map { op -> pushes += op; SyncOperationResultDto(op.opId, apply(user, op).first, null, null) }
            if (loseNextPushResponse) {
                loseNextPushResponse = false
                throw ApiException(ApiError.network("connection reset"))
            }
            val response = SyncPushResponseDto(results)
            return resultOverride?.invoke(response) ?: response
        }
    }

    private fun apply(user: String, op: SyncOperationDto): Pair<String, Int> {
        val id = op.conversation?.id ?: op.conversationId!!
        val c = conversations[id]
        return when (op.type) {
            "upload" -> {
                if (c != null && c.owner != user) return "rejected" to 0
                if (c?.deleted == true) return "deleted" to 0
                val conv = c ?: Conv(user, SyncConversationDto(id, op.conversation!!.title, op.conversation.mode, op.conversation.createdAt, op.conversation.createdAt, op.conversation.titleIsCustom, 0), mutableListOf(), false, 0)
                    .also { conversations[id] = it }
                val baseline = conv.messages.maxOfOrNull { Instant.parse(it.createdAt).toEpochMilli() } ?: Long.MIN_VALUE
                var appended = 0
                for (m in op.messages!!.sortedBy { it.createdAt }) {
                    if (conv.messages.any { it.id == m.id } || Instant.parse(m.createdAt).toEpochMilli() <= baseline) continue
                    conv.messages += ConversationMessageDto(m.id, "user", m.content, null, null, false, "complete", null, m.createdAt)
                    appended++
                }
                if (c == null || appended > 0) bump(user, conv)
                "applied" to appended
            }
            "rename" -> {
                if (c == null || c.owner != user) return "not_found" to 0
                if (c.deleted) return "deleted" to 0
                if (c.dto.title == op.title && c.dto.titleIsCustom) return "applied" to 0
                if (c.dto.titleIsCustom && op.baseTitleRev != c.dto.titleRev) return "conflict" to 0
                c.dto = c.dto.copy(title = op.title!!, titleIsCustom = true, titleRev = c.dto.titleRev + 1)
                bump(user, c)
                "applied" to 0
            }
            "delete" -> {
                if (c == null || c.owner != user) return "not_found" to 0
                if (!c.deleted) tombstone(id)
                "applied" to 0
            }
            else -> error("unknown op")
        }
    }
}

private fun user(id: String, text: String = "question", at: Long = 10) =
    ConversationMessageDto(id, "user", text, null, null, false, "complete", null, iso(at))

private fun assistant(id: String, text: String = "answer", provider: String = "openai", at: Long = 11, status: String = "complete", group: String? = null) =
    ConversationMessageDto(id, "assistant", text, provider, "model-$provider", false, status, group, iso(at))

/** Persists SyncState as a string, like SharedPreferences does, so "app restarts" can be simulated. */
private class StringSyncStateStore : SyncStateStore {
    var stored: String? = null
    override suspend fun load(): SyncState = SyncState.decode(stored)
    override suspend fun save(state: SyncState) {
        stored = SyncState.encode(state)
    }
}

private class Device(val server: FakeServer, val userId: String = "user-1", val store: SyncStateStore = InMemorySyncStateStore()) {
    val repo = InMemoryConversationRepository()
    var generating = false
    private var n = 0
    fun service(pageSize: Int = 20) = ConversationSyncService(server.remoteFor(userId), repo, store, canSync = { !generating }, pageSize = pageSize, ids = { "op-${++n}-xxxxxxxx" })
    suspend fun sync(pageSize: Int = 20) = service(pageSize).sync(userId)

    /** What the chat screen does when the user sends a message while the server is unreachable. */
    suspend fun writeOffline(conversationId: String, text: String, atSeconds: Long, title: String = "Offline chat", messageId: String = "m-$conversationId-$atSeconds") {
        if (repo.getConversation(conversationId) == null) {
            repo.upsertConversation(Conversation(conversationId, title, AssistantMode.GENERAL, ms(atSeconds), ms(atSeconds)))
        }
        repo.upsertMessage(ChatMessage(messageId, conversationId, MessageRole.USER, text, ms(atSeconds)))
        service().onLocalConversationChanged(userId, conversationId)
    }

    suspend fun snapshot() = repo.allConversations().sortedBy { it.id }.map { c -> c.copy(updatedAt = 0) to repo.getMessages(c.id).map { it.copy(createdAt = it.createdAt) } }
}

class ConversationSyncTest {
    private val server = FakeServer()
    private val device = Device(server)
    private val me = "user-1"

    // ---- first sync, repeated sync ------------------------------------------------------------------

    @Test
    fun `first sync pulls conversations with their messages`() = runBlocking<Unit> {
        server.put(me, "conv-1", title = "Plan", mode = "business", messages = listOf(user("u1"), assistant("a1")))
        server.put(me, "conv-2", messages = listOf(user("u2")))

        val result = device.sync()

        assertEquals(2, result.inserted)
        val c1 = assertNotNull(device.repo.getConversation("conv-1"))
        assertEquals("Plan", c1.title)
        assertEquals(AssistantMode.BUSINESS, c1.mode)
        assertEquals(ms(1_000), c1.createdAt)
        assertFalse(c1.isDemo)
        val messages = device.repo.getMessages("conv-1")
        assertEquals(listOf("u1", "a1"), messages.map { it.id })
        assertEquals(ProviderId.OPENAI, messages[1].provider)
        assertEquals("u1", messages[1].replyToId)
        assertEquals("2", result.cursor)
        assertEquals(mapOf("conv-1" to 0L, "conv-2" to 0L), device.store.load().titleRevs)
    }

    @Test
    fun `recorded tool activity arrives with its answer and only for messages in the change`() = runBlocking<Unit> {
        fun tool(message: String, call: String, status: String) = MessageToolActivityDto(message, call, "dash-demo", "text_stats", status, 4, iso(11))
        server.put(
            me,
            "conv-1",
            messages = listOf(user("u1"), assistant("a1")),
            tools = listOf(tool("a1", "call_1", "ok"), tool("a1", "call_2", "timeout"), tool("gone", "call_3", "ok")),
        )
        server.put(me, "conv-2", messages = listOf(user("u2"), assistant("a2")))

        device.sync()

        val answer = device.repo.getMessages("conv-1").single { it.id == "a1" }
        assertEquals(
            listOf(ToolUse("call_1", "dash-demo", "text_stats", ToolCallStatus.OK, 4), ToolUse("call_2", "dash-demo", "text_stats", ToolCallStatus.TIMEOUT, 4)),
            answer.tools,
        )
        assertTrue(device.repo.getMessages("conv-1").single { it.id == "u1" }.tools.isEmpty())
        // No activity recorded: none shown.
        assertTrue(device.repo.getMessages("conv-2").all { it.tools.isEmpty() })
    }

    @Test
    fun `repeated sync is a no-op and replaying every page changes nothing`() = runBlocking<Unit> {
        server.put(me, "conv-1", messages = listOf(user("u1"), assistant("a1")))
        device.sync()
        val first = device.snapshot()
        val again = device.sync()
        assertEquals(0, again.inserted + again.updated + again.deleted + again.pushed)
        assertTrue(server.pushes.isEmpty())
        device.store.save(device.store.load().copy(cursor = "0"))
        device.sync()
        assertEquals(first, device.snapshot())
    }

    @Test
    fun `compare answers and failed or stopped answers map faithfully`() = runBlocking<Unit> {
        server.put(me, "conv-1", messages = listOf(user("u1"), assistant("a1", group = "u1"), assistant("a2", provider = "anthropic", group = "u1", at = 12), assistant("a3", "", status = "failed", at = 13), assistant("a4", "partial", status = "stopped", at = 14)))
        device.sync()
        val m = device.repo.getMessages("conv-1").associateBy { it.id }
        assertEquals("u1", m.getValue("a2").replyToId)
        assertEquals(MessageStatus.FAILED, m.getValue("a3").status)
        assertTrue(m.getValue("a3").errorRetryable)
        assertEquals(FinishReason.CANCELLED, m.getValue("a4").finishReason)
    }

    @Test
    fun `the final state does not depend on page size`() = runBlocking<Unit> {
        for (i in 1..5) server.put(me, "conv-$i", messages = listOf(user("u$i"), assistant("a$i")))
        server.tombstone("conv-3")
        server.put(me, "conv-2", title = "Renamed", titleIsCustom = true, messages = listOf(user("u2"), assistant("a2"), user("u2b", at = 20)))
        val states = listOf(1, 2, 3, 100).map { size -> Device(server).also { it.sync(size) }.snapshot() }
        assertTrue(states.all { it == states.first() })
        assertEquals(4, states.first().size)
    }

    // ---- offline edits, uploads, failures and retries -----------------------------------------------

    @Test
    fun `a conversation written offline is uploaded on the next sync with only its user messages`() = runBlocking<Unit> {
        device.writeOffline("conv-off", "plan my launch", 100)
        // A stale assistant placeholder from a failed request must never be uploaded.
        device.repo.upsertMessage(ChatMessage("ghost", "conv-off", MessageRole.ASSISTANT, "partial", ms(101), status = MessageStatus.FAILED, provider = ProviderId.OPENAI))
        assertEquals(setOf("conv-off"), device.store.load().pendingUploads)

        val result = device.sync()

        assertEquals(1, result.pushed)
        assertTrue(device.store.load().pendingUploads.isEmpty())
        val upload = server.pushes.single()
        assertEquals("upload", upload.type)
        assertEquals(listOf("plan my launch"), upload.messages!!.map { it.content })
        val stored = server.conversations.getValue("conv-off")
        assertEquals(listOf("user"), stored.messages.map { it.role })
        // The pull right after brings the server's view back; the local-only assistant placeholder is kept.
        assertEquals(listOf("m-conv-off-100", "ghost"), device.repo.getMessages("conv-off").map { it.id })
    }

    @Test
    fun `a failed upload stays pending and the retry does not duplicate anything`() = runBlocking<Unit> {
        device.writeOffline("conv-off", "hello", 100)
        server.online = false
        assertFailsWith<ApiException> { device.sync() }
        assertEquals(setOf("conv-off"), device.store.load().pendingUploads)
        assertTrue(server.conversations.isEmpty())

        server.online = true
        device.sync()
        device.writeOffline("conv-off", "hello", 100) // marked again: retry of the same content
        device.sync()
        assertEquals(1, server.conversations.getValue("conv-off").messages.size)
        assertEquals(1, device.repo.getMessages("conv-off").size)
    }

    @Test
    fun `a lost push response is retried safely - applied once and never duplicated`() = runBlocking<Unit> {
        device.writeOffline("conv-off", "hello", 100)
        server.loseNextPushResponse = true
        val first = runCatching { device.sync() }
        assertTrue(first.isSuccess || first.exceptionOrNull() is ApiException)
        // The server applied it, but the device never heard back, so the upload is still pending.
        assertEquals(setOf("conv-off"), device.store.load().pendingUploads)
        device.sync()
        assertTrue(device.store.load().pendingUploads.isEmpty())
        assertEquals(1, server.conversations.getValue("conv-off").messages.size)
        assertEquals(2, server.pushes.size)
    }

    @Test
    fun `an operation the server rejects as invalid is dropped so it cannot block sync forever`() = runBlocking<Unit> {
        device.writeOffline("conv-off", "hello", 100)
        server.rejectPushWith = 400
        val result = device.sync()
        assertEquals(1, result.droppedOperations)
        assertTrue(device.store.load().pendingUploads.isEmpty())
        assertNotNull(device.repo.getConversation("conv-off")) // the local copy is never deleted for this
    }

    @Test
    fun `sign-in expiry during push stops the sync without losing pending work`() = runBlocking<Unit> {
        device.writeOffline("conv-off", "hello", 100)
        server.rejectPushWith = 401
        assertFailsWith<ApiException> { device.sync() }
        assertEquals(setOf("conv-off"), device.store.load().pendingUploads)
    }

    @Test
    fun `offline messages added to a synced conversation are appended when newer than the server's newest`() = runBlocking<Unit> {
        server.put(me, "conv-1", messages = listOf(user("u1", at = 10), assistant("a1", at = 11)))
        device.sync()
        device.writeOffline("conv-1", "follow-up written offline", 50)
        device.sync()
        assertEquals(listOf("u1", "a1", "m-conv-1-50"), server.conversations.getValue("conv-1").messages.map { it.id })
    }

    @Test
    fun `nothing is uploaded for conversations that are demo, gone, empty or never marked`() = runBlocking<Unit> {
        device.repo.upsertConversation(Conversation("demo-1", "Demo", AssistantMode.GENERAL, ms(1), ms(1), isDemo = true))
        device.repo.upsertMessage(ChatMessage("d1", "demo-1", MessageRole.USER, "demo text", ms(1), isDemo = true))
        device.repo.upsertConversation(Conversation("unmarked", "Other account?", AssistantMode.GENERAL, ms(1), ms(1)))
        device.repo.upsertMessage(ChatMessage("x1", "unmarked", MessageRole.USER, "never mine to upload", ms(1)))
        val s = device.service()
        s.onLocalConversationChanged(me, "demo-1")
        s.onLocalConversationChanged(me, "missing-locally")
        device.repo.upsertConversation(Conversation("empty", "Empty", AssistantMode.GENERAL, ms(1), ms(1)))
        s.onLocalConversationChanged(me, "empty")

        device.sync()

        assertTrue(server.pushes.isEmpty())
        assertTrue(device.store.load().pendingUploads.isEmpty())
    }

    // ---- deletion -----------------------------------------------------------------------------------

    @Test
    fun `a server tombstone deletes the local conversation and forgets its pending work`() = runBlocking<Unit> {
        server.put(me, "conv-1", messages = listOf(user("u1"), assistant("a1")))
        device.sync()
        device.writeOffline("conv-1", "late", 500)
        server.online = false
        runCatching { device.sync() }
        server.online = true
        server.tombstone("conv-1")
        val result = device.sync()
        assertNull(device.repo.getConversation("conv-1"))
        assertTrue(device.repo.getMessages("conv-1").isEmpty())
        assertEquals(setOf("conv-1"), result.deletedIds)
        assertFalse(device.store.load().hasPendingWork)
    }

    @Test
    fun `an upload to a conversation deleted elsewhere deletes the local copy instead of resurrecting it`() = runBlocking<Unit> {
        server.put(me, "conv-1", messages = listOf(user("u1")))
        device.sync()
        server.tombstone("conv-1") // deleted on another device; this device has not pulled it yet
        // This device writes offline and pushes before pulling.
        device.writeOffline("conv-1", "too late", 500)
        val result = device.sync()
        assertNull(device.repo.getConversation("conv-1"))
        assertTrue(result.deletedIds.contains("conv-1"))
        assertTrue(server.conversations.getValue("conv-1").deleted)
        assertTrue(server.conversations.getValue("conv-1").messages.isEmpty())
    }

    @Test
    fun `an offline local delete is never undone by a pull and is delivered later`() = runBlocking<Unit> {
        server.put(me, "conv-1", messages = listOf(user("u1")))
        server.put(me, "conv-2")
        device.sync()
        device.repo.deleteConversation("conv-1")
        server.online = false
        device.service().onLocalDelete(me, "conv-1")
        assertEquals(setOf("conv-1"), device.store.load().pendingDeletes)

        server.online = true
        server.put(me, "conv-1", title = "Edited elsewhere", messages = listOf(user("u1"), user("u1b", at = 30)))
        server.rejectPushWith = 503 // delete still cannot get through
        val during = device.sync()
        assertEquals(1, during.skippedPendingDelete)
        assertNull(device.repo.getConversation("conv-1"))

        server.rejectPushWith = null
        device.sync()
        assertTrue(server.conversations.getValue("conv-1").deleted)
        assertFalse(device.store.load().hasPendingWork)
        assertNull(device.repo.getConversation("conv-1"))
        assertNotNull(device.repo.getConversation("conv-2"))
    }

    @Test
    fun `a delete cancels a pending upload and rename of the same conversation`() = runBlocking<Unit> {
        device.writeOffline("conv-off", "x", 100)
        server.online = false
        device.service().onLocalRename(me, "conv-off", "Name")
        device.repo.deleteConversation("conv-off")
        device.service().onLocalDelete(me, "conv-off")
        server.online = true
        device.sync()
        assertEquals(listOf("delete"), server.pushes.map { it.type })
        assertTrue(server.conversations.isEmpty())
    }

    // ---- rename -------------------------------------------------------------------------------------

    @Test
    fun `a local rename carries the revision it was based on and is applied`() = runBlocking<Unit> {
        server.put(me, "conv-1", title = "Server title", titleIsCustom = true)
        device.sync()
        device.repo.renameConversation("conv-1", "My title")
        device.service().onLocalRename(me, "conv-1", "My title")
        val op = server.pushes.single()
        assertEquals(0L, op.baseTitleRev)
        assertEquals("My title", server.conversations.getValue("conv-1").dto.title)
        assertFalse(device.store.load().hasPendingWork)
    }

    @Test
    fun `a stale offline rename loses to a newer rename from another device`() = runBlocking<Unit> {
        server.put(me, "conv-1", title = "Original", titleIsCustom = true)
        device.sync()
        server.online = false
        device.repo.renameConversation("conv-1", "Phone title")
        device.service().onLocalRename(me, "conv-1", "Phone title")
        // Meanwhile, the laptop renames it on the server.
        server.put(me, "conv-1", title = "Laptop title", titleIsCustom = true)
        server.online = true

        val result = device.sync()

        assertEquals(1, result.renameConflicts)
        assertEquals("Laptop title", server.conversations.getValue("conv-1").dto.title)
        assertEquals("Laptop title", device.repo.getConversation("conv-1")!!.title) // server title pulled
        assertFalse(device.store.load().hasPendingWork)
    }

    @Test
    fun `while a rename is unconfirmed the local title wins every pull`() = runBlocking<Unit> {
        server.put(me, "conv-1", title = "Server", titleIsCustom = false, messages = listOf(user("u1")))
        device.sync()
        server.online = false
        device.repo.renameConversation("conv-1", "Mine")
        device.service().onLocalRename(me, "conv-1", "Mine")
        server.online = true
        server.rejectPushWith = 503
        server.put(me, "conv-1", title = "Server", messages = listOf(user("u1"), assistant("a1")))
        device.sync()
        assertEquals("Mine", device.repo.getConversation("conv-1")!!.title)
        assertEquals(2, device.repo.getMessages("conv-1").size)
        server.rejectPushWith = null
        device.sync()
        assertEquals("Mine", server.conversations.getValue("conv-1").dto.title)
    }

    @Test
    fun `renaming a conversation written offline uploads it with the new title`() = runBlocking<Unit> {
        server.online = false
        device.writeOffline("conv-off", "x", 100, title = "Generated")
        device.repo.renameConversation("conv-off", "Named offline")
        device.service().onLocalRename(me, "conv-off", "Named offline")
        server.online = true
        device.sync()
        assertEquals("Named offline", server.conversations.getValue("conv-off").dto.title)
        assertFalse(device.store.load().hasPendingWork)
    }

    // ---- app restart, account switch, stale cursors -------------------------------------------------

    @Test
    fun `pending work and the cursor survive an app restart`() = runBlocking<Unit> {
        val persisted = StringSyncStateStore()
        val before = Device(server, store = persisted)
        server.put(me, "conv-1", messages = listOf(user("u1")))
        before.sync()
        server.online = false
        before.writeOffline("conv-off", "x", 100)
        before.service().onLocalRename(me, "conv-1", "Renamed")
        before.service().onLocalDelete(me, "conv-zz")

        // "Restart": a brand-new service object reading the same stored string.
        val state = SyncState.decode(persisted.stored)
        assertEquals("1", state.cursor)
        assertEquals(setOf("conv-off"), state.pendingUploads)
        assertEquals(mapOf("conv-1" to "Renamed"), state.pendingRenames)
        assertEquals(mapOf("conv-1" to 0L), state.renameBases)
        assertEquals(setOf("conv-zz"), state.pendingDeletes)

        server.online = true
        ConversationSyncService(server.remoteFor(me), before.repo, persisted).sync(me)
        assertFalse(SyncState.decode(persisted.stored).hasPendingWork)
        assertEquals("Renamed", server.conversations.getValue("conv-1").dto.title)
        assertNotNull(server.conversations["conv-off"])
    }

    @Test
    fun `state written by the previous app version still decodes with its pending work`() {
        val old = """{"userId":"u","cursor":"7","pendingDeletes":["a"],"pendingRenames":{"b":"T"}}"""
        val state = SyncState.decode(old)
        assertEquals("7", state.cursor)
        assertEquals(setOf("a"), state.pendingDeletes)
        assertEquals(mapOf("b" to "T"), state.pendingRenames)
        assertTrue(state.pendingUploads.isEmpty())
        assertEquals(SyncState(), SyncState.decode("{not json"))
    }

    @Test
    fun `another account on the same device never inherits pending work or uploads`() = runBlocking<Unit> {
        device.writeOffline("conv-a", "account A's words", 100)
        val asB = ConversationSyncService(server.remoteFor("user-b"), device.repo, device.store)
        asB.sync("user-b")
        assertTrue(server.pushes.isEmpty())
        assertTrue(server.conversations.isEmpty())
        assertEquals("user-b", device.store.load().userId)
    }

    @Test
    fun `a cursor beyond the server's latest change restarts from zero`() = runBlocking<Unit> {
        server.put(me, "conv-1", messages = listOf(user("u1")))
        device.store.save(SyncState(userId = me, cursor = "500"))
        assertEquals(1, device.sync().inserted)
        assertEquals("1", device.store.load().cursor)
    }

    @Test
    fun `an interrupted pull resumes from the last fully applied page`() = runBlocking<Unit> {
        for (i in 1..4) server.put(me, "conv-$i", messages = listOf(user("u$i")))
        server.failPullAfterPages = 2
        assertFailsWith<ApiException> { device.sync(pageSize = 1) }
        assertEquals("2", device.store.load().cursor)
        server.failPullAfterPages = null
        assertEquals(2, device.sync(pageSize = 1).inserted)
    }

    @Test
    fun `sync is deferred while a response is being generated`() = runBlocking<Unit> {
        server.put(me, "conv-1")
        device.generating = true
        assertTrue(device.sync().deferred)
        assertTrue(device.repo.allConversations().isEmpty())
        device.generating = false
        assertEquals(1, device.sync().inserted)
    }

    // ---- conflicting server/local state -------------------------------------------------------------

    @Test
    fun `server owns structure, device-only fields survive, local-only messages are kept`() = runBlocking<Unit> {
        val attachment = AttachmentRef("doc-local", "doc-remote", "plan.pdf", DocumentKind.PDF, 1234)
        device.repo.upsertConversation(Conversation("conv-1", "Old", AssistantMode.GENERAL, ms(5), ms(5_000)))
        device.repo.upsertMessage(ChatMessage("u1", "conv-1", MessageRole.USER, "stale", ms(10), attachments = listOf(attachment)))
        device.repo.upsertMessage(ChatMessage("a1", "conv-1", MessageRole.ASSISTANT, "stale answer", ms(11), status = MessageStatus.STOPPED, provider = ProviderId.OPENAI, modelChoice = ModelChoice.SMART, replyToId = "u1", routingReason = "why"))
        device.repo.upsertMessage(ChatMessage("local-only", "conv-1", MessageRole.USER, "never sent", ms(40)))
        server.put(me, "conv-1", title = "Server", mode = "writing", titleIsCustom = true, messages = listOf(user("u1", "server text"), assistant("a1", "final")))

        device.sync()

        val c = device.repo.getConversation("conv-1")!!
        assertEquals("Server", c.title)
        assertEquals(AssistantMode.WRITING, c.mode)
        assertEquals(ms(5_000), c.updatedAt)
        val byId = device.repo.getMessages("conv-1").associateBy { it.id }
        assertEquals("server text", byId.getValue("u1").content)
        assertEquals(listOf(attachment), byId.getValue("u1").attachments)
        assertEquals(ModelChoice.SMART, byId.getValue("a1").modelChoice)
        assertEquals("why", byId.getValue("a1").routingReason)
        assertTrue("local-only" in byId)
    }

    @Test
    fun `demo conversations are never touched by pull or push`() = runBlocking<Unit> {
        device.repo.upsertConversation(Conversation("conv-1", "Demo chat", AssistantMode.GENERAL, ms(1), ms(2), isDemo = true))
        device.repo.upsertMessage(ChatMessage("d1", "conv-1", MessageRole.USER, "demo", ms(3), isDemo = true))
        server.put(me, "conv-1", title = "Server", messages = listOf(user("u1")))
        server.tombstone("conv-1")
        device.sync()
        assertEquals("Demo chat", device.repo.getConversation("conv-1")!!.title)
    }

    @Test
    fun `two devices converge to the same state whatever order they sync in`() = runBlocking<Unit> {
        val phone = Device(server)
        val laptop = Device(server)
        server.put(me, "shared", title = "Shared", messages = listOf(user("s1", at = 10), assistant("s2", at = 11)))
        phone.sync()
        laptop.sync()

        // Both work offline: phone writes a new chat and a follow-up; laptop renames and deletes another.
        server.put(me, "doomed", messages = listOf(user("d1")))
        phone.sync()
        laptop.sync()
        phone.writeOffline("phone-new", "from the phone", 200)
        phone.writeOffline("shared", "phone follow-up", 300)
        laptop.repo.renameConversation("shared", "Laptop name")
        laptop.service().onLocalRename(me, "shared", "Laptop name")
        laptop.repo.deleteConversation("doomed")
        laptop.service().onLocalDelete(me, "doomed")

        phone.sync()
        laptop.sync()
        phone.sync() // second round so each sees the other's pushes

        assertEquals(phone.snapshot().map { it.first.id to it.second.map { m -> m.id } }, laptop.snapshot().map { it.first.id to it.second.map { m -> m.id } })
        assertEquals(setOf("phone-new", "shared"), phone.repo.allConversations().map { it.id }.toSet())
        assertEquals("Laptop name", phone.repo.getConversation("shared")!!.title)
        assertEquals(listOf("s1", "s2", "m-shared-300"), laptop.repo.getMessages("shared").map { it.id })
    }

    // ---- malformed server responses -----------------------------------------------------------------

    @Test
    fun `a change with an invalid timestamp or role is skipped, never half-applied, and sync moves on`() = runBlocking<Unit> {
        server.put(me, "good", messages = listOf(user("g1")))
        server.put(me, "bad-time", messages = listOf(user("b1").copy(createdAt = "yesterday-ish")))
        server.put(me, "bad-role", messages = listOf(user("r1").copy(role = "system")))
        val result = device.sync()
        assertEquals(2, result.malformedChanges)
        assertEquals(1, result.inserted)
        assertNull(device.repo.getConversation("bad-time"))
        assertNull(device.repo.getConversation("bad-role"))
        assertEquals("3", device.store.load().cursor)
    }

    @Test
    fun `a page whose cursor goes backwards, is not a number, or stalls is rejected without moving the cursor`() = runBlocking<Unit> {
        server.put(me, "conv-1")
        device.sync()
        server.put(me, "conv-2")
        for (bad in listOf<(SyncPageDto) -> SyncPageDto>({ it.copy(cursor = "0") }, { it.copy(cursor = "abc") }, { it.copy(cursor = "1", hasMore = true) })) {
            server.pageOverride = bad
            val error = assertFailsWith<ApiException> { device.sync() }
            assertEquals("bad_response", error.error.code)
            assertEquals("1", device.store.load().cursor)
        }
        server.pageOverride = null
        assertEquals(1, device.sync().inserted)
    }

    @Test
    fun `a push response without a result for the operation keeps the work pending`() = runBlocking<Unit> {
        device.writeOffline("conv-off", "x", 100)
        server.resultOverride = { SyncPushResponseDto(emptyList()) }
        runCatching { device.sync() }
        assertEquals(setOf("conv-off"), device.store.load().pendingUploads)
        server.resultOverride = null
        device.sync()
        assertTrue(device.store.load().pendingUploads.isEmpty())
    }

    // ---- wire format --------------------------------------------------------------------------------

    @Test
    fun `the contract fixtures decode strictly and the pull fixture applies`() = runBlocking<Unit> {
        val page = DashJson.strict.decodeFromString(SyncPageDto.serializer(), Fixtures.text("sync-conversations.json"))
        DashJson.strict.decodeFromString(SyncPushRequestDto.serializer(), Fixtures.text("sync-push-request.json"))
        DashJson.strict.decodeFromString(SyncPushResponseDto.serializer(), Fixtures.text("sync-push-response.json"))
        val remote = object : SyncRemote {
            override suspend fun changes(cursor: String, limit: Int) = if (cursor == "0") page else SyncPageDto(emptyList(), cursor, page.latest, false)
            override suspend fun push(request: SyncPushRequestDto) = SyncPushResponseDto(emptyList())
        }
        val repo = InMemoryConversationRepository()
        val result = ConversationSyncService(remote, repo, InMemorySyncStateStore()).sync(me)
        assertEquals(1, result.inserted)
        assertEquals("Premium coffee kiosk plan", repo.getConversation("3f0b8f2e-6a4d-4c1e-9d7a-1b2c3d4e5f60")!!.title)
        val answer = repo.getMessages("3f0b8f2e-6a4d-4c1e-9d7a-1b2c3d4e5f60").single { it.isAssistant }
        assertEquals(listOf(ToolCallStatus.OK, ToolCallStatus.TIMEOUT), answer.tools.map { it.status })
    }

    @Test
    fun `DashApiSyncRemote sends the cursor, token and push body in the contract shape`() = runBlocking<Unit> {
        val mock = MockWebServer()
        mock.start()
        try {
            val client = DashApiClient(mock.url("/").toString(), tokenProvider = { "dash_test_token_1234567890" })
            val remote = DashApiSyncRemote(client)
            mock.enqueue(MockResponse().setHeader("Content-Type", "application/json").setBody(Fixtures.text("sync-conversations.json")))
            assertEquals(2, remote.changes("7", 20).changes.size)
            val get = mock.takeRequest()
            assertEquals("/v1/sync/conversations?cursor=7&limit=20", get.path)
            assertEquals("Bearer dash_test_token_1234567890", get.getHeader("Authorization"))

            mock.enqueue(MockResponse().setHeader("Content-Type", "application/json").setBody(Fixtures.text("sync-push-response.json")))
            val repo = InMemoryConversationRepository()
            repo.upsertConversation(Conversation("conv-off-1", "Offline", AssistantMode.WRITING, ms(1), ms(1)))
            repo.upsertMessage(ChatMessage("msg-off-1", "conv-off-1", MessageRole.USER, "hello", ms(2)))
            val state = InMemorySyncStateStore(SyncState(userId = me, pendingUploads = setOf("conv-off-1")))
            mock.enqueue(MockResponse().setHeader("Content-Type", "application/json").setBody("""{"changes":[],"cursor":"0","latest":"0","hasMore":false}"""))
            ConversationSyncService(remote, repo, state, ids = { "op-upload-0001" }).sync(me)
            val post = mock.takeRequest()
            assertEquals("/v1/sync/push", post.path)
            val op = Json.parseToJsonElement(post.body.readUtf8()).jsonObject.getValue("operations").jsonArray.single().jsonObject
            assertEquals("upload", op.getValue("type").jsonPrimitive.content)
            assertEquals("writing", op.getValue("conversation").jsonObject.getValue("mode").jsonPrimitive.content)
            assertEquals(setOf("id", "content", "createdAt"), op.getValue("messages").jsonArray.single().jsonObject.keys)
            assertTrue(state.load().pendingUploads.isEmpty())

            mock.enqueue(MockResponse().setResponseCode(401).setBody(Fixtures.text("error-response.json")))
            assertEquals(401, assertFailsWith<ApiException> { remote.changes("0", 20) }.httpStatus)
        } finally {
            mock.shutdown()
        }
    }
}
