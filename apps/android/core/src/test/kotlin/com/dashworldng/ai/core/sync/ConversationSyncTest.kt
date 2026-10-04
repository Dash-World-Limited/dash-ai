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
import com.dashworldng.ai.core.remote.ConversationMessageDto
import com.dashworldng.ai.core.remote.DashApiClient
import com.dashworldng.ai.core.remote.DashJson
import com.dashworldng.ai.core.remote.SyncChangeDto
import com.dashworldng.ai.core.remote.SyncConversationDto
import com.dashworldng.ai.core.remote.SyncPageDto
import com.dashworldng.ai.core.stream.ApiError
import com.dashworldng.ai.core.stream.ApiException
import kotlinx.coroutines.runBlocking
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

/** A tiny in-memory model of the server's sync endpoint: per-user seq, tombstones, full-message changes. */
private class FakeServer {
    class Conv(var dto: SyncConversationDto, var messages: List<ConversationMessageDto>, var deleted: Boolean, var seq: Long)

    val conversations = linkedMapOf<String, Conv>()
    private var counter = 0L
    var online = true
    var failPageAfter: Int? = null
    var pagesServed = 0
    val deletes = mutableListOf<String>()
    val renames = mutableListOf<Pair<String, String>>()
    var overrideLatest: String? = null

    private fun offline() = ApiException(ApiError.network(), cause = null)

    fun put(id: String, title: String = "Chat $id", mode: String = "general", updatedAt: String = iso(2_000), titleIsCustom: Boolean = false, messages: List<ConversationMessageDto> = emptyList()) {
        val conv = conversations[id]
        val dto = SyncConversationDto(id, title, mode, iso(1_000), updatedAt, titleIsCustom)
        if (conv == null) conversations[id] = Conv(dto, messages, false, ++counter)
        else {
            conv.dto = dto
            conv.messages = messages
            conv.seq = ++counter
        }
    }

    fun tombstone(id: String) {
        val conv = conversations[id] ?: return
        conv.deleted = true
        conv.messages = emptyList()
        conv.dto = conv.dto.copy(title = "")
        conv.seq = ++counter
    }

    val remote = object : SyncRemote {
        override suspend fun changes(cursor: String, limit: Int): SyncPageDto {
            if (!online) throw offline()
            if (failPageAfter != null && pagesServed >= failPageAfter!!) throw offline()
            pagesServed += 1
            val after = cursor.toLong()
            val rows = conversations.values.filter { it.seq > after }.sortedBy { it.seq }
            val page = rows.take(limit)
            return SyncPageDto(
                changes = page.map { SyncChangeDto(it.seq, it.deleted, it.dto, it.messages) },
                cursor = (page.lastOrNull()?.seq ?: after).toString(),
                latest = overrideLatest ?: counter.toString(),
                hasMore = rows.size > limit,
            )
        }

        override suspend fun deleteConversation(id: String) {
            if (!online) throw offline()
            deletes += id
            val conv = conversations[id] ?: throw ApiException(ApiError("not_found", "nf", false), 404)
            if (!conv.deleted) tombstone(id)
        }

        override suspend fun renameConversation(id: String, title: String) {
            if (!online) throw offline()
            val conv = conversations[id]
            if (conv == null || conv.deleted) throw ApiException(ApiError("not_found", "nf", false), 404)
            renames += id to title
            conv.dto = conv.dto.copy(title = title, titleIsCustom = true)
            conv.seq = ++counter
        }
    }
}

private fun iso(offsetSeconds: Long) = Instant.parse("2026-03-04T05:00:00Z").plusSeconds(offsetSeconds).toString()
private fun ms(offsetSeconds: Long) = Instant.parse("2026-03-04T05:00:00Z").plusSeconds(offsetSeconds).toEpochMilli()

private fun user(id: String, text: String = "question", at: Long = 10) =
    ConversationMessageDto(id, "user", text, null, null, false, "complete", null, iso(at))

private fun assistant(id: String, text: String = "answer", provider: String = "openai", at: Long = 11, status: String = "complete", group: String? = null) =
    ConversationMessageDto(id, "assistant", text, provider, "model-$provider", false, status, group, iso(at))

class ConversationSyncTest {
    private val server = FakeServer()
    private val repo = InMemoryConversationRepository()
    private val stateStore = InMemorySyncStateStore()
    private var generating = false
    private fun service(pageSize: Int = 20) = ConversationSyncService(server.remote, repo, stateStore, canSync = { !generating }, pageSize = pageSize)
    private val me = "user-1"

    private suspend fun snapshot() = repo.allConversations().sortedBy { it.id }.map { it to repo.getMessages(it.id) }

