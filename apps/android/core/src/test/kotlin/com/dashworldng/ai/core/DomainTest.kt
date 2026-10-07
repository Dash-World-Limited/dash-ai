package com.dashworldng.ai.core

import com.dashworldng.ai.core.documents.FileCheck
import com.dashworldng.ai.core.documents.FileRules
import com.dashworldng.ai.core.model.AssistantMode
import com.dashworldng.ai.core.model.ChatMessage
import com.dashworldng.ai.core.model.DocumentKind
import com.dashworldng.ai.core.model.MessageRole
import com.dashworldng.ai.core.model.MessageStatus
import com.dashworldng.ai.core.model.ModelChoice
import com.dashworldng.ai.core.model.ProviderId
import com.dashworldng.ai.core.prompts.PromptCategory
import com.dashworldng.ai.core.prompts.PromptFilter
import com.dashworldng.ai.core.prompts.PromptItem
import com.dashworldng.ai.core.prompts.PromptLibrary
import com.dashworldng.ai.core.routing.ContextBuilder
import com.dashworldng.ai.core.routing.HistoryItem
import com.dashworldng.ai.core.routing.RoutingResult
import com.dashworldng.ai.core.routing.SmartRouting
import com.dashworldng.ai.core.stream.SseParser
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class RoutingTest {
    private val both = ProviderId.entries.toSet()

    @Test
    fun `demo routing picks the preferred configured provider internally, with a neutral reason`() {
        val routed = assertIs<RoutingResult.Routed>(SmartRouting.resolve(AssistantMode.WRITING, setOf(ProviderId.OPENAI)))
        assertEquals(listOf(ProviderId.OPENAI), routed.providers)
        assertEquals(listOf(ProviderId.ANTHROPIC), assertIs<RoutingResult.Routed>(SmartRouting.resolve(AssistantMode.WRITING, both)).providers)
        assertNoProviderName(routed.reason)
        val none = assertIs<RoutingResult.Unavailable>(SmartRouting.resolve(AssistantMode.GENERAL, emptySet()))
        assertEquals("DASH AI is temporarily unavailable.", none.message)
    }

    @Test
    fun `the composer says DASH AI receives the message, never a provider`() {
        assertEquals("DASH AI · Writing", SmartRouting.recipientLabel(AssistantMode.WRITING, demo = false))
        assertTrue(SmartRouting.recipientLabel(AssistantMode.GENERAL, demo = true).contains("nothing leaves this device"))
        AssistantMode.entries.forEach { assertNoProviderName(SmartRouting.recipientLabel(it, demo = false)) }
    }

    @Test
    fun `only the DASH routing value exists and old stored choices read as nothing`() {
        assertEquals(listOf(ModelChoice.SMART), ModelChoice.entries)
        assertEquals(ModelChoice.SMART, ModelChoice.fromWire("smart"))
        assertNull(ModelChoice.fromWire("compare"))
        assertNull(ModelChoice.fromWire("claude"))
    }
}

class ContextBuilderTest {
    private fun msg(role: MessageRole, content: String, provider: ProviderId? = null, demo: Boolean = false, status: MessageStatus = MessageStatus.COMPLETE) =
        ChatMessage(nextId("m"), "c", role, content, 0, status, provider, isDemo = demo)

    private val conversation = listOf(
        msg(MessageRole.USER, "q1"),
        msg(MessageRole.ASSISTANT, "openai", ProviderId.OPENAI),
        msg(MessageRole.ASSISTANT, "claude", ProviderId.ANTHROPIC),
        msg(MessageRole.ASSISTANT, "neutral"),
        msg(MessageRole.ASSISTANT, "demo", ProviderId.OPENAI, demo = true),
        msg(MessageRole.ASSISTANT, "failed", ProviderId.OPENAI, status = MessageStatus.FAILED),
        msg(MessageRole.ASSISTANT, "partial", ProviderId.OPENAI, status = MessageStatus.STOPPED),
    )

    @Test
    fun `every earlier DASH AI answer is context, whichever service wrote it, never demos or failures`() {
        val history = ContextBuilder.history(conversation)
        assertEquals(listOf("q1", "openai", "claude", "neutral", "partial"), history.map { it.content })
        assertEquals(listOf(MessageRole.USER, MessageRole.ASSISTANT, MessageRole.ASSISTANT, MessageRole.ASSISTANT, MessageRole.ASSISTANT), history.map { it.role })
    }

    @Test
    fun `history is trimmed from the oldest turn`() {
        val items = (1..10).map { HistoryItem(MessageRole.USER, "x".repeat(10) + it) }
        val trimmed = ContextBuilder.trim(items, maxMessages = 3, maxChars = 1_000)
        assertEquals(listOf("xxxxxxxxxx8", "xxxxxxxxxx9", "xxxxxxxxxx10"), trimmed.map { it.content })
        assertEquals(2, ContextBuilder.trim(items, maxMessages = 60, maxChars = 25).size)
    }
}

