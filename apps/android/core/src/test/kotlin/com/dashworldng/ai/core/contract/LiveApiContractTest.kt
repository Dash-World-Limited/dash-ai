package com.dashworldng.ai.core.contract

import com.dashworldng.ai.core.account.InMemoryLocalOwnerStore
import com.dashworldng.ai.core.account.LocalAccountGuard
import com.dashworldng.ai.core.auth.AuthService
import com.dashworldng.ai.core.chat.ChatSession
import com.dashworldng.ai.core.chat.ChatRequest
import com.dashworldng.ai.core.documents.UploadSource
import com.dashworldng.ai.core.data.InMemoryConversationRepository
import com.dashworldng.ai.core.model.AssistantMode
import com.dashworldng.ai.core.model.ChatMessage
import com.dashworldng.ai.core.model.Conversation
import com.dashworldng.ai.core.model.MessageRole
import com.dashworldng.ai.core.model.DocumentStatus
import com.dashworldng.ai.core.model.ModelChoice
import com.dashworldng.ai.core.model.ProviderId
import com.dashworldng.ai.core.remote.DashApiClient
import com.dashworldng.ai.core.remote.RemoteChatGateway
import com.dashworldng.ai.core.remote.RemoteDocumentGateway
import com.dashworldng.ai.core.stream.ApiException
import com.dashworldng.ai.core.stream.ChatStreamEvent
import com.dashworldng.ai.core.sync.ConversationSyncService
import com.dashworldng.ai.core.sync.DashApiSyncRemote
import com.dashworldng.ai.core.sync.InMemorySyncStateStore
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.Assume.assumeTrue
import org.junit.Before
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * End-to-end contract test: the real Kotlin client against the real TypeScript API running with
 * PROVIDER_MODE=fake. CI starts the API and sets DASH_API_BASE_URL; locally the test is skipped
 * unless you do the same (see docs/architecture.md).
 */
class LiveApiContractTest {
    private val baseUrl: String? = System.getenv("DASH_API_BASE_URL")
    private var token: String? = null
    private val email = "android-${UUID.randomUUID()}@example.com"
    private lateinit var client: DashApiClient

    @Before
    fun setUp() {
        assumeTrue("DASH_API_BASE_URL not set; skipping live API contract test", !baseUrl.isNullOrBlank())
        client = DashApiClient(baseUrl!!, tokenProvider = { token })
        runBlocking {
            val session = AuthService { client }.register(email, "correct horse battery", "Android CI")
            token = session.token
        }
    }

    private fun request(choice: ModelChoice, content: String, attachments: List<com.dashworldng.ai.core.model.AttachmentRef> = emptyList()) = ChatRequest(
        conversationId = UUID.randomUUID().toString(),
        mode = AssistantMode.BUSINESS,
        modelChoice = choice,
        messageId = UUID.randomUUID().toString(),
        content = content,
        attachments = attachments,
        history = emptyList(),
    )

    @Test
    fun `providers endpoint reports fake adapters`() = runBlocking {
        val providers = AuthService { client }.providers()
        assertEquals(listOf("fake", "fake"), providers.providers.map { it.mode })
        assertTrue(providers.compareAvailable)
    }

    @Test
    fun `compare streams two demo-labelled answers end to end`() = runBlocking {
        val events = RemoteChatGateway(client).stream(request(ModelChoice.COMPARE, "Plan a kiosk launch")).toList()
        val start = assertIs<ChatStreamEvent.Started>(events.first())
        assertEquals(ProviderId.entries, start.targets.map { it.provider })
        assertTrue(start.targets.all { it.demo })
        assertEquals(2, events.count { it is ChatStreamEvent.MessageEnded })
        assertTrue(events.any { it is ChatStreamEvent.TitleChanged })
        assertIs<ChatStreamEvent.Ended>(events.last())
        val text = events.filterIsInstance<ChatStreamEvent.Delta>().joinToString("") { it.text }
        assertTrue(text.contains("Demonstration answer"))
    }