    @Test
    fun `a fresh device pulls conversations with their messages`() = runBlocking<Unit> {
        server.put("conv-1", title = "Plan", mode = "business", messages = listOf(user("u1"), assistant("a1")))
        server.put("conv-2", messages = listOf(user("u2")))

        val result = service().sync(me)

        assertEquals(2, result.inserted)
        assertEquals(0, result.updated)
        val c1 = assertNotNull(repo.getConversation("conv-1"))
        assertEquals("Plan", c1.title)
        assertEquals(AssistantMode.BUSINESS, c1.mode)
        assertEquals(ms(1_000), c1.createdAt)
        assertEquals(ms(2_000), c1.updatedAt)
        assertFalse(c1.isDemo)
        val messages = repo.getMessages("conv-1")
        assertEquals(listOf("u1", "a1"), messages.map { it.id })
        assertEquals(MessageRole.ASSISTANT, messages[1].role)
        assertEquals(ProviderId.OPENAI, messages[1].provider)
        assertEquals("model-openai", messages[1].model)
        assertEquals(ms(11), messages[1].createdAt)
        assertEquals("u1", messages[1].replyToId) // inferred: the user turn it answers
        assertEquals(stateStore.load().cursor, result.cursor)
        assertEquals("2", result.cursor)
    }

    @Test
    fun `compare answers link back to the user message through the compare group`() = runBlocking<Unit> {
        server.put("conv-1", messages = listOf(user("u1"), assistant("a1", provider = "openai", group = "u1"), assistant("a2", provider = "anthropic", group = "u1", at = 12)))
        service().sync(me)
        val messages = repo.getMessages("conv-1")
        assertEquals(listOf("u1", "u1"), messages.drop(1).map { it.replyToId })
        assertEquals(listOf("u1", "u1"), messages.drop(1).map { it.compareGroupId })
    }

    @Test
    fun `failed and stopped answers keep their state and are retryable`() = runBlocking<Unit> {
        server.put("conv-1", messages = listOf(user("u1"), assistant("a1", "", status = "failed"), assistant("a2", "partial", status = "stopped", at = 12)))
        service().sync(me)
        val (failed, stopped) = repo.getMessages("conv-1").drop(1)
        assertEquals(MessageStatus.FAILED, failed.status)
        assertTrue(failed.errorRetryable)
        assertNotNull(failed.errorMessage)
        assertEquals(MessageStatus.STOPPED, stopped.status)
        assertEquals(FinishReason.CANCELLED, stopped.finishReason)
        assertEquals("partial", stopped.content)
    }

    @Test
    fun `syncing again is a no-op and replaying the same pages changes nothing`() = runBlocking<Unit> {
        server.put("conv-1", messages = listOf(user("u1"), assistant("a1")))
        service().sync(me)
        val first = snapshot()
        val second = service().sync(me)
        assertEquals(0, second.inserted + second.updated + second.deleted)
        assertEquals(first, snapshot())

        stateStore.save(stateStore.load().copy(cursor = "0")) // force a full replay
        service().sync(me)
        assertEquals(first, snapshot())
    }

    @Test
    fun `the final state does not depend on how the server splits pages`() = runBlocking<Unit> {
        for (i in 1..5) server.put("conv-$i", messages = listOf(user("u$i"), assistant("a$i")))
        server.tombstone("conv-3")
        server.put("conv-2", title = "Renamed", titleIsCustom = true, messages = listOf(user("u2"), assistant("a2"), user("u2b", at = 20)))

        val states = listOf(1, 2, 3, 100).map { size ->
            val freshRepo = InMemoryConversationRepository()
            ConversationSyncService(server.remote, freshRepo, InMemorySyncStateStore(), pageSize = size).sync(me)
            freshRepo.allConversations().sortedBy { it.id }.map { it to freshRepo.getMessages(it.id) }
        }
        assertTrue(states.all { it == states.first() })
        assertEquals(4, states.first().size) // conv-3 was deleted
        assertEquals("Renamed", states.first().single { it.first.id == "conv-2" }.first.title)
    }

    @Test
    fun `an interrupted sync resumes from the last fully applied page`() = runBlocking<Unit> {
        for (i in 1..4) server.put("conv-$i", messages = listOf(user("u$i")))
        server.failPageAfter = 2
        assertFailsWith<ApiException> { service(pageSize = 1).sync(me) }
        assertEquals("2", stateStore.load().cursor)
        assertEquals(2, repo.allConversations().size)

        server.failPageAfter = null
        val resumed = service(pageSize = 1).sync(me)
        assertEquals(2, resumed.inserted)
        assertEquals(4, repo.allConversations().size)
        assertEquals("4", stateStore.load().cursor)
    }

