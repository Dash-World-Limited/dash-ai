package com.dashworldng.ai.core.chat

import com.dashworldng.ai.core.model.AttachmentRef
import com.dashworldng.ai.core.model.ChatMessage
import com.dashworldng.ai.core.model.DocumentKind
import com.dashworldng.ai.core.model.MessageRole
import com.dashworldng.ai.core.model.ProviderId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

class ChatItemsTest {
    private fun m(id: String, role: MessageRole, group: String? = null, provider: ProviderId? = null) =
        ChatMessage(id, "c", role, id, 0, provider = provider, compareGroupId = group)

    @Test
    fun `compare answers are grouped side by side`() {
        val items = ChatItems.build(
            listOf(
                m("u1", MessageRole.USER),
                m("a1", MessageRole.ASSISTANT, "u1", ProviderId.OPENAI),
                m("a2", MessageRole.ASSISTANT, "u1", ProviderId.ANTHROPIC),
                m("u2", MessageRole.USER),
                m("a3", MessageRole.ASSISTANT, provider = ProviderId.OPENAI),
            ),
        )
        assertEquals(4, items.size)
        val compare = assertIs<ChatItem.Compare>(items[1])
        assertEquals(listOf("a1", "a2"), compare.answers.map { it.id })
        assertIs<ChatItem.Assistant>(items[3])
        assertEquals(items.size, items.map { it.key }.toSet().size)
    }

    @Test
    fun `attachments survive the database round trip`() {
        val list = listOf(AttachmentRef("d1", "r1", "plan.pdf", DocumentKind.PDF, 1234), AttachmentRef("d2", null, "photo.png", DocumentKind.IMAGE, 99))
        assertEquals(list, AttachmentCodec.decode(AttachmentCodec.encode(list)))
        assertTrue(AttachmentCodec.decode(null).isEmpty())
        assertTrue(AttachmentCodec.decode("not json").isEmpty())
    }
}
