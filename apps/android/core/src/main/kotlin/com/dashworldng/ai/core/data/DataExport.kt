package com.dashworldng.ai.core.data

import com.dashworldng.ai.core.model.ChatMessage
import com.dashworldng.ai.core.model.Conversation
import com.dashworldng.ai.core.model.DocumentItem
import com.dashworldng.ai.core.prompts.PromptItem
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.time.Instant

@Serializable
data class ExportMessage(
    val id: String,
    val role: String,
    val content: String,
    val status: String,
    /** True for Demo Mode answers. Which AI infrastructure produced an answer is internal and not exported. */
    val demo: Boolean,
    val attachments: List<String>,
    val createdAt: String,
)

@Serializable
data class ExportConversation(
    val id: String,
    val title: String,
    val mode: String,
    val demo: Boolean,
    val createdAt: String,
    val updatedAt: String,
    val messages: List<ExportMessage>,
)

@Serializable
data class ExportPrompt(val id: String, val title: String, val body: String, val category: String)

@Serializable
data class ExportDocument(
    val name: String,
    val kind: String,
    val sizeBytes: Long,
    val status: String,
    val statusDetail: String,
    val createdAt: String,
)

/** Everything Dash AI stores on this device, as portable JSON. Credentials are never included. */
@Serializable
data class DataExportFile(
    val format: String = "dash-ai-export",
    val version: Int = 1,
    val exportedAt: String,
    val conversations: List<ExportConversation>,
    val customPrompts: List<ExportPrompt>,
    val favoritePromptIds: List<String>,
    val documents: List<ExportDocument>,
)

object DataExport {
    private val json = Json {
        prettyPrint = true
        encodeDefaults = true
    }

    private fun iso(millis: Long) = Instant.ofEpochMilli(millis).toString()

    fun build(
        conversations: List<Pair<Conversation, List<ChatMessage>>>,
        customPrompts: List<PromptItem>,
        favorites: Set<String>,
        documents: List<DocumentItem>,
        now: Long,
    ): DataExportFile = DataExportFile(
        exportedAt = iso(now),
        conversations = conversations.map { (c, messages) ->
            ExportConversation(
                id = c.id,
                title = c.title,
                mode = c.mode.wire,
                demo = c.isDemo,
                createdAt = iso(c.createdAt),
                updatedAt = iso(c.updatedAt),
                messages = messages.map { m ->
                    ExportMessage(
                        id = m.id,
                        role = m.role.name.lowercase(),
                        content = m.content,
                        status = m.status.name.lowercase(),
                        demo = m.isDemo,
                        attachments = m.attachments.map { it.name },
                        createdAt = iso(m.createdAt),
                    )
                },
            )
        },
        customPrompts = customPrompts.map { ExportPrompt(it.id, it.title, it.body, it.category.name.lowercase()) },
        favoritePromptIds = favorites.sorted(),
        documents = documents.map {
            ExportDocument(it.name, it.kind.wire, it.sizeBytes, it.status.name.lowercase(), it.statusDetail, iso(it.createdAt))
        },
    )

    fun toJson(file: DataExportFile): String = json.encodeToString(DataExportFile.serializer(), file)
}
