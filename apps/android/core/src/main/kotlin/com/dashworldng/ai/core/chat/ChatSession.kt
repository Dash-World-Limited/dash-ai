package com.dashworldng.ai.core.chat

import com.dashworldng.ai.core.Limits
import com.dashworldng.ai.core.data.ConversationRepository
import com.dashworldng.ai.core.model.AssistantMode
import com.dashworldng.ai.core.model.AttachmentRef
import com.dashworldng.ai.core.model.ChatMessage
import com.dashworldng.ai.core.model.Conversation
import com.dashworldng.ai.core.model.FinishReason
import com.dashworldng.ai.core.model.MessageRole
import com.dashworldng.ai.core.model.MessageStatus
import com.dashworldng.ai.core.model.ModelChoice
import com.dashworldng.ai.core.model.AnswerRecovery
import com.dashworldng.ai.core.model.ToolCallStatus
import com.dashworldng.ai.core.model.ToolUse
import com.dashworldng.ai.core.routing.ContextBuilder
import com.dashworldng.ai.core.stream.ApiError
import com.dashworldng.ai.core.stream.ApiException
import com.dashworldng.ai.core.stream.ChatStreamEvent
import com.dashworldng.ai.core.util.Clock
import com.dashworldng.ai.core.util.IdGenerator
import com.dashworldng.ai.core.util.MonotonicClock
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class ChatSessionState(
    val conversation: Conversation? = null,
    val messages: List<ChatMessage> = emptyList(),
    val isGenerating: Boolean = false,
    val activeStreamId: String? = null,
    /** A request-level failure (e.g. offline, provider not configured). Per-answer failures live on messages. */
    val error: ApiError? = null,
    /**
     * Tools each answer used in this session (message id → calls, in order). Metadata only, kept in
     * memory: a reopened conversation shows its text, not its past tool activity.
     */
    val toolUses: Map<String, List<ToolUse>> = emptyMap(),
    /** Recovery options for answers that failed in this session (message id → options from the server). */
    val recovery: Map<String, AnswerRecovery> = emptyMap(),
) {
    val isEmpty: Boolean get() = messages.isEmpty()
    val lastUserMessage: ChatMessage? get() = messages.lastOrNull { it.isUser }
}

/**
 * The conversation state machine: sending, streaming, stopping, regenerating, retrying with the
 * other provider, editing and resending, and Compare. Pure Kotlin so it is unit-tested on the JVM;
 * the Android ViewModel is a thin wrapper around it.
 *
 * All public functions must be called from the scope's (single-threaded) dispatcher.
 */