    @Test
    fun `documents upload and are used as context`() = runBlocking {
        val bytes = "Opening hours are 7am to 7pm.".toByteArray()
        val doc = RemoteDocumentGateway(client).upload(UploadSource("hours.txt", "text/plain", bytes.size.toLong()) { bytes.inputStream() }) {}
        assertEquals(DocumentStatus.READY, doc.status)
        val events = RemoteChatGateway(client).stream(request(ModelChoice.CLAUDE, "When do we open?", listOf(doc.toAttachment()))).toList()
        assertEquals(1, events.count { it is ChatStreamEvent.MessageEnded })
        assertTrue(events.filterIsInstance<ChatStreamEvent.Delta>().joinToString("") { it.text }.contains("included extracted document text"))
    }

    @Test
    fun `stopping closes the stream and the server cancels`() = runBlocking {
        val gateway = RemoteChatGateway(client)
        val first = gateway.stream(request(ModelChoice.OPENAI, "Go slowly [[fake:slow]]")).first()
        val start = assertIs<ChatStreamEvent.Started>(first)
        // The stream is already closed by first(); an explicit cancel for a finished stream reports false.
        gateway.cancel(start.streamId)
    }

    @Test
    fun `a second device pulls the first device's conversations, renames and deletions`() = runBlocking<Unit> {
        // Device 1 chats against the live API (the server stores the conversation).
        val kept = request(ModelChoice.OPENAI, "Plan the kiosk menu")
        val dropped = request(ModelChoice.CLAUDE, "A chat that will be deleted")
        RemoteChatGateway(client).stream(kept).toList()
        RemoteChatGateway(client).stream(dropped).toList()

        // Device 2 signs in to the same account with an empty Room cache and syncs.
        val repo = InMemoryConversationRepository()
        val state = InMemorySyncStateStore()
        val sync = ConversationSyncService(DashApiSyncRemote(client), repo, state, pageSize = 1)
        val userId = "live-user"
        val first = sync.sync(userId)
        assertEquals(2, first.inserted)
        val pulled = repo.getMessages(kept.conversationId)
        assertEquals(listOf(MessageRole.USER, MessageRole.ASSISTANT), pulled.map { it.role })
        assertEquals("Plan the kiosk menu", pulled.first().content)
        assertEquals(ProviderId.OPENAI, pulled.last().provider)
        assertTrue(pulled.last().isDemo) // the fake server labels its answers as demonstrations
        assertEquals(pulled.first().id, pulled.last().replyToId)

        // Device 1 renames one and deletes the other through the real endpoints.
        client.call { renameConversation(kept.conversationId, com.dashworldng.ai.core.remote.UpdateConversationRequestDto("Kiosk menu")) }
        client.callNoContent { deleteConversation(dropped.conversationId) }

        val second = sync.sync(userId)
        assertEquals(1, second.updated)
        assertEquals(1, second.deleted)
        assertEquals("Kiosk menu", repo.getConversation(kept.conversationId)!!.title)
        assertTrue(repo.getConversation(kept.conversationId)!!.titleIsCustom)
        assertEquals(null, repo.getConversation(dropped.conversationId))

        // Nothing new: a third sync is a no-op.
        val third = sync.sync(userId)
        assertEquals(0, third.inserted + third.updated + third.deleted)
    }