    @Test
    fun `a server tombstone deletes the local conversation and its messages`() = runBlocking<Unit> {
        server.put("conv-1", messages = listOf(user("u1"), assistant("a1")))
        service().sync(me)
        server.tombstone("conv-1")
        val result = service().sync(me)
        assertEquals(1, result.deleted)
        assertEquals(setOf("conv-1"), result.deletedIds)
        assertNull(repo.getConversation("conv-1"))
        assertTrue(repo.getMessages("conv-1").isEmpty())
    }

    @Test
    fun `a tombstone wins over local edits and unknown tombstones are ignored`() = runBlocking<Unit> {
        server.put("conv-1", messages = listOf(user("u1")))
        server.put("conv-ghost", messages = emptyList())
        server.tombstone("conv-ghost")
        service().sync(me)
        repo.upsertMessage(ChatMessage("local-new", "conv-1", MessageRole.USER, "typed later", ms(500)))
        server.tombstone("conv-1")
        service().sync(me)
        assertNull(repo.getConversation("conv-1"))
        assertTrue(repo.getMessages("conv-1").isEmpty())
        assertNull(repo.getConversation("conv-ghost"))
    }

    @Test
    fun `a local delete that could not reach the server is not undone by the next pull`() = runBlocking<Unit> {
        server.put("conv-1", messages = listOf(user("u1"), assistant("a1")))
        server.put("conv-2", messages = listOf(user("u2")))
        service().sync(me)

        // The user deletes conv-1 while offline: the UI removes it locally, the server never hears.
        repo.deleteConversation("conv-1")
        server.online = false
        service().onLocalDelete(me, "conv-1")
        assertEquals(setOf("conv-1"), stateStore.load().pendingDeletes)

        // Something else changes conv-1 on the server (another device) and we sync while still offline-then-online.
        server.online = true
        server.put("conv-1", title = "Edited elsewhere", messages = listOf(user("u1"), assistant("a1"), user("u1b", at = 30)))
        // Make the delete flush fail once more (flaky network) so the pull must skip the server copy.
        val flaky = object : SyncRemote by server.remote {
            override suspend fun deleteConversation(id: String) = throw ApiException(ApiError.network(), cause = null)
        }
        val result = ConversationSyncService(flaky, repo, stateStore).sync(me)
        assertEquals(1, result.skippedPendingDelete)
        assertNull(repo.getConversation("conv-1")) // not resurrected
        assertEquals(setOf("conv-1"), stateStore.load().pendingDeletes)

        // Connectivity returns: the deletion is delivered first, then the pull sees the tombstone.
        val healed = service().sync(me)
        assertEquals(listOf("conv-1"), server.deletes)
        assertTrue(stateStore.load().pendingDeletes.isEmpty())
        assertNull(repo.getConversation("conv-1"))
        assertEquals(0, healed.inserted)
        assertNotNull(repo.getConversation("conv-2"))
    }

    @Test
    fun `a local delete that succeeds clears itself, and a 404 counts as done`() = runBlocking<Unit> {
        server.put("conv-1")
        service().sync(me)
        repo.deleteConversation("conv-1")
        service().onLocalDelete(me, "conv-1")
        assertTrue(stateStore.load().pendingDeletes.isEmpty())
        assertEquals(listOf("conv-1"), server.deletes)

        service().onLocalDelete(me, "never-existed-on-server") // server answers 404
        assertTrue(stateStore.load().pendingDeletes.isEmpty())
    }

    @Test
    fun `a rename that could not reach the server wins locally until it is delivered`() = runBlocking<Unit> {
        server.put("conv-1", title = "Server title", messages = listOf(user("u1")))
        service().sync(me)

        repo.renameConversation("conv-1", "My title")
        server.online = false
        service().onLocalRename(me, "conv-1", "My title")
        assertEquals(mapOf("conv-1" to "My title"), stateStore.load().pendingRenames)

        // Someone else changes the conversation on the server meanwhile; still offline for the flush.
        server.online = true
        server.put("conv-1", title = "Other device title", titleIsCustom = true, messages = listOf(user("u1"), assistant("a1")))
        val flaky = object : SyncRemote by server.remote {
            override suspend fun renameConversation(id: String, title: String) = throw ApiException(ApiError.network(), cause = null)
        }
        ConversationSyncService(flaky, repo, stateStore).sync(me)
        val during = assertNotNull(repo.getConversation("conv-1"))
        assertEquals("My title", during.title) // local rename wins while unconfirmed
        assertTrue(during.titleIsCustom)
        assertEquals(2, repo.getMessages("conv-1").size) // but the new server messages still arrive

        service().sync(me)
        assertEquals(listOf("conv-1" to "My title"), server.renames)
        assertTrue(stateStore.load().pendingRenames.isEmpty())
        assertEquals("My title", repo.getConversation("conv-1")!!.title)
        assertEquals("My title", server.conversations.getValue("conv-1").dto.title)
    }

