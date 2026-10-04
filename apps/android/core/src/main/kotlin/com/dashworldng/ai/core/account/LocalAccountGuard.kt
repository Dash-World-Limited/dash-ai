package com.dashworldng.ai.core.account

import com.dashworldng.ai.core.data.ConversationRepository
import com.dashworldng.ai.core.data.DocumentRepository
import com.dashworldng.ai.core.data.PromptRepository
import com.dashworldng.ai.core.model.ChatMessage
import com.dashworldng.ai.core.model.Conversation
import com.dashworldng.ai.core.model.DocumentItem
import com.dashworldng.ai.core.remote.DashJson
import com.dashworldng.ai.core.sync.SyncState
import com.dashworldng.ai.core.sync.SyncStateStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.Serializable

/**
 * Which account the data on this device belongs to.
 *
 * @property userId the signed-in account whose data is stored locally (null: nobody, or Demo Mode only).
 * @property wipePending a sign-out started but may not have finished removing that account's data;
 *   it is completed at the next start ([LocalAccountGuard.recover]) before anything is shown.
 */
@Serializable
data class LocalOwnerState(val userId: String? = null, val wipePending: Boolean = false) {
    companion object {
        fun encode(state: LocalOwnerState): String = DashJson.default.encodeToString(serializer(), state)

        /**
         * Unreadable state is treated as "a wipe is pending": when we cannot tell whose data this is,
         * removing it is the safe choice.
         */
        fun decode(text: String?): LocalOwnerState =
            if (text == null) LocalOwnerState()
            else runCatching { DashJson.default.decodeFromString(serializer(), text) }.getOrElse { LocalOwnerState(wipePending = true) }
    }
}

interface LocalOwnerStore {
    suspend fun load(): LocalOwnerState
    suspend fun save(state: LocalOwnerState)
}

class InMemoryLocalOwnerStore(initial: LocalOwnerState = LocalOwnerState()) : LocalOwnerStore {
    @Volatile var state: LocalOwnerState = initial
        private set

    override suspend fun load(): LocalOwnerState = state
    override suspend fun save(state: LocalOwnerState) {
        this.state = state
    }
}

/**
 * @property serverSessionRevoked false when the server could not be reached (offline): the token
 *   was still removed from this device, but the session stays valid on the server until it expires.
 *   The app should suggest "sign out everywhere" from another device if the phone is lost.
 * @property discardedPendingChanges local changes (uploads, renames, deletions) that had not reached
 *   the server and were discarded with the rest of the account's local data.
 * @property alreadySignedOut nothing was signed in; nothing changed (repeated sign-out is harmless).
 */
data class SignOutResult(
    val serverSessionRevoked: Boolean,
    val discardedPendingChanges: Int,
    val alreadySignedOut: Boolean = false,
)

/**
 * Keeps one person's data on a shared device away from the next person.
 *
 * Policy (deterministic):
 * - The device stores one account's data at a time. Signing out always completes on the device,
 *   online or offline: the server session is revoked if the server can be reached (best effort,
 *   bounded wait), the token is removed, and every local conversation, message, document, custom
 *   prompt and sync record is deleted. Unsynced local changes are discarded; the app can show
 *   [pendingLocalChanges] before the user confirms.
 * - Signing in as a different account than the one the local data belongs to removes that data first
 *   (covers an interrupted sign-out, or switching accounts without signing out).
 * - Signing back in re-syncs the account from the server.
 * - Demo Mode keeps working: it starts empty after a sign-out.
 * - Nothing here deletes server data: only `logout` (this session) is called on the server.
 *
 * The wipe runs twice: at once (so nothing is visible even while a sync is still downloading), and
 * again once any in-flight sync has finished ([exclusive] is the sync service's lock), because a
 * write already under way when the account changed could otherwise land after the first wipe. A sync
 * started for the old account checks [isOwner] and writes nothing more.
 */
