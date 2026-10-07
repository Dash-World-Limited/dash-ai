package com.dashworldng.ai.ui.chat

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.dashworldng.ai.core.Limits
import com.dashworldng.ai.core.chat.ChatItem
import com.dashworldng.ai.core.chat.ChatItems
import com.dashworldng.ai.core.chat.ChatSession
import com.dashworldng.ai.core.chat.ChatSessionState
import com.dashworldng.ai.core.documents.UploadSource
import com.dashworldng.ai.core.model.AssistantMode
import com.dashworldng.ai.core.model.Conversation
import com.dashworldng.ai.core.model.DocumentItem
import com.dashworldng.ai.core.model.DocumentStatus
import com.dashworldng.ai.core.model.ModelChoice
import com.dashworldng.ai.core.model.ProviderId
import com.dashworldng.ai.core.presentation.Documents
import com.dashworldng.ai.core.presentation.ProviderAvailability
import com.dashworldng.ai.core.presentation.ProviderOptions
import com.dashworldng.ai.core.presentation.SyncStatuses
import com.dashworldng.ai.core.routing.SmartRouting
import com.dashworldng.ai.core.stream.ApiException
import com.dashworldng.ai.core.sync.ConversationSyncService
import com.dashworldng.ai.data.settings.AccountInfo
import com.dashworldng.ai.di.AppServices
import com.dashworldng.ai.di.ComposerPrefill
import com.dashworldng.ai.di.IncomingShare
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.util.UUID

/** A file in the composer: uploading, ready, or rejected with a reason. */
data class PendingAttachment(
    val localId: String,
    val name: String,
    val sizeBytes: Long,
    val progress: Float = 0f,
    val document: DocumentItem? = null,
    val error: String? = null,
) {
    val uploading: Boolean get() = document == null && error == null
}

data class ChatUiState(
    val session: ChatSessionState = ChatSessionState(),
    val items: List<ChatItem> = emptyList(),
    val composer: String = "",
    val choice: ModelChoice = ModelChoice.SMART,
    val mode: AssistantMode = AssistantMode.GENERAL,
    val attachments: List<PendingAttachment> = emptyList(),
    val demoMode: Boolean = true,
    val online: Boolean = true,
    val providers: ProviderAvailability = ProviderAvailability(),
    val conversations: List<Conversation> = emptyList(),
    val search: String = "",
    val confirmCompare: Boolean = false,
    val notice: String? = null,
    val account: AccountInfo? = null,
    /** Failed answers whose recovery card the user put aside ("Continue later"). */
    val dismissedRecovery: Set<String> = emptySet(),
    /** Plugin id → display name, for tool activity labels (empty until the registry loads). */
    val pluginNames: Map<String, String> = emptyMap(),
) {
    val isGenerating: Boolean get() = session.isGenerating
    val usableAttachments: List<DocumentItem>
        get() = attachments.mapNotNull { it.document }.filter { usableNow(it, demoMode) }
    val canSend: Boolean
        get() = !session.isGenerating &&
            (composer.isNotBlank() || usableAttachments.isNotEmpty()) &&
            attachments.none { it.uploading } &&
            (demoMode || online)
    val recipientLabel: String get() = SmartRouting.recipientLabel(choice, mode, demoMode)

    companion object {
        /** Live mode can only use documents whose text the server extracted. */
        fun usableNow(document: DocumentItem, demoMode: Boolean): Boolean = Documents.usableInChat(document, demoMode)
    }
}

private data class LocalState(
    val composer: String = "",
    val choice: ModelChoice,
    val mode: AssistantMode,
    val attachments: List<PendingAttachment> = emptyList(),
    val providers: ProviderAvailability = ProviderAvailability(),
    val confirmCompare: Boolean = false,
    val notice: String? = null,
    val dismissedRecovery: Set<String> = emptySet(),
    val pluginNames: Map<String, String> = emptyMap(),
)

@OptIn(ExperimentalCoroutinesApi::class)
class ChatViewModel(private val services: AppServices) : ViewModel() {
    private val session = ChatSession(
        scope = viewModelScope,
        repository = services.conversations,
        gatewayProvider = { services.chatGateway() },
        clock = services.clock,
        // Marks live conversations for upload, so messages written while offline reach the server later.
        onUserMessageSaved = { conversationId ->
            val userId = signedInUserId()
            if (userId != null) services.syncService()?.onLocalConversationChanged(userId, conversationId)
        },
    )