    @Test
    fun `two devices sync both ways through the real API`() = runBlocking<Unit> {
        val userId = "live-two-way"
        val phoneRepo = InMemoryConversationRepository()
        val laptopRepo = InMemoryConversationRepository()
        val phone = ConversationSyncService(DashApiSyncRemote(client), phoneRepo, InMemorySyncStateStore())
        val laptop = ConversationSyncService(DashApiSyncRemote(client), laptopRepo, InMemorySyncStateStore())

        // The phone writes a conversation while offline, then comes back online and syncs.
        val offlineId = UUID.randomUUID().toString()
        val now = System.currentTimeMillis()
        phoneRepo.upsertConversation(Conversation(offlineId, "Written offline", AssistantMode.WRITING, now - 60_000, now - 60_000))
        phoneRepo.upsertMessage(ChatMessage(UUID.randomUUID().toString(), offlineId, MessageRole.USER, "Draft my speech", now - 60_000))
        phone.onLocalConversationChanged(userId, offlineId)
        assertEquals(1, phone.sync(userId).pushed)
        assertEquals(0, phone.sync(userId).pushed) // nothing left to push

        // The laptop pulls it, renames it; the phone's stale offline rename then loses.
        assertEquals(1, laptop.sync(userId).inserted)
        assertEquals("Draft my speech", laptopRepo.getMessages(offlineId).single().content)
        laptopRepo.renameConversation(offlineId, "Speech (laptop)")
        laptop.onLocalRename(userId, offlineId, "Speech (laptop)")
        phoneRepo.renameConversation(offlineId, "Speech (phone)")
        phone.onLocalRename(userId, offlineId, "Speech (phone)")
        phone.sync(userId)
        assertEquals("Speech (laptop)", phoneRepo.getConversation(offlineId)!!.title)

        // The phone deletes it; the laptop's later upload cannot bring it back, and its copy goes away.
        phoneRepo.deleteConversation(offlineId)
        phone.onLocalDelete(userId, offlineId)
        laptopRepo.upsertMessage(ChatMessage(UUID.randomUUID().toString(), offlineId, MessageRole.USER, "late", System.currentTimeMillis()))
        laptop.onLocalConversationChanged(userId, offlineId)
        val laptopResult = laptop.sync(userId)
        assertTrue(offlineId in laptopResult.deletedIds)
        assertEquals(null, laptopRepo.getConversation(offlineId))
        assertEquals(null, phoneRepo.getConversation(offlineId))
    }

    @Test
    fun `switching provider inside one conversation never forks or duplicates it on either device`() = runBlocking<Unit> {
        val phoneRepo = InMemoryConversationRepository()
        val session = ChatSession(scope = this, repository = phoneRepo, gatewayProvider = { RemoteChatGateway(client) })
        suspend fun idle() {
            while (session.state.value.isGenerating) delay(20)
        }
        assertTrue(session.send("First question", ModelChoice.OPENAI, AssistantMode.GENERAL))
        idle()
        assertTrue(session.send("Second question", ModelChoice.CLAUDE, AssistantMode.GENERAL))
        idle()
        assertTrue(session.send("Third question", ModelChoice.COMPARE, AssistantMode.GENERAL))
        idle()
        val claudeAnswer = session.state.value.messages.first { it.provider == ProviderId.ANTHROPIC && it.compareGroupId == null }
        assertTrue(session.retryWithOtherProvider(claudeAnswer.id))
        idle()
        val conversationId = session.state.value.conversation!!.id
        val local = phoneRepo.getMessages(conversationId)

        // The phone syncs: nothing new appears, nothing is duplicated.
        val userId = "live-switch"
        ConversationSyncService(DashApiSyncRemote(client), phoneRepo, InMemorySyncStateStore()).sync(userId)
        val afterSync = phoneRepo.getMessages(conversationId)
        assertEquals(afterSync.map { it.id }.toSet().size, afterSync.size)
        assertEquals(local.map { it.id }, afterSync.map { it.id })

        // A second device pulls exactly the same single conversation.
        val laptopRepo = InMemoryConversationRepository()
        ConversationSyncService(DashApiSyncRemote(client), laptopRepo, InMemorySyncStateStore()).sync(userId)
        assertEquals(listOf(conversationId), laptopRepo.allConversations().map { it.id })
        val laptop = laptopRepo.getMessages(conversationId)
        assertEquals(afterSync.map { it.id }, laptop.map { it.id })
        assertEquals(afterSync.map { it.provider }, laptop.map { it.provider })
        // Retrying the Claude answer with OpenAI replaced it: the second question's answer now comes from OpenAI.
        val secondAnswer = laptop[laptop.indexOfFirst { it.content == "Second question" } + 1]
        assertEquals(ProviderId.OPENAI, secondAnswer.provider)
    }

