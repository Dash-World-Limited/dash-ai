package com.dashworldng.ai.core.remote

import com.dashworldng.ai.core.Fixtures
import com.dashworldng.ai.core.auth.AuthService
import com.dashworldng.ai.core.auth.AuthValidation
import com.dashworldng.ai.core.chat.ChatRequest
import com.dashworldng.ai.core.documents.UploadSource
import com.dashworldng.ai.core.model.AssistantMode
import com.dashworldng.ai.core.model.DocumentStatus
import com.dashworldng.ai.core.model.MessageRole
import com.dashworldng.ai.core.model.ModelChoice
import com.dashworldng.ai.core.model.ProviderId
import com.dashworldng.ai.core.routing.HistoryItem
import com.dashworldng.ai.core.stream.ApiException
import com.dashworldng.ai.core.stream.ChatStreamEvent
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Before
import java.util.concurrent.TimeUnit
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class RemoteClientTest {
    private lateinit var server: MockWebServer
    private var token: String? = "dash_test_token_1234567890"
    private lateinit var client: DashApiClient

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        client = DashApiClient(server.url("/").toString(), tokenProvider = { token })
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private val request = ChatRequest(
        conversationId = "conv-00000001",
        mode = AssistantMode.WRITING,
        modelChoice = ModelChoice.COMPARE,
        messageId = "msg-00000001",
        content = "Hello",
        attachments = emptyList(),
        history = listOf(HistoryItem(MessageRole.USER, "Earlier", null), HistoryItem(MessageRole.ASSISTANT, "Answer", ProviderId.ANTHROPIC)),
    )

    @Test
    fun `streams events from the API with auth and the contract request body`() = runBlocking {
        server.enqueue(MockResponse().setHeader("Content-Type", "text/event-stream").setBody(Fixtures.text("chat-stream-compare.sse")))

        val events = RemoteChatGateway(client).stream(request).toList()

        assertEquals(8, events.size)
        assertIs<ChatStreamEvent.Started>(events.first())
        val recorded = server.takeRequest()
        assertEquals("/v1/chat/stream", recorded.path)
        assertEquals("Bearer dash_test_token_1234567890", recorded.getHeader("Authorization"))
        assertEquals("text/event-stream", recorded.getHeader("Accept"))
        val body = Json.parseToJsonElement(recorded.body.readUtf8()).jsonObject
        assertEquals("compare", body.getValue("modelChoice").jsonPrimitive.content)
        assertEquals("writing", body.getValue("mode").jsonPrimitive.content)
        assertTrue(body.getValue("history").toString().contains("\"origin\":\"anthropic\""))
    }

    @Test
    fun `HTTP errors become typed API errors`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(503).setBody(Fixtures.text("error-response.json").replace("rate_limited", "provider_not_configured")))
        val error = assertFailsWith<ApiException> { RemoteChatGateway(client).stream(request).toList() }
        assertEquals("provider_not_configured", error.error.code)
        assertEquals(503, error.httpStatus)

        server.enqueue(MockResponse().setResponseCode(502).setBody("<html>bad gateway</html>"))
        val fallback = assertFailsWith<ApiException> { RemoteChatGateway(client).stream(request).toList() }
        assertTrue(fallback.error.retryable)
        assertEquals("http_502", fallback.error.code)
    }

    @Test
    fun `network failures are reported as retryable`() = runBlocking {
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AT_START))
        val error = assertFailsWith<ApiException> { RemoteChatGateway(client).stream(request).toList() }
        assertEquals("network", error.error.code)
        assertTrue(error.error.retryable)
    }

    @Test
    fun `cancelling collection closes the HTTP stream without an error`() = runBlocking {
        val head = Fixtures.text("chat-stream-compare.sse").substringBefore(": ping")
        server.enqueue(
            MockResponse()
                .setHeader("Content-Type", "text/event-stream")
                .setBody(head + ": ping\n\n".repeat(2_000))
                .throttleBody(64, 100, TimeUnit.MILLISECONDS),
        )
        val first = withTimeout(10_000) { RemoteChatGateway(client).stream(request).first() }
        assertIs<ChatStreamEvent.Started>(first)
        // first() cancels the flow; the connection must be released promptly.
        withTimeout(5_000) {
            while (client.http.connectionPool.connectionCount() > 0 && client.http.dispatcher.runningCallsCount() > 0) {
                kotlinx.coroutines.delay(20)
            }
        }
        assertEquals(0, client.http.dispatcher.runningCallsCount())
    }

    @Test
    fun `explicit cancel calls the cancel endpoint`() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"streamId":"stream-00000001","cancelled":true}"""))
        RemoteChatGateway(client).cancel("stream-00000001")
        assertEquals("/v1/chat/streams/stream-00000001/cancel", server.takeRequest().path)
    }

    @Test
    fun `auth service signs in and never sends the token when signed out`() = runBlocking {
        token = null
        server.enqueue(MockResponse().setResponseCode(200).setBody(Fixtures.text("auth-response.json")))
        val session = AuthService { client }.login("ada@example.com", "correct horse battery")
        assertEquals("Ada", session.user.displayName)
        val recorded = server.takeRequest()
        assertNull(recorded.getHeader("Authorization"))
        assertTrue(recorded.body.readUtf8().contains("\"email\":\"ada@example.com\""))

        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":{"code":"unauthorized","message":"Email or password is incorrect.","retryable":false}}"""))
        val error = assertFailsWith<ApiException> { AuthService { client }.login("ada@example.com", "wrong") }
        assertEquals("Email or password is incorrect.", error.message)
    }

    @Test
    fun `uploads stream the file with progress and map the response`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(201).setBody(Fixtures.text("document-response.json")))
        val bytes = ByteArray(200_000) { 'a'.code.toByte() }
        val progress = mutableListOf<Float>()
        val item = RemoteDocumentGateway(client).upload(UploadSource("kiosk-notes.txt", "text/plain", bytes.size.toLong()) { bytes.inputStream() }) {
            progress += it
        }
        assertEquals(DocumentStatus.READY, item.status)
        assertEquals("d0c5e1a2-3b4c-4d5e-8f60-718293a4b5c6", item.remoteId)
        assertEquals(1f, progress.last())
        val recorded = server.takeRequest()
        assertTrue(recorded.getHeader("Content-Type")!!.startsWith("multipart/form-data"))
        assertTrue(recorded.bodySize > bytes.size)
    }

    @Test
    fun `invalid uploads are rejected before any network call`() = runBlocking {
        val error = assertFailsWith<ApiException> {
            RemoteDocumentGateway(client).upload(UploadSource("setup.exe", "application/octet-stream", 10) { error("never opened") }) {}
        }
        assertEquals("unsupported_media_type", error.error.code)
        assertEquals(0, server.requestCount)
    }

    @Test
    fun `server addresses are normalised`() {
        assertEquals("https://api.dash.example/", DashApiClient.normalizeBaseUrl("api.dash.example")?.toString())
        assertEquals("http://10.0.2.2:8787/", DashApiClient.normalizeBaseUrl(" http://10.0.2.2:8787 ")?.toString())
        assertNull(DashApiClient.normalizeBaseUrl(""))
    }

    @Test
    fun `auth validation mirrors the API rules`() {
        assertNotNull(AuthValidation.emailError("not-an-email"))
        assertNull(AuthValidation.emailError("ada@example.com"))
        assertNotNull(AuthValidation.passwordError("short", creating = true))
        assertNull(AuthValidation.passwordError("short", creating = false))
        assertNotNull(AuthValidation.nameError(" "))
        assertNotNull(AuthValidation.nameError("Ada\u0000Lovelace"))
        assertNull(AuthValidation.nameError("Ada Lovelace"))
    }
}