    @Test
    fun `without pending operations the server owns title, mode and creation time`() = runBlocking<Unit> {
        repo.upsertConversation(Conversation("conv-1", "Old local title", AssistantMode.GENERAL, createdAt = ms(5), updatedAt = ms(5_000), titleIsCustom = false))
        server.put("conv-1", title = "Server title", mode = "writing", updatedAt = iso(3_000), titleIsCustom = true)
        service().sync(me)
        val c = repo.getConversation("conv-1")!!
        assertEquals("Server title", c.title)
        assertTrue(c.titleIsCustom)
        assertEquals(AssistantMode.WRITING, c.mode)
        assertEquals(ms(1_000), c.createdAt)
        assertEquals(ms(5_000), c.updatedAt) // never moves backwards: the later of local (5000s) and server (3000s)
    }

    @Test
    fun `messages merge by id server wins on content and device-only fields survive`() = runBlocking<Unit> {
        val attachment = AttachmentRef("doc-local", "doc-remote", "plan.pdf", DocumentKind.PDF, 1234)
        repo.upsertConversation(Conversation("conv-1", "T", AssistantMode.GENERAL, ms(1), ms(2)))
        repo.upsertMessage(ChatMessage("u1", "conv-1", MessageRole.USER, "stale text", ms(10), attachments = listOf(attachment)))
        repo.upsertMessage(
            ChatMessage(
                "a1", "conv-1", MessageRole.ASSISTANT, "stale answer", ms(11), status = MessageStatus.STOPPED,
                provider = ProviderId.OPENAI, modelChoice = ModelChoice.SMART, replyToId = "u1", routingReason = "Dash Smart chose OpenAI",
            ),
        )
        repo.upsertMessage(ChatMessage("local-only", "conv-1", MessageRole.USER, "never reached the server", ms(40), status = MessageStatus.FAILED))
        server.put("conv-1", messages = listOf(user("u1", "server text"), assistant("a1", "final answer", status = "complete")))

        service().sync(me)

        val byId = repo.getMessages("conv-1").associateBy { it.id }
        assertEquals("server text", byId.getValue("u1").content)
        assertEquals(listOf(attachment), byId.getValue("u1").attachments)
        val a1 = byId.getValue("a1")
        assertEquals("final answer", a1.content)
        assertEquals(MessageStatus.COMPLETE, a1.status)
        assertEquals(ModelChoice.SMART, a1.modelChoice)
        assertEquals("Dash Smart chose OpenAI", a1.routingReason)
        assertEquals("u1", a1.replyToId)
        assertEquals("model-openai", a1.model)
        assertTrue("local-only" in byId) // a pull never deletes a local message
        assertEquals(listOf("u1", "a1", "local-only"), repo.getMessages("conv-1").map { it.id })
    }

    @Test
    fun `demo conversations are never touched`() = runBlocking<Unit> {
        repo.upsertConversation(Conversation("conv-1", "Demo chat", AssistantMode.GENERAL, ms(1), ms(2), isDemo = true))
        repo.upsertMessage(ChatMessage("d1", "conv-1", MessageRole.USER, "demo text", ms(3), isDemo = true))
        server.put("conv-1", title = "Server version", messages = listOf(user("u1")))
        server.tombstone("conv-1")
        service().sync(me)
        assertEquals("Demo chat", repo.getConversation("conv-1")!!.title)
        assertEquals(listOf("d1"), repo.getMessages("conv-1").map { it.id })
    }

    @Test
    fun `local conversations the server has never seen are left alone`() = runBlocking<Unit> {
        repo.upsertConversation(Conversation("local-1", "Only here", AssistantMode.GENERAL, ms(1), ms(2)))
        server.put("conv-1")
        service().sync(me)
        assertNotNull(repo.getConversation("local-1"))
        assertEquals(2, repo.allConversations().size)
    }

