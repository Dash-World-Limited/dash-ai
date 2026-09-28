package com.dashworldng.ai

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.dashworldng.ai.core.model.AssistantMode
import com.dashworldng.ai.core.model.AttachmentRef
import com.dashworldng.ai.core.model.ChatMessage
import com.dashworldng.ai.core.model.Conversation
import com.dashworldng.ai.core.model.DocumentKind
import com.dashworldng.ai.core.model.MessageRole
import com.dashworldng.ai.core.model.MessageStatus
import com.dashworldng.ai.core.model.ModelChoice
import com.dashworldng.ai.core.model.ProviderId
import com.dashworldng.ai.core.prompts.PromptCategory
import com.dashworldng.ai.core.prompts.PromptItem
import com.dashworldng.ai.data.local.DashDatabase
import com.dashworldng.ai.data.local.RoomConversationRepository
import com.dashworldng.ai.data.local.RoomPromptRepository
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** Verifies the Room schema, queries and mappings that keep history across app restarts. */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [34])
class RoomRepositoryTest {
    private val db = DashDatabase.inMemory(ApplicationProvider.getApplicationContext())
    private val conversations = RoomConversationRepository(db)
    private val prompts = RoomPromptRepository(db)

    @After
    fun close() = db.close()

    @Test
    fun conversationsRoundTripSearchRenameAndDelete() = runBlocking<Unit> {
        conversations.upsertConversation(Conversation("c1", "Coffee kiosk", AssistantMode.BUSINESS, 1, 10))
        conversations.upsertConversation(Conversation("c2", "Poem", AssistantMode.WRITING, 2, 20, isDemo = true))
        val answer = ChatMessage(
            id = "m2",
            conversationId = "c1",
            role = MessageRole.ASSISTANT,
            content = "Use 100% arabica_beans",
            createdAt = 5,
            status = MessageStatus.STOPPED,
            provider = ProviderId.ANTHROPIC,
            model = "claude-model",
            modelChoice = ModelChoice.COMPARE,
            compareGroupId = "m1",
            replyToId = "m1",
        )
        conversations.upsertMessage(ChatMessage("m1", "c1", MessageRole.USER, "Plan it", 4, attachments = listOf(AttachmentRef("d", "r", "a.pdf", DocumentKind.PDF, 3))))
        conversations.upsertMessage(answer)

        assertEquals(listOf("c2", "c1"), conversations.observeConversations().first().map { it.id })
        assertEquals(listOf("c1"), conversations.observeConversations("arabica").first().map { it.id })
        assertEquals(listOf("c1"), conversations.observeConversations("100%").first().map { it.id })
        assertTrue(conversations.observeConversations("zzz").first().isEmpty())

        val restored = conversations.getMessages("c1")
        assertEquals(listOf("m1", "m2"), restored.map { it.id })
        assertEquals(answer, restored[1])
        assertEquals("a.pdf", restored[0].attachments.single().name)

        conversations.renameConversation("c1", "Renamed")
        val renamed = conversations.getConversation("c1")!!
        assertEquals("Renamed", renamed.title)
        assertTrue(renamed.titleIsCustom)

        // Upserting the conversation again must not delete its messages.
        conversations.upsertConversation(renamed.copy(updatedAt = 30))
        assertEquals(2, conversations.getMessages("c1").size)

        conversations.deleteConversation("c1")
        assertEquals(null, conversations.getConversation("c1"))
        assertTrue(conversations.getMessages("c1").isEmpty())
    }

    @Test
    fun customPromptsAndFavourites() = runBlocking<Unit> {
        prompts.upsertCustomPrompt(PromptItem("custom-1", "Weekly review", "Review my week", PromptCategory.PRODUCTIVITY, isCustom = true, updatedAt = 1))
        prompts.setFavorite("custom-1", true)
        prompts.setFavorite("starter-biz-swot", true)
        assertEquals("Weekly review", prompts.observeCustomPrompts().first().single().title)
        assertEquals(setOf("custom-1", "starter-biz-swot"), prompts.observeFavoriteIds().first())
        prompts.deleteCustomPrompt("custom-1")
        assertEquals(setOf("starter-biz-swot"), prompts.observeFavoriteIds().first())
    }
}
