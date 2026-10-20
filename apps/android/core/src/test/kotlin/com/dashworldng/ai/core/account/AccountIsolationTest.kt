package com.dashworldng.ai.core.account

import com.dashworldng.ai.core.data.InMemoryConversationRepository
import com.dashworldng.ai.core.data.InMemoryDocumentRepository
import com.dashworldng.ai.core.data.InMemoryPromptRepository
import com.dashworldng.ai.core.model.AssistantMode
import com.dashworldng.ai.core.model.ChatMessage
import com.dashworldng.ai.core.model.Conversation
import com.dashworldng.ai.core.model.DocumentItem
import com.dashworldng.ai.core.model.DocumentKind
import com.dashworldng.ai.core.model.DocumentStatus
import com.dashworldng.ai.core.model.MessageRole
import com.dashworldng.ai.core.prompts.PromptCategory
import com.dashworldng.ai.core.prompts.PromptItem
import com.dashworldng.ai.core.remote.ConversationMessageDto
import com.dashworldng.ai.core.remote.SyncChangeDto
import com.dashworldng.ai.core.remote.SyncConversationDto
import com.dashworldng.ai.core.remote.SyncOperationResultDto
import com.dashworldng.ai.core.remote.SyncPageDto
import com.dashworldng.ai.core.remote.SyncPushRequestDto
import com.dashworldng.ai.core.remote.SyncPushResponseDto
import com.dashworldng.ai.core.stream.ApiError
import com.dashworldng.ai.core.stream.ApiException
import com.dashworldng.ai.core.sync.ConversationSyncService
import com.dashworldng.ai.core.sync.InMemorySyncStateStore
import com.dashworldng.ai.core.sync.SyncRemote
import com.dashworldng.ai.core.sync.SyncState
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

private fun iso(s: Long) = Instant.parse("2026-05-01T10:00:00Z").plusSeconds(s).toString()

/** A minimal multi-user sync server: each account has its own conversations and change sequence. */
private class Server {
    val data = mutableMapOf<String, MutableList<Pair<Long, SyncConversationDto>>>()
    val messages = mutableMapOf<String, List<ConversationMessageDto>>()
    val pushes = mutableListOf<Pair<String, SyncPushRequestDto>>()
    var online = true
    /** When set, the next pull waits for it (a sync stuck downloading while the user signs out). */
    var gate: CompletableDeferred<Unit>? = null
    private var seq = 0L

    fun put(owner: String, id: String, text: String) {
        val list = data.getOrPut(owner) { mutableListOf() }
        list += (++seq) to SyncConversationDto(id, "Title $id", "general", iso(1), iso(2), false, 0)
        messages[id] = listOf(ConversationMessageDto("m-$id", "user", text, null, null, false, "complete", null, iso(3)))
    }

    fun remote(user: String) = object : SyncRemote {
        override suspend fun changes(cursor: String, limit: Int): SyncPageDto {
            gate?.let { g -> gate = null; g.await() }
            if (!online) throw ApiException(ApiError.network())
            val rows = data[user].orEmpty().filter { it.first > cursor.toLong() }
            return SyncPageDto(
                rows.map { (s, c) -> SyncChangeDto(s, false, c, messages[c.id].orEmpty()) },
                (rows.lastOrNull()?.first ?: cursor.toLong()).toString(),
                (data[user].orEmpty().lastOrNull()?.first ?: 0L).toString(),
                false,
            )
        }

        override suspend fun push(request: SyncPushRequestDto): SyncPushResponseDto {
            if (!online) throw ApiException(ApiError.network())
            pushes += user to request
            return SyncPushResponseDto(request.operations.map { SyncOperationResultDto(it.opId, "applied", 0, 0) })
        }
    }
}

/** One phone: raw repositories, the guard, the fenced views the UI writes through, and a token. */
private class Phone(val server: Server, val owner: LocalOwnerStore = InMemoryLocalOwnerStore()) {
    val conversations = InMemoryConversationRepository()
    val documents = InMemoryDocumentRepository()
    val prompts = InMemoryPromptRepository()
    val syncState = InMemorySyncStateStore()
    var token: String? = null
    var signedInAs: String? = null
    lateinit var guard: LocalAccountGuard
    private var sync: ConversationSyncService? = null

    init {
        rebuildGuard()
    }