    @Test
    fun `a different account starts from scratch and drops the previous account's pending work`() = runBlocking<Unit> {
        server.put("conv-1")
        service().sync("user-a")
        stateStore.save(stateStore.load().copy(pendingDeletes = setOf("conv-x"), pendingRenames = mapOf("conv-y" to "t")))

        val freshRepo = InMemoryConversationRepository()
        val result = ConversationSyncService(server.remote, freshRepo, stateStore).sync("user-b")
        assertEquals(1, result.inserted) // cursor was reset, so everything is pulled again
        val state = stateStore.load()
        assertEquals("user-b", state.userId)
        assertTrue(state.pendingDeletes.isEmpty() && state.pendingRenames.isEmpty())
        assertTrue(server.deletes.isEmpty())
    }

    @Test
    fun `a cursor beyond the server's latest change means restored data so we start over`() = runBlocking<Unit> {
        server.put("conv-1", messages = listOf(user("u1")))
        stateStore.save(SyncState(userId = me, cursor = "500"))
        val result = service().sync(me)
        assertEquals(1, result.inserted)
        assertEquals("1", stateStore.load().cursor)
    }

    @Test
    fun `sync is deferred while a response is being generated`() = runBlocking<Unit> {
        server.put("conv-1")
        generating = true
        val deferred = service().sync(me)
        assertTrue(deferred.deferred)
        assertTrue(repo.allConversations().isEmpty())
        generating = false
        assertEquals(1, service().sync(me).inserted)
    }

    @Test
    fun `network failure propagates and leaves cursor and pending state intact`() = runBlocking<Unit> {
        server.put("conv-1")
        service().sync(me)
        stateStore.save(stateStore.load().copy(pendingDeletes = setOf("conv-1")))
        server.online = false
        val error = assertFailsWith<ApiException> { service().sync(me) }
        assertEquals("network", error.error.code)
        assertEquals(setOf("conv-1"), stateStore.load().pendingDeletes)
        assertEquals("1", stateStore.load().cursor)
    }

    @Test
    fun `the contract fixture decodes strictly and applies`() = runBlocking<Unit> {
        val page = DashJson.strict.decodeFromString(SyncPageDto.serializer(), Fixtures.text("sync-conversations.json"))
        assertEquals(2, page.changes.size)
        val remote = object : SyncRemote {
            override suspend fun changes(cursor: String, limit: Int) = if (cursor == "0") page else SyncPageDto(emptyList(), cursor, page.latest, false)
            override suspend fun deleteConversation(id: String) = Unit
            override suspend fun renameConversation(id: String, title: String) = Unit
        }
        val result = ConversationSyncService(remote, repo, stateStore).sync(me)
        assertEquals(1, result.inserted)
        val c = repo.getConversation("3f0b8f2e-6a4d-4c1e-9d7a-1b2c3d4e5f60")!!
        assertEquals("Premium coffee kiosk plan", c.title)
        assertEquals(AssistantMode.BUSINESS, c.mode)
        assertEquals(listOf("user", "assistant"), repo.getMessages(c.id).map { if (it.isUser) "user" else "assistant" })
        assertEquals("4", stateStore.load().cursor)
    }

    @Test
    fun `sync state survives serialisation and corrupt data resets safely`() {
        val state = SyncState("u", "42", setOf("a", "b"), mapOf("c" to "Title"))
        assertEquals(state, SyncState.decode(SyncState.encode(state)))
        assertEquals(SyncState(), SyncState.decode("{not json"))
        assertEquals(SyncState(), SyncState.decode(null))
    }

    @Test
    fun `DashApiSyncRemote sends the cursor, limit and token and maps errors`() = runBlocking<Unit> {
        val mock = MockWebServer()
        mock.start()
        try {
            val client = DashApiClient(mock.url("/").toString(), tokenProvider = { "dash_test_token_1234567890" })
            val remote = DashApiSyncRemote(client)
            mock.enqueue(MockResponse().setHeader("Content-Type", "application/json").setBody(Fixtures.text("sync-conversations.json")))
            val page = remote.changes("7", 20)
            assertEquals(2, page.changes.size)
            val recorded = mock.takeRequest()
            assertEquals("/v1/sync/conversations?cursor=7&limit=20", recorded.path)
            assertEquals("Bearer dash_test_token_1234567890", recorded.getHeader("Authorization"))

            mock.enqueue(MockResponse().setResponseCode(401).setBody(Fixtures.text("error-response.json")))
            val failure = assertFailsWith<ApiException> { remote.changes("0", 20) }
            assertEquals(401, failure.httpStatus)

            mock.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":{"code":"not_found","message":"Conversation not found.","retryable":false}}"""))
            assertFailsWith<ApiException> { remote.deleteConversation("conv-1") }.also { assertEquals(404, it.httpStatus) }
        } finally {
            mock.shutdown()
        }
    }
}