class LocalAccountGuard(
    private val owner: LocalOwnerStore,
    private val conversations: ConversationRepository,
    private val documents: DocumentRepository,
    private val prompts: PromptRepository,
    private val syncState: SyncStateStore,
    private val clearCredentials: suspend () -> Unit,
    private val exclusive: suspend (suspend () -> Unit) -> Unit = { it() },
    private val serverTimeoutMs: Long = 5_000,
) {
    private val mutex = Mutex()
    @Volatile private var cachedOwner: String? = null
    @Volatile private var loaded = false
    /** Conversation and document ids removed by wipes, with the account they belonged to. */
    private val fenced = mutableMapOf<String, String>()
    private val fencedLock = Any()

    /** Call at app start, before showing data: finishes an interrupted sign-out. */
    suspend fun recover() = mutex.withLock {
        val state = owner.load()
        if (state.wipePending) {
            wipeEverywhere(state.userId)
            owner.save(LocalOwnerState())
            cachedOwner = null
        } else {
            cachedOwner = state.userId
        }
        loaded = true
    }

    /**
     * True while [userId]'s data is the data on this device. Syncs and writes check it. Never takes
     * the guard's lock (a sync holding its own lock calls this while a sign-out may be waiting for it).
     */
    suspend fun isOwner(userId: String): Boolean {
        ensureLoaded()
        return cachedOwner == userId
    }

    private suspend fun ensureLoaded() {
        if (loaded) return
        val state = owner.load()
        cachedOwner = if (state.wipePending) null else state.userId
        loaded = true
    }

    /** Local changes that have not reached the server and would be discarded by signing out now. */
    suspend fun pendingLocalChanges(): Int {
        val s = syncState.load()
        val current = owner.load().userId ?: return 0
        if (s.userId != current) return 0
        return (s.pendingUploads + s.pendingDeletes + s.pendingRenames.keys).size
    }

    /**
     * For an account that was already signed in before this ownership record existed (an app
     * upgrade): records it as the owner of the local data, without removing anything. Does nothing
     * when another account is recorded or a wipe is pending. Returns true when it adopted.
     */
    suspend fun adoptExisting(userId: String): Boolean = mutex.withLock {
        loaded = true
        val state = owner.load()
        if (state.userId != null || state.wipePending) return@withLock false
        owner.save(LocalOwnerState(userId = userId))
        cachedOwner = userId
        true
    }

    /**
     * Call after a successful sign-in, before syncing. Removes another account's leftover data.
     * Returns true when something was removed.
     */
    suspend fun onSignedIn(userId: String): Boolean = mutex.withLock {
        loaded = true
        val state = owner.load()
        val foreign = state.wipePending || (state.userId != null && state.userId != userId)
        if (foreign) {
            owner.save(state.copy(wipePending = true))
            cachedOwner = null
            wipeEverywhere(state.userId)
        }
        synchronized(fencedLock) { fenced.entries.removeIf { it.value == userId } }
        owner.save(LocalOwnerState(userId = userId))
        cachedOwner = userId
        loaded = true
        foreign
    }

    /**
     * Signs out on this device. [revokeServerSession] is called before the token is removed (it
     * needs it); its failure or a timeout never stops the local sign-out.
     */
    suspend fun signOut(revokeServerSession: suspend () -> Unit): SignOutResult = mutex.withLock {
        loaded = true
        val state = owner.load()
        if (state.userId == null && !state.wipePending) {
            clearCredentials()
            return@withLock SignOutResult(serverSessionRevoked = false, discardedPendingChanges = 0, alreadySignedOut = true)
        }
        val discarded = pendingLocalChangesFor(state.userId)
        // Record the intent first: if the app dies from here on, recover() finishes the job.
        owner.save(state.copy(wipePending = true))
        cachedOwner = null
        val revoked = withTimeoutOrNull(serverTimeoutMs) { runCatching { revokeServerSession() }.isSuccess } ?: false
        clearCredentials()
        wipeEverywhere(state.userId)
        owner.save(LocalOwnerState())
        SignOutResult(serverSessionRevoked = revoked, discardedPendingChanges = discarded)
    }

    /** Whether a write coming from the UI or a running answer may touch this conversation. */
    internal fun allowsConversation(id: String): Boolean = synchronized(fencedLock) { id !in fenced }
    internal suspend fun allowsDocument(document: DocumentItem): Boolean {
        ensureLoaded()
        return synchronized(fencedLock) { document.id !in fenced } && (document.isDemo || cachedOwner != null)
    }

    private suspend fun pendingLocalChangesFor(userId: String?): Int {
        val s = syncState.load()
        if (userId == null || s.userId != userId) return 0
        return (s.pendingUploads + s.pendingDeletes + s.pendingRenames.keys).size
    }

    private suspend fun wipeEverywhere(previousOwner: String?) {
        wipe(previousOwner)
        exclusive { wipe(previousOwner) }
    }

    private suspend fun wipe(previousOwner: String?) {
        val conversationIds = conversations.allConversations().map { it.id }
        val documentIds = documents.observeDocuments().first().map { it.id }
        synchronized(fencedLock) {
            val label = previousOwner ?: ANONYMOUS
            conversationIds.forEach { fenced[it] = label }
            documentIds.forEach { fenced[it] = label }
        }
        conversations.deleteAll()
        documents.deleteAll()
        prompts.deleteAll()
        syncState.save(SyncState())
    }

    /** Wraps the repository the UI and chat sessions write through (sync writes to the raw one). */
    fun fence(repository: ConversationRepository): ConversationRepository = FencedConversationRepository(repository, this)

    fun fence(repository: DocumentRepository): DocumentRepository = FencedDocumentRepository(repository, this)

    private companion object {
        const val ANONYMOUS = "\u0000anonymous"
    }
}

/**
 * Drops writes that target data removed by a sign-out: an answer still streaming for the previous
 * account cannot recreate its conversation or messages for the next person. Reads pass through.
 */
private class FencedConversationRepository(
    private val delegate: ConversationRepository,
    private val guard: LocalAccountGuard,
) : ConversationRepository by delegate {
    override suspend fun upsertConversation(conversation: Conversation) {
        if (guard.allowsConversation(conversation.id)) delegate.upsertConversation(conversation)
    }

    override suspend fun renameConversation(id: String, title: String) {
        if (guard.allowsConversation(id)) delegate.renameConversation(id, title)
    }

    override suspend fun upsertMessage(message: ChatMessage) {
        if (guard.allowsConversation(message.conversationId)) delegate.upsertMessage(message)
    }

    override fun observeConversations(query: String): Flow<List<Conversation>> = delegate.observeConversations(query)
}

/** Drops a document write that belongs to a signed-out account (an upload finishing after sign-out). */
private class FencedDocumentRepository(
    private val delegate: DocumentRepository,
    private val guard: LocalAccountGuard,
) : DocumentRepository by delegate {
    override suspend fun upsert(document: DocumentItem) {
        if (guard.allowsDocument(document)) delegate.upsert(document)
    }
}