class ChatSession(
    private val scope: CoroutineScope,
    private val repository: ConversationRepository,
    private val gatewayProvider: () -> ChatGateway,
    clock: Clock = Clock.System,
    private val ids: IdGenerator = IdGenerator.Uuid,
    /**
     * Called after a live (non-demo) user message is saved locally, so sync can upload it if the request
     * never reaches the server. Failures are the callback's own business and never affect the chat.
     */
    private val onUserMessageSaved: suspend (conversationId: String) -> Unit = {},
) {
    private val time = MonotonicClock(clock)
    private val _state = MutableStateFlow(ChatSessionState())
    val state: StateFlow<ChatSessionState> = _state.asStateFlow()

    private var job: Job? = null
    private var activeGateway: ChatGateway? = null

    /** Loads a saved conversation. Answers interrupted by an app restart are shown as stopped. */
    suspend fun open(conversationId: String) {
        cancelCurrent()
        val conversation = repository.getConversation(conversationId)
        if (conversation == null) {
            _state.value = ChatSessionState()
            return
        }
        val messages = repository.getMessages(conversationId).map { m ->
            if (m.status == MessageStatus.STREAMING) m.copy(status = MessageStatus.STOPPED).also { repository.upsertMessage(it) } else m
        }
        // Tool activity recorded with each answer comes back with it; nothing is shown for answers without any.
        val tools = messages.filter { it.tools.isNotEmpty() }.associate { it.id to it.tools }
        _state.value = ChatSessionState(conversation = conversation, messages = messages, toolUses = tools)
    }

    fun newChat() {
        cancelCurrent()
        _state.value = ChatSessionState()
    }

    /** Sends a new user message. Returns false if nothing was sent. */
    fun send(
        text: String,
        choice: ModelChoice,
        mode: AssistantMode,
        attachments: List<AttachmentRef> = emptyList(),
    ): Boolean {
        val content = text.trim()
        if (content.isEmpty() || content.length > Limits.MAX_MESSAGE_CHARS || _state.value.isGenerating) return false
        if (attachments.size > Limits.MAX_ATTACHMENTS_PER_MESSAGE) return false
        val now = time.next()
        val gateway = gatewayProvider()
        val base = _state.value.conversation?.copy(updatedAt = now, mode = mode)
            ?: Conversation(
                id = ids.newId(),
                title = TitleGenerator.DEFAULT_TITLE,
                mode = mode,
                createdAt = now,
                updatedAt = now,
                isDemo = gateway.isDemo,
            )
        val conversation = if (!base.titleIsCustom && base.title == TitleGenerator.DEFAULT_TITLE) {
            base.copy(title = TitleGenerator.generate(content))
        } else {
            base
        }
        val user = ChatMessage(
            id = ids.newId(),
            conversationId = conversation.id,
            role = MessageRole.USER,
            content = content,
            createdAt = now,
            modelChoice = choice,
            attachments = attachments,
        )
        _state.update { it.copy(conversation = conversation, messages = it.messages + user, error = null) }
        generate(gateway, conversation, user, choice, mode, deleteIds = emptyList())
        return true
    }

    /** Stops generation. Partial answers are kept and marked as stopped. */
    fun stop() {
        val current = job ?: return
        val streamId = _state.value.activeStreamId
        val gateway = activeGateway
        current.cancel(CancellationException("Stopped by user"))
        if (streamId != null && gateway != null) {
            scope.launch { runCatching { gateway.cancel(streamId) } }
        }
    }

    /** Generates the answer to [assistantMessageId]'s question again (replacing it). */
    fun regenerate(assistantMessageId: String, choiceOverride: ModelChoice? = null): Boolean {
        val messages = _state.value.messages
        val assistant = messages.firstOrNull { it.id == assistantMessageId && it.isAssistant } ?: return false
        val user = messages.firstOrNull { it.id == assistant.replyToId } ?: return false
        val choice = choiceOverride ?: assistant.modelChoice ?: user.modelChoice ?: ModelChoice.SMART
        return resend(user, user.content, choice, _state.value.conversation?.mode ?: AssistantMode.GENERAL)
    }

    /** Replaces a single-provider answer with one from the other provider. Not available for Compare answers. */
    fun retryWithOtherProvider(assistantMessageId: String): Boolean {
        val assistant = _state.value.messages.firstOrNull { it.id == assistantMessageId } ?: return false
        val provider = assistant.provider ?: return false
        if (assistant.compareGroupId != null) return false
        return regenerate(assistantMessageId, ModelChoice.forProvider(provider.other))
    }

    /** Edits a previous user message and resends it. Everything after it is replaced. */
    fun editAndResend(userMessageId: String, newText: String, choice: ModelChoice, mode: AssistantMode): Boolean {
        val user = _state.value.messages.firstOrNull { it.id == userMessageId && it.isUser } ?: return false
        val content = newText.trim()
        if (content.isEmpty() || content.length > Limits.MAX_MESSAGE_CHARS) return false
        return resend(user, content, choice, mode)
    }

    /** Retries the last user message after a request-level failure. */
    fun retryLast(choice: ModelChoice? = null): Boolean {
        val user = _state.value.lastUserMessage ?: return false
        val mode = _state.value.conversation?.mode ?: AssistantMode.GENERAL
        return resend(user, user.content, choice ?: user.modelChoice ?: ModelChoice.SMART, mode)
    }

    fun dismissError() {
        _state.update { it.copy(error = null) }
    }

    /** Applies a rename made elsewhere (e.g. the history drawer) to the open conversation. */
    fun onConversationRenamed(conversationId: String, title: String) {
        activeGeneration?.takeIf { it.isCurrent && it.conversation.id == conversationId }?.let {
            it.conversation = it.conversation.copy(title = title, titleIsCustom = true)
        }
        _state.update { s ->
            val c = s.conversation
            if (c?.id == conversationId) s.copy(conversation = c.copy(title = title, titleIsCustom = true)) else s
        }
    }

    private fun resend(user: ChatMessage, content: String, choice: ModelChoice, mode: AssistantMode): Boolean {
        if (_state.value.isGenerating) return false
        val conversation = _state.value.conversation ?: return false
        val messages = _state.value.messages
        val index = messages.indexOfFirst { it.id == user.id }
        if (index == -1) return false
        val removed = messages.drop(index + 1).map { it.id }
        // Same id and timestamp: the API replaces the message and everything after it.
        val updatedUser = user.copy(content = content, modelChoice = choice)
        val updatedConversation = conversation.copy(updatedAt = time.next(), mode = mode)
        _state.update {
            it.copy(
                conversation = updatedConversation,
                messages = messages.take(index) + updatedUser,
                error = null,
                toolUses = it.toolUses - removed.toSet(),
                recovery = it.recovery - removed.toSet(),
            )
        }
        generate(gatewayProvider(), updatedConversation, updatedUser, choice, mode, removed)
        return true
    }

    /** One request's answers. Only the current generation may change the visible state. */
    private inner class Generation(
        val id: Long,
        var conversation: Conversation,
        val user: ChatMessage,
        val choice: ModelChoice,
    ) {
        val answers = LinkedHashMap<String, ChatMessage>()
        /** Tools each answer used, kept here so they are saved with it even when it is not on screen. */
        val tools = HashMap<String, List<ToolUse>>()
        val isCurrent: Boolean get() = currentGeneration == id
    }

    private var currentGeneration = 0L
    private var activeGeneration: Generation? = null

    private fun applyToState(generation: Generation, change: (ChatSessionState) -> ChatSessionState) {
        if (generation.isCurrent) _state.update(change)
    }

    private fun generate(
        gateway: ChatGateway,
        conversation: Conversation,
        user: ChatMessage,
        choice: ModelChoice,
        mode: AssistantMode,
        deleteIds: List<String>,
    ) {
        val earlier = _state.value.messages.takeWhile { it.id != user.id }
        val request = ChatRequest(
            conversationId = conversation.id,
            mode = mode,
            modelChoice = choice,
            messageId = user.id,
            content = user.content,
            attachments = user.attachments,
            history = ContextBuilder.history(earlier, choice),
        )
        val generation = Generation(++currentGeneration, conversation, user, choice)
        activeGeneration = generation
        activeGateway = gateway
        _state.update { it.copy(isGenerating = true, activeStreamId = null) }

        job = scope.launch {
            try {
                if (deleteIds.isNotEmpty()) repository.deleteMessages(deleteIds)
                repository.upsertConversation(conversation)
                repository.upsertMessage(user)
                if (!gateway.isDemo && !conversation.isDemo) {
                    try {
                        onUserMessageSaved(conversation.id)
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        // Sync bookkeeping must never break sending.
                    }
                }
                gateway.stream(request).collect { event -> handle(generation, event) }
                // A well-behaved stream ends every answer; anything still streaming ended unexpectedly.
                finish(generation, MessageStatus.FAILED, "The response ended unexpectedly.")
            } catch (e: CancellationException) {
                withContext(NonCancellable) { finish(generation, MessageStatus.STOPPED, null) }
                throw e
            } catch (e: ApiException) {
                failRequest(generation, e.error)
            } catch (e: Exception) {
                failRequest(generation, ApiError.unexpected)
            } finally {
                withContext(NonCancellable) {
                    val touched = generation.conversation.copy(updatedAt = time.next())
                    generation.conversation = touched
                    applyToState(generation) { it.copy(isGenerating = false, activeStreamId = null, conversation = touched) }
                    repository.upsertConversation(touched)
                }
            }
        }
    }

    private suspend fun handle(generation: Generation, event: ChatStreamEvent) {
        when (event) {
            is ChatStreamEvent.Started -> {
                val placeholders = event.targets.map { t ->
                    ChatMessage(
                        id = t.messageId,
                        conversationId = generation.user.conversationId,
                        role = MessageRole.ASSISTANT,
                        content = "",
                        createdAt = time.next(),
                        status = MessageStatus.STREAMING,
                        provider = t.provider,
                        model = t.model,
                        isDemo = t.demo,
                        modelChoice = generation.choice,
                        compareGroupId = event.compareGroupId,
                        replyToId = generation.user.id,
                        routingReason = event.routingReason,
                    )
                }
                placeholders.forEach { generation.answers[it.id] = it }
                applyToState(generation) { it.copy(messages = it.messages + placeholders, activeStreamId = event.streamId) }
                placeholders.forEach { repository.upsertMessage(it) }
            }
            is ChatStreamEvent.Delta -> updateAnswer(generation, event.messageId, persist = false) {
                it.copy(content = it.content + event.text)
            }
            is ChatStreamEvent.MessageEnded -> updateAnswer(generation, event.messageId, persist = true) {
                it.copy(
                    status = if (event.finishReason == FinishReason.CANCELLED) MessageStatus.STOPPED else MessageStatus.COMPLETE,
                    finishReason = event.finishReason,
                )
            }
            is ChatStreamEvent.MessageFailed -> {
                if (generation.answers.containsKey(event.messageId)) {
                    applyToState(generation) { s ->
                        s.copy(recovery = s.recovery + (event.messageId to AnswerRecovery(event.attempts, event.alternatives)))
                    }
                }
                updateAnswer(generation, event.messageId, persist = true) {
                    it.copy(status = MessageStatus.FAILED, errorMessage = event.error.message, errorRetryable = event.error.retryable)
                }
            }
            is ChatStreamEvent.ToolCalled -> if (generation.answers.containsKey(event.messageId)) {
                val calls = generation.tools[event.messageId].orEmpty()
                if (calls.none { it.callId == event.callId }) {
                    setTools(generation, event.messageId, calls + ToolUse(event.callId, event.plugin, event.tool))
                }
            }
            is ChatStreamEvent.ToolFinished -> if (generation.answers.containsKey(event.messageId)) {
                val calls = generation.tools[event.messageId].orEmpty()
                val done = ToolUse(event.callId, event.plugin, event.tool, event.status, event.durationMs)
                setTools(generation, event.messageId, if (calls.any { it.callId == event.callId }) calls.map { if (it.callId == event.callId) done else it } else calls + done)
            }
            is ChatStreamEvent.TitleChanged -> {
                val c = generation.conversation
                if (c.id == event.conversationId && !c.titleIsCustom && c.title != event.title) {
                    val renamed = c.copy(title = event.title)
                    generation.conversation = renamed
                    applyToState(generation) { it.copy(conversation = renamed) }
                    repository.upsertConversation(renamed)
                }
            }
            is ChatStreamEvent.Ended -> Unit
            is ChatStreamEvent.Failed -> failRequest(generation, event.error)
        }
    }

    private fun setTools(generation: Generation, messageId: String, calls: List<ToolUse>) {
        generation.tools[messageId] = calls
        applyToState(generation) { s -> s.copy(toolUses = s.toolUses + (messageId to calls)) }
    }

    private suspend fun updateAnswer(
        generation: Generation,
        id: String,
        persist: Boolean,
        change: (ChatMessage) -> ChatMessage,
    ) {
        val current = generation.answers[id] ?: return
        val changed = change(current)
        // Keep the tools this answer used with it, so they show again when the conversation is reopened.
        val updated = if (persist) changed.copy(tools = generation.tools[id].orEmpty().filterNot(ToolUse::running)) else changed
        generation.answers[id] = updated
        applyToState(generation) { s -> s.copy(messages = s.messages.map { m -> if (m.id == id) updated else m }) }
        if (persist) repository.upsertMessage(updated)
    }

    private suspend fun finish(generation: Generation, status: MessageStatus, error: String?) {
        val streaming = generation.answers.values.filter { it.status == MessageStatus.STREAMING }.map { it.id }
        // A tool still "running" when its answer ends will never report: show it as stopped or failed.
        val ended = if (status == MessageStatus.STOPPED) ToolCallStatus.CANCELLED else ToolCallStatus.ERROR
        for (id in streaming) {
            val calls = generation.tools[id].orEmpty()
            if (calls.any(ToolUse::running)) setTools(generation, id, calls.map { if (it.running) it.copy(status = ended) else it })
        }
        for (id in streaming) {
            updateAnswer(generation, id, persist = true) { it.copy(status = status, errorMessage = error ?: it.errorMessage) }
        }
    }

    private suspend fun failRequest(generation: Generation, error: ApiError) {
        finish(generation, MessageStatus.FAILED, error.message)
        applyToState(generation) { it.copy(error = error) }
    }

    private fun cancelCurrent() {
        currentGeneration++
        job?.cancel(CancellationException("Conversation changed"))
        job = null
        activeGateway = null
    }
}
