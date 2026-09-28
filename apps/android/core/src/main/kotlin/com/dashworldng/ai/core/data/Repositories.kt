package com.dashworldng.ai.core.data

import com.dashworldng.ai.core.model.ChatMessage
import com.dashworldng.ai.core.model.Conversation
import com.dashworldng.ai.core.model.DocumentItem
import com.dashworldng.ai.core.prompts.PromptItem
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.map

/** Local conversation history. Implemented with Room on Android and in memory for tests. */
interface ConversationRepository {
    /** Newest first. A non-blank query matches titles and message text. */
    fun observeConversations(query: String = ""): Flow<List<Conversation>>
    suspend fun getConversation(id: String): Conversation?
    suspend fun upsertConversation(conversation: Conversation)
    suspend fun renameConversation(id: String, title: String)
    suspend fun deleteConversation(id: String)
    suspend fun getMessages(conversationId: String): List<ChatMessage>
    suspend fun upsertMessage(message: ChatMessage)
    suspend fun deleteMessages(ids: List<String>)
    suspend fun allConversations(): List<Conversation>
    suspend fun deleteAll()
}

interface PromptRepository {
    fun observeCustomPrompts(): Flow<List<PromptItem>>
    fun observeFavoriteIds(): Flow<Set<String>>
    suspend fun upsertCustomPrompt(prompt: PromptItem)
    suspend fun deleteCustomPrompt(id: String)
    suspend fun setFavorite(promptId: String, favorite: Boolean)
    suspend fun deleteAll()
}

interface DocumentRepository {
    fun observeDocuments(): Flow<List<DocumentItem>>
    suspend fun get(id: String): DocumentItem?
    suspend fun upsert(document: DocumentItem)
    suspend fun delete(id: String)
    suspend fun deleteAll()
}

class InMemoryConversationRepository : ConversationRepository {
    private val conversations = MutableStateFlow<Map<String, Conversation>>(emptyMap())
    private val messages = MutableStateFlow<Map<String, ChatMessage>>(emptyMap())

    override fun observeConversations(query: String): Flow<List<Conversation>> =
        conversations.map { all ->
            val q = query.trim().lowercase()
            all.values
                .filter { c ->
                    q.isEmpty() || c.title.lowercase().contains(q) ||
                        messages.value.values.any { it.conversationId == c.id && it.content.lowercase().contains(q) }
                }
                .sortedByDescending { it.updatedAt }
        }

    override suspend fun getConversation(id: String): Conversation? = conversations.value[id]

    override suspend fun upsertConversation(conversation: Conversation) {
        conversations.value = conversations.value + (conversation.id to conversation)
    }

    override suspend fun renameConversation(id: String, title: String) {
        val c = conversations.value[id] ?: return
        upsertConversation(c.copy(title = title, titleIsCustom = true))
    }

    override suspend fun deleteConversation(id: String) {
        conversations.value = conversations.value - id
        messages.value = messages.value.filterValues { it.conversationId != id }
    }

    override suspend fun getMessages(conversationId: String): List<ChatMessage> =
        messages.value.values.filter { it.conversationId == conversationId }.sortedBy { it.createdAt }

    override suspend fun upsertMessage(message: ChatMessage) {
        messages.value = messages.value + (message.id to message)
        // Touch the conversation so observers re-evaluate searches.
        conversations.value = conversations.value.toMap()
    }

    override suspend fun deleteMessages(ids: List<String>) {
        messages.value = messages.value - ids.toSet()
    }

    override suspend fun allConversations(): List<Conversation> = conversations.value.values.sortedByDescending { it.updatedAt }

    override suspend fun deleteAll() {
        conversations.value = emptyMap()
        messages.value = emptyMap()
    }
}

class InMemoryPromptRepository : PromptRepository {
    private val custom = MutableStateFlow<Map<String, PromptItem>>(emptyMap())
    private val favorites = MutableStateFlow<Set<String>>(emptySet())

    override fun observeCustomPrompts(): Flow<List<PromptItem>> = custom.map { it.values.sortedBy { p -> p.title.lowercase() } }
    override fun observeFavoriteIds(): Flow<Set<String>> = favorites

    override suspend fun upsertCustomPrompt(prompt: PromptItem) {
        custom.value = custom.value + (prompt.id to prompt.copy(isCustom = true))
    }

    override suspend fun deleteCustomPrompt(id: String) {
        custom.value = custom.value - id
        favorites.value = favorites.value - id
    }

    override suspend fun setFavorite(promptId: String, favorite: Boolean) {
        favorites.value = if (favorite) favorites.value + promptId else favorites.value - promptId
    }

    override suspend fun deleteAll() {
        custom.value = emptyMap()
        favorites.value = emptySet()
    }
}

class InMemoryDocumentRepository : DocumentRepository {
    private val documents = MutableStateFlow<Map<String, DocumentItem>>(emptyMap())

    override fun observeDocuments(): Flow<List<DocumentItem>> = documents.map { it.values.sortedByDescending { d -> d.createdAt } }
    override suspend fun get(id: String): DocumentItem? = documents.value[id]
    override suspend fun upsert(document: DocumentItem) {
        documents.value = documents.value + (document.id to document)
    }
    override suspend fun delete(id: String) {
        documents.value = documents.value - id
    }
    override suspend fun deleteAll() {
        documents.value = emptyMap()
    }
}