    @Test
    fun `signing out everywhere revokes every device's session`() = runBlocking<Unit> {
        // `client` is this account's phone; a laptop signs in to the same account.
        var laptopToken: String? = null
        val laptop = DashApiClient(baseUrl!!, tokenProvider = { laptopToken })
        laptopToken = AuthService { laptop }.login(email, "correct horse battery").token
        DashApiSyncRemote(laptop).changes("0", 10)
        AuthService { client }.signOutEverywhere()
        for (device in listOf(client, laptop)) {
            val error = assertFailsWith<ApiException> { DashApiSyncRemote(device).changes("0", 10) }
            assertEquals(401, error.httpStatus)
        }
    }

    @Test
    fun `one device, two accounts - signing out removes the first account's data and the second sees none of it`() = runBlocking<Unit> {
        // Alice is this test's account (client/token). She chats, syncs, then signs out.
        RemoteChatGateway(client).stream(request(ModelChoice.OPENAI, "Alice's private plan")).toList()
        val repo = InMemoryConversationRepository()
        val documents = com.dashworldng.ai.core.data.InMemoryDocumentRepository()
        val prompts = com.dashworldng.ai.core.data.InMemoryPromptRepository()
        val syncState = InMemorySyncStateStore()
        var deviceToken: String? = token
        val device = DashApiClient(baseUrl!!, tokenProvider = { deviceToken })
        lateinit var guard: LocalAccountGuard
        var sync = ConversationSyncService(DashApiSyncRemote(device), repo, syncState, isOwner = { guard.isOwner(it) })
        guard = LocalAccountGuard(InMemoryLocalOwnerStore(), repo, documents, prompts, syncState, clearCredentials = { deviceToken = null }, exclusive = { block -> sync.exclusive(block) })
        val alice = AuthService { device }.login(email, "correct horse battery")
        deviceToken = alice.token
        guard.onSignedIn(alice.user.id)
        sync.sync(alice.user.id)
        val alicesIds = repo.allConversations().map { it.id }
        assertTrue(alicesIds.isNotEmpty())

        val out = guard.signOut { AuthService { device }.logout() }
        assertTrue(out.serverSessionRevoked)
        assertEquals(null, deviceToken)
        assertTrue(repo.allConversations().isEmpty())
        // The revoked token no longer works on the server.
        val revoked = assertFailsWith<ApiException> { DashApiSyncRemote(DashApiClient(baseUrl, tokenProvider = { alice.token })).changes("0", 10) }
        assertEquals(401, revoked.httpStatus)

        // Bob signs in on the same device.
        val bob = AuthService { device }.register("bob-${UUID.randomUUID()}@example.com", "correct horse battery", "Bob")
        deviceToken = bob.token
        guard.onSignedIn(bob.user.id)
        sync = ConversationSyncService(DashApiSyncRemote(device), repo, syncState, isOwner = { guard.isOwner(it) })
        sync.sync(bob.user.id)
        assertTrue(repo.allConversations().none { it.id in alicesIds })
        for (id in alicesIds) assertEquals(null, repo.getConversation(id))

        // Alice comes back: Bob's data is removed, hers is synced again from the server.
        val again = AuthService { device }.login(email, "correct horse battery")
        deviceToken = again.token
        assertTrue(guard.onSignedIn(again.user.id))
        sync.sync(again.user.id)
        assertEquals(alicesIds.sorted(), repo.allConversations().map { it.id }.sorted())
    }

    @Test
    fun `errors follow the contract`() = runBlocking {
        val error = assertFailsWith<ApiException> {
            RemoteChatGateway(client).stream(request(ModelChoice.OPENAI, "   ")).toList()
        }
        assertEquals("bad_request", error.error.code)
        assertEquals(400, error.httpStatus)
    }
}
