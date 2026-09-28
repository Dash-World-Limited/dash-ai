package com.dashworldng.ai.data.local

import com.dashworldng.ai.core.chat.AttachmentCodec
import com.dashworldng.ai.core.data.ConversationRepository
import com.dashworldng.ai.core.data.DocumentRepository
import com.dashworldng.ai.core.data.PromptRepository
import com.dashworldng.ai.core.model.AssistantMode
import com.dashworldng.ai.core.model.ChatMessage
import com.dashworldng.ai.core.model.Conversation
import com.dashworldng.ai.core.model.DocumentItem
import com.dashworldng.ai.core.model.DocumentKind
import com.dashworldng.ai.core.model.DocumentStatus
import com.dashworldng.ai.core.model.FinishReason
import com.dashworldng.ai.core.model.MessageRole
import com.dashworldng.ai.core.model.MessageStatus
import com.dashworldng.ai.core.model.ModelChoice
import com.dashworldng.ai.core.model.ProviderId
import com.dashworldng.ai.core.prompts.PromptCategory
import com.dashworldng.ai.core.prompts.PromptItem
import androidx.room.withTransaction
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

class RoomConversationRepository(private val db: DashDatabase) : ConversationRepository {
    override fun observeConversations(query: String): Flow<List<Conversation>> {
        val q = query.trim()
        val source = if (q.isEmpty()) db.conversations().observeAll() else db.conversations().search(escapeLike(q))
        return source.map { list -> list.map { it.toModel() } }
    }

    override suspend fun getConversation(id: String): Conversation? = db.conversations().get(id)?.toModel()

    override suspend fun upsertConversation(conversation: Conversation) = db.conversations().upsert(conversation.toEntity())

    override suspend fun renameConversation(id: String, title: String) = db.conversations().rename(id, title)

    override suspend fun deleteConversation(id: String) {
        db.withTransaction {
            db.messages().deleteForConversation(id)
            db.conversations().delete(id)
        }
    }

    override suspend fun getMessages(conversationId: String): List<ChatMessage> =
        db.messages().forConversation(conversationId).map { it.toModel() }

    override suspend fun upsertMessage(message: ChatMessage) = db.messages().upsert(message.toEntity())

    override suspend fun deleteMessages(ids: List<String>) {
        if (ids.isNotEmpty()) db.messages().delete(ids)
    }

    override suspend fun allConversations(): List<Conversation> = db.conversations().all().map { it.toModel() }

    override suspend fun deleteAll() {
        db.messages().deleteAll()
        db.conversations().deleteAll()
    }

    private fun escapeLike(value: String) = value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
}

class RoomPromptRepository(private val db: DashDatabase) : PromptRepository {
    override fun observeCustomPrompts(): Flow<List<PromptItem>> = db.prompts().observeCustom().map { list ->
        list.map {
            PromptItem(
                id = it.id,
                title = it.title,
                body = it.body,
                category = runCatching { PromptCategory.valueOf(it.category) }.getOrDefault(PromptCategory.PRODUCTIVITY),
                isCustom = true,
                updatedAt = it.updatedAt,
            )
        }
    }

    override fun observeFavoriteIds(): Flow<Set<String>> = db.prompts().observeFavorites().map { list -> list.map { it.promptId }.toSet() }

    override suspend fun upsertCustomPrompt(prompt: PromptItem) =
        db.prompts().upsertCustom(CustomPromptEntity(prompt.id, prompt.title, prompt.body, prompt.category.name, prompt.updatedAt))

    override suspend fun deleteCustomPrompt(id: String) {
        db.prompts().deleteCustom(id)
        db.prompts().removeFavorite(id)
    }

    override suspend fun setFavorite(promptId: String, favorite: Boolean) {
        if (favorite) db.prompts().addFavorite(FavoritePromptEntity(promptId)) else db.prompts().removeFavorite(promptId)
    }

    override suspend fun deleteAll() {
        db.prompts().deleteAllCustom()
        db.prompts().deleteAllFavorites()
    }
}

class RoomDocumentRepository(private val db: DashDatabase) : DocumentRepository {
    override fun observeDocuments(): Flow<List<DocumentItem>> = db.documents().observeAll().map { list -> list.map { it.toModel() } }

    override suspend fun get(id: String): DocumentItem? = db.documents().get(id)?.toModel()

    override suspend fun upsert(document: DocumentItem) = db.documents().upsert(
        DocumentEntity(
            id = document.id,
            remoteId = document.remoteId,
            name = document.name,
            kind = document.kind.wire,
            mimeType = document.mimeType,
            sizeBytes = document.sizeBytes,
            status = document.status.name,
            statusDetail = document.statusDetail,
            extractedChars = document.extractedChars,
            pageCount = document.pageCount,
            createdAt = document.createdAt,
            isDemo = document.isDemo,
        ),
    )

    override suspend fun delete(id: String) = db.documents().delete(id)

    override suspend fun deleteAll() = db.documents().deleteAll()

    private fun DocumentEntity.toModel() = DocumentItem(
        id = id,
        remoteId = remoteId,
        name = name,
        kind = DocumentKind.fromWire(kind) ?: DocumentKind.TXT,
        mimeType = mimeType,
        sizeBytes = sizeBytes,
        status = runCatching { DocumentStatus.valueOf(status) }.getOrDefault(DocumentStatus.FAILED),
        statusDetail = statusDetail,
        extractedChars = extractedChars,
        pageCount = pageCount,
        createdAt = createdAt,
        isDemo = isDemo,
        progress = 1f,
    )
}

private fun ConversationEntity.toModel() = Conversation(
    id = id,
    title = title,
    mode = AssistantMode.fromWire(mode) ?: AssistantMode.GENERAL,
    createdAt = createdAt,
    updatedAt = updatedAt,
    titleIsCustom = titleIsCustom,
    isDemo = isDemo,
)

private fun Conversation.toEntity() = ConversationEntity(id, title, mode.wire, createdAt, updatedAt, titleIsCustom, isDemo)

private fun MessageEntity.toModel() = ChatMessage(
    id = id,
    conversationId = conversationId,
    role = if (role == "user") MessageRole.USER else MessageRole.ASSISTANT,
    content = content,
    createdAt = createdAt,
    status = runCatching { MessageStatus.valueOf(status) }.getOrDefault(MessageStatus.COMPLETE),
    provider = provider?.let { ProviderId.fromWire(it) },
    model = model,
    isDemo = isDemo,
    modelChoice = modelChoice?.let { ModelChoice.fromWire(it) },
    compareGroupId = compareGroupId,
    replyToId = replyToId,
    attachments = AttachmentCodec.decode(attachmentsJson),
    errorMessage = errorMessage,
    errorRetryable = errorRetryable,
    finishReason = finishReason?.let { FinishReason.fromWire(it) },
    routingReason = routingReason,
)

private fun ChatMessage.toEntity() = MessageEntity(
    id = id,
    conversationId = conversationId,
    role = if (role == MessageRole.USER) "user" else "assistant",
    content = content,
    createdAt = createdAt,
    status = status.name,
    provider = provider?.wire,
    model = model,
    isDemo = isDemo,
    modelChoice = modelChoice?.wire,
    compareGroupId = compareGroupId,
    replyToId = replyToId,
    attachmentsJson = AttachmentCodec.encode(attachments),
    errorMessage = errorMessage,
    errorRetryable = errorRetryable,
    finishReason = finishReason?.wire,
    routingReason = routingReason,
)
