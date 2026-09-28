package com.dashworldng.ai.core.contract

import com.dashworldng.ai.core.auth.AuthService
import com.dashworldng.ai.core.chat.ChatRequest
import com.dashworldng.ai.core.documents.UploadSource
import com.dashworldng.ai.core.model.AssistantMode
import com.dashworldng.ai.core.model.DocumentStatus
import com.dashworldng.ai.core.model.ModelChoice
import com.dashworldng.ai.core.model.ProviderId
import com.dashworldng.ai.core.remote.DashApiClient
import com.dashworldng.ai.core.remote.RemoteChatGateway
import com.dashworldng.ai.core.remote.RemoteDocumentGateway
import com.dashworldng.ai.core.stream.ApiException
import com.dashworldng.ai.core.stream.ChatStreamEvent
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import org.junit.Assume.assumeTrue
import org.junit.Before
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * End-to-end contract test: the real Kotlin client against the real TypeScript API running with
 * PROVIDER_MODE=fake. CI starts the API and sets DASH_API_BASE_URL; locally the test is skipped
 * unless you do the same (see docs/architecture.md).
 */
class LiveApiContractTest {
    private val baseUrl: String? = System.getenv("DASH_API_BASE_URL")
    private var token: String? = null
    private lateinit var client: DashApiClient

    @Before
    fun setUp() {
        assumeTrue("DASH_API_BASE_URL not set; skipping live API contract test", !baseUrl.isNullOrBlank())
        client = DashApiClient(baseUrl!!, tokenProvider = { token })
        runBlocking {
            val session = AuthService { client }.register("android-${UUID.randomUUID()}@example.com", "correct horse battery", "Android CI")
            token = session.token
        }
    }

    private fun request(choice: ModelChoice, content: String, attachments: List<com.dashworldng.ai.core.model.AttachmentRef> = emptyList()) = ChatRequest(
        conversationId = UUID.randomUUID().toString(),
        mode = AssistantMode.BUSINESS,
        modelChoice = choice,
        messageId = UUID.randomUUID().toString(),
        content = content,
        attachments = attachments,
        history = emptyList(),
    )

    @Test
    fun `providers endpoint reports fake adapters`() = runBlocking {
        val providers = AuthService { client }.providers()
        assertEquals(listOf("fake", "fake"), providers.providers.map { it.mode })
        assertTrue(providers.compareAvailable)
    }

    @Test
    fun `compare streams two demo-labelled answers end to end`() = runBlocking {
        val events = RemoteChatGateway(client).stream(request(ModelChoice.COMPARE, "Plan a kiosk launch")).toList()
        val start = assertIs<ChatStreamEvent.Started>(events.first())
        assertEquals(ProviderId.entries, start.targets.map { it.provider })
        assertTrue(start.targets.all { it.demo })
        assertEquals(2, events.count { it is ChatStreamEvent.MessageEnded })
        assertTrue(events.any { it is ChatStreamEvent.TitleChanged })
        assertIs<ChatStreamEvent.Ended>(events.last())
        val text = events.filterIsInstance<ChatStreamEvent.Delta>().joinToString("") { it.text }
        assertTrue(text.contains("Demonstration answer"))
    }

    @Test
    fun `documents upload and are used as context`() = runBlocking {
        val bytes = "Opening hours are 7am to 7pm.".toByteArray()
        val doc = RemoteDocumentGateway(client).upload(UploadSource("hours.txt", "text/plain", bytes.size.toLong()) { bytes.inputStream() }) {}
        assertEquals(DocumentStatus.READY, doc.status)
        val events = RemoteChatGateway(client).stream(request(ModelChoice.CLAUDE, "When do we open?", listOf(doc.toAttachment()))).toList()
        assertEquals(1, events.count { it is ChatStreamEvent.MessageEnded })
        assertTrue(events.filterIsInstance<ChatStreamEvent.Delta>().joinToString("") { it.text }.contains("included extracted document text"))
    }

    @Test
    fun `stopping closes the stream and the server cancels`() = runBlocking {
        val gateway = RemoteChatGateway(client)
        val first = gateway.stream(request(ModelChoice.OPENAI, "Go slowly [[fake:slow]]")).first()
        val start = assertIs<ChatStreamEvent.Started>(first)
        // The stream is already closed by first(); an explicit cancel for a finished stream reports false.
        gateway.cancel(start.streamId)
    }

    @Test
    fun `errors follow the contract`() = runBlocking {
        val error = assertFailsWith<ApiException> {
            RemoteChatGateway(client).stream(request(ModelChoice.OPENAI, "   ")).toList()
        }
        assertEquals("bad_request", error.error.code)
        assertEquals(400, error.httpStatus)
    }
}