    private val initialSettings = services.settings.settings.value
    private val local = MutableStateFlow(LocalState(choice = initialSettings.defaultModelChoice, mode = initialSettings.defaultMode))
    private val search = MutableStateFlow("")
    private val uploads = mutableMapOf<String, Job>()

    private val conversations = search.flatMapLatest { services.conversations.observeConversations(it) }

    val state: StateFlow<ChatUiState> = combine(
        session.state,
        local,
        services.settings.settings,
        services.connectivity.isOnline,
        combine(conversations, search) { list, query -> list to query },
    ) { s, l, settings, online, (list, query) ->
        ChatUiState(
            session = s,
            items = ChatItems.build(s.messages),
            composer = l.composer,
            choice = l.choice,
            mode = l.mode,
            attachments = l.attachments,
            demoMode = settings.demoMode,
            online = online,
            providers = if (settings.demoMode) ProviderAvailability() else l.providers,
            conversations = list,
            search = query,
            confirmCompare = l.confirmCompare,
            notice = l.notice,
            account = settings.account,
            dismissedRecovery = l.dismissedRecovery,
            pluginNames = l.pluginNames,
        )
    }.stateIn(viewModelScope, SharingStarted.Eagerly, ChatUiState(choice = local.value.choice, mode = local.value.mode))

    init {
        // A pull must never overwrite a response that is still streaming.
        services.syncGuard = { !session.state.value.isGenerating }
        viewModelScope.launch {
            services.settings.settings.map { it.demoMode to it.serverUrl }.distinctUntilChanged().collect { (demo, _) ->
                if (!demo) refreshProviders()
            }
        }
        // After sign-in (and whenever the app starts signed in) pull the account's conversations into Room.
        viewModelScope.launch {
            services.settings.settings.map { s -> if (s.demoMode) null else s.account?.takeUnless { it.isDemo }?.userId }.distinctUntilChanged().collect { userId ->
                if (userId != null) syncNow()
            }
        }
        // Another account (or Demo Mode) took over: nothing of the previous one stays on screen.
        viewModelScope.launch {
            services.settings.settings.map { it.account?.userId to it.demoMode }.distinctUntilChanged().drop(1).collect {
                newChat()
                search.value = ""
                local.update { it.copy(notice = null, pluginNames = emptyMap()) }
                loadPluginNames()
            }
        }
        // Coming back online: deliver anything written or changed while offline.
        viewModelScope.launch {
            // A StateFlow already emits only distinct values.
            services.connectivity.isOnline.collect { online ->
                if (online) {
                    syncNow()
                } else if (!services.settings.settings.value.demoMode) {
                    // The connection dropped: an answer that was streaming ends now, kept, with Retry.
                    session.connectionLost()
                }
            }
        }
        viewModelScope.launch {
            services.prefill.pending.filterNotNull().collect {
                services.prefill.consume()?.let(::applyPrefill)
            }
        }
    }

    fun refreshProviders() {
        val auth = services.authService() ?: return
        local.update { it.copy(providers = it.providers.copy(loading = true, error = null)) }
        viewModelScope.launch {
            val result = try {
                ProviderAvailability.from(auth.providers())
            } catch (e: ApiException) {
                // Keep every choice selectable; sending will report the problem clearly.
                ProviderAvailability(error = e.error.message)
            }
            local.update { it.copy(providers = result) }
        }
        loadPluginNames()
    }