    /** A fresh process on the same storage (an app restart). */
    fun rebuildGuard() {
        guard = LocalAccountGuard(owner, conversations, documents, prompts, syncState, clearCredentials = { token = null }, exclusive = { block -> currentSync().exclusive(block) }, serverTimeoutMs = 200)
    }

    private fun currentSync(): ConversationSyncService =
        sync ?: ConversationSyncService(server.remote(signedInAs ?: "nobody"), conversations, syncState, isOwner = { guard.isOwner(it) }).also { sync = it }

    val ui get() = guard.fence(conversations)
    val uiDocuments get() = guard.fence(documents)

    suspend fun signIn(user: String): Boolean {
        token = "token-$user"
        signedInAs = user
        sync = ConversationSyncService(server.remote(user), conversations, syncState, isOwner = { guard.isOwner(it) })
        return guard.onSignedIn(user)
    }

    suspend fun syncNow() = currentSync().sync(signedInAs!!)

    suspend fun signOut(revoke: suspend () -> Unit = {}) = guard.signOut(revoke).also { signedInAs = null }

    suspend fun ids() = conversations.allConversations().map { it.id }.sorted()

    suspend fun everything(): String =
        conversations.allConversations().joinToString { c -> c.id + ":" + c.title + ":" + runBlocking { conversations.getMessages(c.id) }.joinToString { it.content } } +
            documents.observeDocuments().first().joinToString { it.name } + prompts.observeCustomPrompts().first().joinToString { it.body }
}

private fun doc(id: String, demo: Boolean = false) =
    DocumentItem(id, "r-$id", "notes-$id.txt", DocumentKind.TXT, "text/plain", 10, DocumentStatus.READY, "ok", createdAt = 1, isDemo = demo)

class AccountIsolationTest {
    private val server = Server().apply {
        put("alice", "a1", "Alice private plan")
        put("alice", "a2", "Alice medical question")
        put("bob", "b1", "Bob budget")
    }

    @Test
    fun `A signs in and syncs, signs out, B signs in and cannot read anything of A's, A signs back in and re-syncs`() = runBlocking<Unit> {
        val phone = Phone(server)
        phone.signIn("alice")
        phone.syncNow()
        phone.documents.upsert(doc("d-alice"))
        phone.prompts.upsertCustomPrompt(PromptItem("p1", "Mine", "Alice private prompt", PromptCategory.BUSINESS))
        assertEquals(listOf("a1", "a2"), phone.ids())

        val out = phone.signOut()
        assertTrue(out.serverSessionRevoked)
        assertNull(phone.token)
        assertEquals("", phone.everything())
        assertEquals(SyncState(), phone.syncState.load())

        assertFalse(phone.signIn("bob"), "nothing of Alice's was left to remove")
        phone.syncNow()
        assertEquals(listOf("b1"), phone.ids())
        assertFalse(phone.everything().contains("Alice"))
        // Alice's conversation ids are unknown to Bob's device state, and the server keeps them.
        assertNull(phone.conversations.getConversation("a1"))
        assertEquals(2, server.data["alice"]!!.size)

        // Alice comes back (Bob did not sign out: switching accounts removes Bob's data first).
        assertTrue(phone.signIn("alice"))
        phone.syncNow()
        assertEquals(listOf("a1", "a2"), phone.ids())
        assertFalse(phone.everything().contains("Bob"))
    }

    @Test
    fun `offline sign-out still removes everything locally and says the server session was not revoked`() = runBlocking<Unit> {
        val phone = Phone(server)
        phone.signIn("alice")
        phone.syncNow()
        server.online = false
        val out = phone.signOut { throw ApiException(ApiError.network()) }
        assertFalse(out.serverSessionRevoked)
        assertNull(phone.token)
        assertEquals(emptyList(), phone.ids())
    }

    @Test
    fun `a server that never answers cannot hold the sign-out (bounded wait)`() = runBlocking<Unit> {
        val phone = Phone(server)
        phone.signIn("alice")
        phone.syncNow()
        val started = System.currentTimeMillis()
        val out = phone.signOut { awaitCancellation() }
        assertTrue(System.currentTimeMillis() - started < 2_000)
        assertFalse(out.serverSessionRevoked)
        assertEquals(emptyList(), phone.ids())
    }

