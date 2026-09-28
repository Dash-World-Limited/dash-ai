package com.dashworldng.ai.core.demo

import com.dashworldng.ai.core.chat.ChatRequest
import com.dashworldng.ai.core.documents.DemoDocumentGateway
import com.dashworldng.ai.core.documents.UploadSource
import com.dashworldng.ai.core.model.AssistantMode
import com.dashworldng.ai.core.model.AttachmentRef
import com.dashworldng.ai.core.model.DocumentKind
import com.dashworldng.ai.core.model.DocumentStatus
import com.dashworldng.ai.core.model.ModelChoice
import com.dashworldng.ai.core.model.ProviderId
import com.dashworldng.ai.core.stream.ApiException
import com.dashworldng.ai.core.stream.ChatStreamEvent
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertTrue
import kotlin.test.fail

class DemoTest {
    private fun request(choice: ModelChoice, mode: AssistantMode = AssistantMode.GENERAL, content: String = "Hello", attachments: List<AttachmentRef> = emptyList()) =
        ChatRequest("conv-1", mode, choice, "msg-1", content, attachments, emptyList())

    private fun textOf(events: List<ChatStreamEvent>, messageId: String) =
        events.filterIsInstance<ChatStreamEvent.Delta>().filter { it.messageId == messageId }.joinToString("") { it.text }

    @Test
    fun `demo answers are labelled and never claim to be real`() = runTest {
        val events = DemoChatGateway(chunkDelayMillis = 0).stream(request(ModelChoice.OPENAI)).toList()
        val start = assertIs<ChatStreamEvent.Started>(events.first())
        val target = start.targets.single()
        assertTrue(target.demo)
        assertEquals("demo-openai", target.model)
        val text = textOf(events, target.messageId)
        assertTrue(text.startsWith("**Demo response · simulated OpenAI style.**"))
        assertTrue(text.contains("Nothing was sent to any AI provider"))
        assertIs<ChatStreamEvent.MessageEnded>(events[events.size - 2])
        assertIs<ChatStreamEvent.Ended>(events.last())
    }

    @Test
    fun `smart mode mirrors the routing table and compare streams both`() = runTest {
        val writing = DemoChatGateway(chunkDelayMillis = 0).stream(request(ModelChoice.SMART, AssistantMode.WRITING)).toList()
        assertEquals(ProviderId.ANTHROPIC, assertIs<ChatStreamEvent.Started>(writing.first()).targets.single().provider)

        val compare = DemoChatGateway(chunkDelayMillis = 1).stream(request(ModelChoice.COMPARE)).toList()
        val start = assertIs<ChatStreamEvent.Started>(compare.first())
        assertEquals("msg-1", start.compareGroupId)
        assertEquals(ProviderId.entries, start.targets.map { it.provider })
        start.targets.forEach { assertTrue(textOf(compare, it.messageId).contains("simulated ${it.provider.displayName} style")) }
        assertEquals(2, compare.count { it is ChatStreamEvent.MessageEnded })
    }

    @Test
    fun `research and documents state their limits honestly`() = runTest {
        val research = DemoChatGateway(chunkDelayMillis = 0).stream(request(ModelChoice.OPENAI, AssistantMode.RESEARCH)).toList()
        assertTrue(textOf(research, assertIs<ChatStreamEvent.Started>(research.first()).targets.single().messageId).contains("Live web research is not connected"))

        val doc = AttachmentRef("d1", null, "report.pdf", DocumentKind.PDF, 100)
        val documents = DemoChatGateway(chunkDelayMillis = 0).stream(request(ModelChoice.CLAUDE, AssistantMode.DOCUMENTS, "Summarise", listOf(doc))).toList()
        val text = textOf(documents, assertIs<ChatStreamEvent.Started>(documents.first()).targets.single().messageId)
        assertTrue(text.contains("Demo Mode cannot read documents"))
        assertTrue(text.contains("report.pdf"))
    }

    @Test
    fun `simulated failures exercise error states`() = runTest {
        assertFailsWith<ApiException> {
            DemoChatGateway(chunkDelayMillis = 0, failure = { DemoFailure.CONNECTION }).stream(request(ModelChoice.OPENAI)).toList()
        }
        val events = DemoChatGateway(chunkDelayMillis = 0, failure = { DemoFailure.PROVIDER }).stream(request(ModelChoice.COMPARE)).toList()
        assertEquals(1, events.count { it is ChatStreamEvent.MessageFailed })
        assertEquals(1, events.count { it is ChatStreamEvent.MessageEnded })
    }

    @Test
    fun `demo documents are validated but never read`() = runTest {
        val gateway = DemoDocumentGateway(stepDelayMillis = 0)
        val progress = mutableListOf<Float>()
        val item = gateway.upload(UploadSource("notes.txt", "text/plain", 120) { fail("Demo Mode must not open the file") }) { progress += it }
        assertEquals(DocumentStatus.DEMO, item.status)
        assertTrue(item.statusDetail.contains("not uploaded or analysed"))
        assertEquals(1f, progress.last())
        assertTrue(item.canAttach)

        val rejected = assertFailsWith<ApiException> {
            gateway.upload(UploadSource("virus.exe", "application/octet-stream", 10) { fail("never opened") }) {}
        }
        assertEquals("unsupported_media_type", rejected.error.code)
    }
}