class AssistantModeTest {
    @Test
    fun `every mode has its own suggestions and research states its limit`() {
        AssistantMode.entries.forEach { mode ->
            assertTrue(mode.suggestions.size >= 3, mode.name)
            assertTrue(mode.composerHint.isNotBlank())
        }
        assertEquals(AssistantMode.entries.size, AssistantMode.entries.map { it.suggestions.first() }.toSet().size)
        assertTrue(assertNotNull(AssistantMode.RESEARCH.limitation).contains("not connected"))
        assertNotNull(AssistantMode.DOCUMENTS.limitation)
        assertEquals(AssistantMode.WRITING, AssistantMode.fromWire("writing"))
    }
}

class PromptLibraryTest {
    @Test
    fun `starter prompts cover every category with unique ids`() {
        val starters = PromptLibrary.starters
        assertEquals(PromptCategory.entries.toSet(), starters.map { it.category }.toSet())
        assertEquals(starters.size, starters.map { it.id }.toSet().size)
        assertTrue(starters.size >= 25)
    }

    @Test
    fun `search, favourites and personal filters`() {
        val mine = PromptItem("custom-1", "My weekly review", "Review my week", PromptCategory.PRODUCTIVITY, isCustom = true)
        val all = PromptLibrary.starters + mine
        val favorites = setOf("starter-wr-email", "custom-1")

        assertEquals(listOf("starter-wr-email", "custom-1").toSet(), PromptLibrary.filter(all, favorites, PromptFilter.Favorites, "").map { it.id }.toSet())
        assertEquals(listOf("custom-1"), PromptLibrary.filter(all, favorites, PromptFilter.Mine, "").map { it.id })
        assertTrue(PromptLibrary.filter(all, emptySet(), PromptFilter.All, "SWOT").any { it.id == "starter-biz-swot" })
        assertTrue(PromptLibrary.filter(all, emptySet(), PromptFilter.Category(PromptCategory.MARKETING), "").all { it.category == PromptCategory.MARKETING })
        assertTrue(PromptLibrary.filter(all, emptySet(), PromptFilter.All, "zzz-no-match").isEmpty())
        // Favourites float to the top.
        assertTrue(PromptLibrary.filter(all, favorites, PromptFilter.All, "").take(2).all { it.id in favorites })
    }

    @Test
    fun `validates personal prompts`() {
        assertNotNull(PromptLibrary.validate("", "body"))
        assertNotNull(PromptLibrary.validate("title", "  "))
        assertNotNull(PromptLibrary.validate("t".repeat(81), "body"))
        assertNull(PromptLibrary.validate("Weekly review", "Summarise my week"))
    }
}

class FileRulesTest {
    @Test
    fun `accepts supported types and rejects the rest`() {
        assertEquals(DocumentKind.PDF, assertIs<FileCheck.Ok>(FileRules.check("a.PDF", "application/pdf", 10)).kind)
        assertEquals(DocumentKind.IMAGE, assertIs<FileCheck.Ok>(FileRules.check("photo.jpeg", "image/jpeg", 10)).kind)
        assertEquals(DocumentKind.DOCX, assertIs<FileCheck.Ok>(FileRules.check("x.docx", null, 10)).kind)
        assertEquals("unsupported_media_type", assertIs<FileCheck.Rejected>(FileRules.check("x.exe", "application/octet-stream", 10)).code)
        assertEquals("unsupported_media_type", assertIs<FileCheck.Rejected>(FileRules.check("x.pdf", "image/png", 10)).code)
        assertEquals("payload_too_large", assertIs<FileCheck.Rejected>(FileRules.check("x.pdf", "application/pdf", FileRules.MAX_UPLOAD_BYTES + 1)).code)
        assertEquals("bad_request", assertIs<FileCheck.Rejected>(FileRules.check("x.txt", "text/plain", 0)).code)
    }

    @Test
    fun `formats sizes`() {
        assertEquals("512 B", FileRules.formatSize(512))
        assertEquals("2 KB", FileRules.formatSize(2048))
        assertEquals("1.5 MB", FileRules.formatSize(1_572_864))
    }
}

class SseParserTest {
    @Test
    fun `parses events, comments, multi-line data and missing trailing blank line`() {
        val events = SseParser.parseAll(": ping\n\nevent: a\ndata: one\ndata: two\n\nevent: b\r\ndata:no-space\r\n\ndata: tail")
        assertEquals(listOf("a" to "one\ntwo", "b" to "no-space", "message" to "tail"), events.map { it.event to it.data })
    }

    @Test
    fun `incremental feeding yields events on blank lines`() {
        val parser = SseParser()
        assertNull(parser.feed("event: x"))
        assertNull(parser.feed("data: {}"))
        assertEquals("x", parser.feed("")?.event)
        assertNull(parser.feed(""))
    }
}