    @Test
    fun `repeated sign-out is harmless`() = runBlocking<Unit> {
        val phone = Phone(server)
        phone.signIn("alice")
        phone.syncNow()
        assertFalse(phone.signOut().alreadySignedOut)
        val again = phone.signOut()
        assertTrue(again.alreadySignedOut)
        assertEquals(0, again.discardedPendingChanges)
        assertEquals(emptyList(), phone.ids())
    }

    @Test
    fun `unsynced local changes are counted before and discarded by sign-out, and never reach the next account`() = runBlocking<Unit> {
        val phone = Phone(server)
        phone.signIn("alice")
        phone.syncNow()
        server.online = false
        for (id in listOf("off1", "off2")) {
            phone.ui.upsertConversation(Conversation(id, "Offline $id", AssistantMode.GENERAL, 1, 1))
            phone.ui.upsertMessage(ChatMessage("m-$id", id, MessageRole.USER, "Alice offline secret", 2))
            ConversationSyncService(server.remote("alice"), phone.conversations, phone.syncState, isOwner = { phone.guard.isOwner(it) }).onLocalConversationChanged("alice", id)
        }
        assertEquals(2, phone.guard.pendingLocalChanges())
        val out = phone.signOut()
        assertEquals(2, out.discardedPendingChanges)
        server.online = true
        phone.signIn("bob")
        phone.syncNow()
        assertTrue(server.pushes.none { (_, request) -> request.operations.any { it.conversation?.id?.startsWith("off") == true } })
        assertFalse(phone.everything().contains("Alice"))
    }

    @Test
    fun `signing out while a sync is still downloading - the sync writes nothing and the next account sees nothing`() = runBlocking<Unit> {
        val phone = Phone(server)
        phone.signIn("alice")
        val gate = CompletableDeferred<Unit>()
        server.gate = gate
        coroutineScope {
            val syncing = async { runCatching { phone.syncNow() } }
            yield()
            delay(20) // the sync is now waiting for Alice's page
            val signingOut = async { phone.signOut() }
            delay(20)
            gate.complete(Unit) // Alice's page arrives after she signed out
            syncing.await()
            signingOut.await()
        }
        assertEquals(emptyList(), phone.ids())
        assertEquals(SyncState(), phone.syncState.load())
        phone.signIn("bob")
        phone.syncNow()
        assertEquals(listOf("b1"), phone.ids())
    }

    @Test
    fun `an answer still streaming for the signed-out account cannot write it back`() = runBlocking<Unit> {
        val phone = Phone(server)
        phone.signIn("alice")
        phone.syncNow()
        val stale = phone.ui // the chat session's view, created while Alice was signed in
        phone.signOut()
        stale.upsertMessage(ChatMessage("late", "a1", MessageRole.ASSISTANT, "Alice late answer", 9))
        stale.upsertConversation(Conversation("a1", "Title a1", AssistantMode.GENERAL, 1, 9))
        stale.renameConversation("a1", "renamed")
        assertEquals(emptyList(), phone.ids())
        phone.signIn("bob")
        stale.upsertMessage(ChatMessage("later", "a1", MessageRole.ASSISTANT, "Alice even later", 10))
        assertNull(phone.conversations.getConversation("a1"))
        // A late upload from Alice's session is refused too; demo documents are always welcome.
        phone.signOut()
        phone.uiDocuments.upsert(doc("late-upload"))
        phone.uiDocuments.upsert(doc("demo-doc", demo = true))
        assertEquals(listOf("demo-doc"), phone.documents.observeDocuments().first().map { it.id })
    }

    @Test
    fun `after signing back in, the same account can write to its re-synced conversations again`() = runBlocking<Unit> {
        val phone = Phone(server)
        phone.signIn("alice")
        phone.syncNow()
        phone.signOut()
        phone.signIn("alice")
        phone.syncNow()
        phone.ui.upsertMessage(ChatMessage("new", "a1", MessageRole.USER, "follow-up", 20))
        assertTrue(phone.conversations.getMessages("a1").any { it.id == "new" })
    }

    @Test
    fun `an interrupted sign-out is finished at the next start, before anything is shown`() = runBlocking<Unit> {
        val phone = Phone(server)
        phone.signIn("alice")
        phone.syncNow()
        // The app died right after recording the sign-out.
        phone.owner.save(LocalOwnerState(userId = "alice", wipePending = true))
        phone.rebuildGuard()
        phone.guard.recover()
        assertEquals(emptyList(), phone.ids())
        assertEquals(LocalOwnerState(), phone.owner.load())
        assertFalse(phone.guard.isOwner("alice"))
    }