    /** Names for tool activity labels. Best effort: without them labels fall back to the plugin id. */
    private fun loadPluginNames() {
        val tools = services.toolsService() ?: return
        if (signedInUserId() == null) return
        viewModelScope.launch {
            try {
                val names = tools.plugins().plugins.associate { it.id to it.name }
                local.update { it.copy(pluginNames = names) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // Labels still work without names.
            }
        }
    }

    fun onComposerChange(text: String) {
        local.update { it.copy(composer = text.take(Limits.MAX_MESSAGE_CHARS)) }
    }

    fun selectMode(mode: AssistantMode) {
        local.update { it.copy(mode = mode) }
    }

    /**
     * Picks the provider for the next messages. Refused while an answer streams (switching never
     * interrupts one) or when the server has not configured it. The choice is remembered.
     */
    fun selectChoice(choice: ModelChoice) {
        val s = state.value
        if (!ProviderOptions.canSwitch(choice, s.providers, s.demoMode, s.isGenerating)) return
        if (choice == ModelChoice.COMPARE && local.value.choice != ModelChoice.COMPARE) {
            local.update { it.copy(confirmCompare = true) }
        } else {
            applyChoice(choice)
        }
    }

    fun confirmCompare(accepted: Boolean) {
        local.update { it.copy(confirmCompare = false) }
        if (accepted) applyChoice(ModelChoice.COMPARE)
    }

    private fun applyChoice(choice: ModelChoice) {
        local.update { it.copy(choice = choice) }
        viewModelScope.launch { services.settings.update { it.copy(defaultModelChoice = choice) } }
    }

    /** Recovery: ask the same provider again. */
    fun retryAnswer(messageId: String) {
        local.update { it.copy(dismissedRecovery = it.dismissedRecovery - messageId) }
        session.regenerate(messageId)
    }

    /** Recovery: the user explicitly picks another provider for this answer and the next ones. */
    fun answerWith(messageId: String, provider: ProviderId) {
        val choice = ModelChoice.forProvider(provider)
        if (!state.value.demoMode && !state.value.providers.isAvailable(choice)) return
        if (session.regenerate(messageId, choice)) applyChoice(choice)
    }

    /** Recovery: keep the failed answer as it is; the conversation is saved and can be resumed. */
    fun continueLater(messageId: String) {
        local.update { it.copy(dismissedRecovery = it.dismissedRecovery + messageId) }
    }

    /** Starts a fresh chat in [mode], optionally with text ready in the composer (Home quick actions). */
    fun startChat(mode: AssistantMode, text: String = "") {
        newChat()
        local.update { it.copy(mode = mode, composer = text) }
    }

    /** Home's prompt field: a new chat that sends right away. */
    fun sendFromHome(text: String) {
        if (text.isBlank()) return
        newChat()
        local.update { it.copy(composer = text.take(Limits.MAX_MESSAGE_CHARS), mode = AssistantMode.GENERAL) }
        send()
    }

    fun useSuggestion(text: String) {
        local.update { it.copy(composer = text) }
    }

    fun send() {
        val current = state.value
        if (!current.canSend) return
        val text = current.composer.trim().ifEmpty { "Summarise the attached document." }
        val attachments = current.usableAttachments.map { it.toAttachment() }
        if (session.send(text, current.choice, current.mode, attachments)) {
            local.update { it.copy(composer = "", attachments = emptyList()) }
        }
    }

    fun stop() = session.stop()

    fun regenerate(messageId: String) {
        session.regenerate(messageId)
    }

    fun retryWithOtherProvider(messageId: String) {
        session.retryWithOtherProvider(messageId)
    }

    fun editAndResend(messageId: String, text: String) {
        val l = local.value
        session.editAndResend(messageId, text, l.choice, l.mode)
    }

    fun retryLast() {
        session.retryLast(local.value.choice)
    }

    fun dismissError() = session.dismissError()

    fun newChat() {
        session.newChat()
        uploads.values.forEach { it.cancel() }
        uploads.clear()
        local.update { it.copy(composer = "", attachments = emptyList(), dismissedRecovery = emptySet()) }
    }

    fun openConversation(id: String) {
        viewModelScope.launch {
            session.open(id)
            val mode = session.state.value.conversation?.mode
            local.update { it.copy(composer = "", attachments = emptyList(), mode = mode ?: it.mode) }
        }
    }

    fun setSearch(query: String) {
        search.value = query
    }

    fun renameConversation(id: String, title: String) {
        val clean = title.trim().take(Limits.MAX_TITLE_CHARS)
        if (clean.isEmpty()) return
        viewModelScope.launch {
            services.conversations.renameConversation(id, clean)
            session.onConversationRenamed(id, clean)
            viewModelScope.launch { syncRemote { onLocalRename(it, id, clean) } }
        }
    }

    fun deleteConversation(id: String) {
        viewModelScope.launch {
            if (session.state.value.conversation?.id == id) newChat()
            services.conversations.deleteConversation(id)
            viewModelScope.launch { syncRemote { onLocalDelete(it, id) } }
            notice("Conversation deleted")
        }
    }

    fun attach(source: UploadSource) {
        if (local.value.attachments.size >= Limits.MAX_ATTACHMENTS_PER_MESSAGE) {
            notice("You can attach up to ${Limits.MAX_ATTACHMENTS_PER_MESSAGE} files to one message.")
            return
        }
        val id = UUID.randomUUID().toString()
        local.update { it.copy(attachments = it.attachments + PendingAttachment(id, source.name, source.sizeBytes)) }
        uploads[id] = viewModelScope.launch {
            try {
                val document = services.documentGateway().upload(source) { progress -> updateAttachment(id) { it.copy(progress = progress) } }
                services.documents.upsert(document)
                val usable = ChatUiState.usableNow(document, services.settings.settings.value.demoMode)
                updateAttachment(id) { it.copy(document = document, progress = 1f, error = if (usable) null else document.statusDetail) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException) {
                updateAttachment(id) { it.copy(error = e.error.message) }
            } catch (e: Exception) {
                updateAttachment(id) { it.copy(error = "The file could not be read.") }
            } finally {
                uploads.remove(id)
            }
        }
    }

    fun removeAttachment(localId: String) {
        uploads.remove(localId)?.cancel()
        local.update { s -> s.copy(attachments = s.attachments.filterNot { it.localId == localId }) }
    }

    fun notice(message: String?) {
        local.update { it.copy(notice = message) }
    }

    private fun updateAttachment(id: String, change: (PendingAttachment) -> PendingAttachment) {
        local.update { s -> s.copy(attachments = s.attachments.map { if (it.localId == id) change(it) else it }) }
    }

    /** "Share → DASH AI": a new chat with the shared text ready to edit and the files attaching. */
    fun receiveShare(share: IncomingShare) {
        newChat()
        local.update { it.copy(composer = share.text.orEmpty()) }
        share.files.forEach(::attach)
        if (share.refused > 0) {
            notice(if (share.refused == 1) "One shared item couldn't be added." else "${share.refused} shared items couldn't be added.")
        }
    }

    private fun applyPrefill(prefill: ComposerPrefill) {
        if (prefill.newChat) newChat()
        local.update { s ->
            s.copy(
                composer = prefill.text,
                mode = prefill.mode ?: s.mode,
                attachments = prefill.documents.map { d -> PendingAttachment(UUID.randomUUID().toString(), d.name, d.sizeBytes, 1f, d) },
            )
        }
        if (prefill.sendNow) send()
    }

    private fun signedInUserId(): String? {
        val settings = services.settings.settings.value
        return if (settings.demoMode) null else settings.account?.takeUnless { it.isDemo }?.userId
    }

    /**
     * Pulls the account's conversations from the server into Room (see ConversationSyncService for the
     * merge rules). Offline or failing syncs are silent: Room keeps working as the local cache.
     */
    fun syncNow() {
        val userId = signedInUserId() ?: return
        val sync = services.syncService() ?: return
        viewModelScope.launch {
            services.syncTracker.started(userId)
            try {
                val result = sync.sync(userId)
                if (result.deferred) services.syncTracker.deferred(userId) else services.syncTracker.succeeded(userId)
                val open = session.state.value.conversation?.id
                // The open conversation was deleted on another device: leave it instead of resurrecting it.
                if (open != null && open in result.deletedIds) newChat()
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException) {
                // Offline, server down or an unexpected response: shown as a sync issue, retried at the next sync.
                services.syncTracker.failed(userId, SyncStatuses.messageFor(e.error))
            } catch (e: Exception) {
                services.syncTracker.failed(userId, SyncStatuses.messageFor(com.dashworldng.ai.core.stream.ApiError.unexpected))
            }
        }
    }

    /** Mirrors a local rename/delete to the server; if that fails it is remembered and retried at the next sync. */
    private suspend fun syncRemote(block: suspend ConversationSyncService.(String) -> Unit) {
        val userId = signedInUserId() ?: return
        val sync = services.syncService() ?: return
        try {
            sync.block(userId)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // Local-first: the change is already applied on this device.
        }
    }
}