    @Test
    fun `an account signed in before this version is adopted at start-up, never another one`() = runBlocking<Unit> {
        val phone = Phone(server)
        // Signed in with an older app version: local data exists, but no ownership record.
        phone.signedInAs = "alice"
        phone.conversations.upsertConversation(Conversation("local-1", "Kept", AssistantMode.GENERAL, 1, 1))
        assertTrue(phone.syncNow().deferred, "until adopted, the account is not the recorded owner: sync waits")
        assertTrue(phone.guard.adoptExisting("alice"))
        assertEquals(listOf("local-1"), phone.ids()) // nothing removed
        phone.syncNow()
        assertEquals(listOf("a1", "a2", "local-1"), phone.ids())
        phone.uiDocuments.upsert(doc("upload-after-upgrade"))
        assertEquals(1, phone.documents.observeDocuments().first().size) // uploads work for the adopted owner
        assertFalse(phone.guard.adoptExisting("bob")) // a recorded owner is never replaced this way
        assertTrue(phone.guard.isOwner("alice"))
    }

    @Test
    fun `unreadable ownership state is treated as a pending wipe`() {
        assertEquals(LocalOwnerState(wipePending = true), LocalOwnerState.decode("{not json"))
        assertEquals(LocalOwnerState(), LocalOwnerState.decode(null))
        val round = LocalOwnerState(userId = "alice")
        assertEquals(round, LocalOwnerState.decode(LocalOwnerState.encode(round)))
    }

    @Test
    fun `Demo Mode keeps working after a sign-out`() = runBlocking<Unit> {
        val phone = Phone(server)
        phone.signIn("alice")
        phone.syncNow()
        phone.signOut()
        phone.ui.upsertConversation(Conversation("demo-1", "Demo chat", AssistantMode.GENERAL, 1, 1, isDemo = true))
        phone.ui.upsertMessage(ChatMessage("dm", "demo-1", MessageRole.USER, "hello demo", 2, isDemo = true))
        assertEquals(listOf("demo-1"), phone.ids())
        assertTrue(phone.guard.pendingLocalChanges() == 0)
    }

    @Test
    fun `Demo Mode without an account never shows data an account still owns`() = runBlocking<Unit> {
        val phone = Phone(server)
        phone.signIn("alice")
        phone.syncNow()
        var revoked = false
        val out = phone.guard.releaseForDemo { revoked = true }
        assertTrue(out != null && out.serverSessionRevoked && revoked)
        assertNull(phone.token)
        assertEquals("", phone.everything())
        assertFalse(phone.guard.isOwner("alice"))
    }

    @Test
    fun `releasing for Demo Mode keeps Demo Mode's own chats and touches no credentials when no account owns the data`() = runBlocking<Unit> {
        val phone = Phone(server)
        phone.token = "unrelated"
        phone.ui.upsertConversation(Conversation("demo-1", "Demo chat", AssistantMode.GENERAL, 1, 1, isDemo = true))
        assertNull(phone.guard.releaseForDemo { error("no server call when nothing belongs to an account") })
        assertEquals(listOf("demo-1"), phone.ids())
        assertEquals("unrelated", phone.token)
    }

    @Test
    fun `releasing for Demo Mode finishes an interrupted sign-out`() = runBlocking<Unit> {
        val owner = InMemoryLocalOwnerStore(LocalOwnerState(userId = "alice", wipePending = true))
        val phone = Phone(server, owner)
        phone.conversations.upsertConversation(Conversation("a1", "Alice left over", AssistantMode.GENERAL, 1, 1))
        phone.rebuildGuard()
        assertTrue(phone.guard.releaseForDemo {} != null)
        assertEquals(emptyList(), phone.ids())
        assertEquals(LocalOwnerState(), owner.state)
    }

    @Test
    fun `a sync started for an account that is no longer signed in does nothing`() = runBlocking<Unit> {
        val phone = Phone(server)
        phone.signIn("alice")
        val aliceSync = ConversationSyncService(server.remote("alice"), phone.conversations, phone.syncState, isOwner = { phone.guard.isOwner(it) })
        phone.signOut()
        phone.signIn("bob")
        assertTrue(aliceSync.sync("alice").deferred)
        assertEquals(emptyList(), phone.ids())
    }
}
