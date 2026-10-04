package com.dashworldng.ai.core.contract

import com.dashworldng.ai.core.Fixtures
import com.dashworldng.ai.core.Limits
import com.dashworldng.ai.core.chat.ChatRequest
import com.dashworldng.ai.core.chat.TitleGenerator
import com.dashworldng.ai.core.documents.FileRules
import com.dashworldng.ai.core.model.AssistantMode
import com.dashworldng.ai.core.model.AttachmentRef
import com.dashworldng.ai.core.model.DocumentKind
import com.dashworldng.ai.core.model.FinishReason
import com.dashworldng.ai.core.model.MessageRole
import com.dashworldng.ai.core.model.ModelChoice
import com.dashworldng.ai.core.model.ProviderId
import com.dashworldng.ai.core.model.ToolCallStatus
import com.dashworldng.ai.core.presentation.ConnectionState
import com.dashworldng.ai.core.presentation.ToolConnections
import com.dashworldng.ai.core.remote.PluginsResponseDto
import com.dashworldng.ai.core.remote.ToolActivityResponseDto
import com.dashworldng.ai.core.remote.AuthResponseDto
import com.dashworldng.ai.core.remote.ChatStreamRequestDto
import com.dashworldng.ai.core.remote.ConversationDetailDto
import com.dashworldng.ai.core.remote.DashJson
import com.dashworldng.ai.core.remote.DocumentResponseDto
import com.dashworldng.ai.core.remote.ErrorResponseDto
import com.dashworldng.ai.core.remote.ProvidersResponseDto
import com.dashworldng.ai.core.remote.UsageSummaryDto
import com.dashworldng.ai.core.remote.toDto
import com.dashworldng.ai.core.routing.HistoryItem
import com.dashworldng.ai.core.routing.RoutingResult
import com.dashworldng.ai.core.routing.SmartRouting
import com.dashworldng.ai.core.stream.ChatStreamEvent
import com.dashworldng.ai.core.stream.SseParser
import com.dashworldng.ai.core.stream.StreamEventDecoder
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * Contract tests between the Android client and the API. Every fixture in
 * packages/contracts/fixtures is also validated against the API's zod schemas, so a change on
 * either side that breaks the other fails a test.
 */
class ContractFixturesTest {
    private val strict = DashJson.strict

    @Test
    fun `JSON fixtures decode strictly into the client DTOs`() {
        strict.decodeFromString(ProvidersResponseDto.serializer(), Fixtures.text("providers-response.json")).also {
            assertEquals(listOf("openai", "anthropic"), it.providers.map { p -> p.id })
            assertTrue(!it.research.liveSearchAvailable)
        }
        strict.decodeFromString(AuthResponseDto.serializer(), Fixtures.text("auth-response.json"))
        strict.decodeFromString(ConversationDetailDto.serializer(), Fixtures.text("conversation-detail.json")).also {
            assertEquals(null, it.messages.first().origin)
            assertEquals("openai", it.messages.last().origin)
        }
        strict.decodeFromString(DocumentResponseDto.serializer(), Fixtures.text("document-response.json"))
        strict.decodeFromString(ErrorResponseDto.serializer(), Fixtures.text("error-response.json")).also {
            assertEquals("rate_limited", it.error.code)
        }
        strict.decodeFromString(UsageSummaryDto.serializer(), Fixtures.text("usage-summary.json"))
        strict.decodeFromString(ChatStreamRequestDto.serializer(), Fixtures.text("chat-stream-request.json"))
    }

    @Test
    fun `the client serialises chat requests exactly like the contract fixture`() {
        val request = ChatRequest(
            conversationId = "3f0b8f2e-6a4d-4c1e-9d7a-1b2c3d4e5f60",
            mode = AssistantMode.BUSINESS,
            modelChoice = ModelChoice.COMPARE,
            messageId = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
            content = "Draft a one-page plan for a premium coffee kiosk in Lagos.",
            attachments = listOf(AttachmentRef("local", "d0c5e1a2-3b4c-4d5e-8f60-718293a4b5c6", "notes.txt", DocumentKind.TXT, 10)),
            history = listOf(
                HistoryItem(MessageRole.USER, "Hello", null),
                HistoryItem(MessageRole.ASSISTANT, "Hi! How can I help?", ProviderId.OPENAI),
            ),
        )
        val produced = Json.parseToJsonElement(DashJson.default.encodeToString(ChatStreamRequestDto.serializer(), request.toDto()))
        val expected = Json.parseToJsonElement(Fixtures.text("chat-stream-request.json"))
        assertEquals(expected, produced)
    }

    @Test
    fun `the compare SSE transcript decodes into stream events`() {
        val events = SseParser.parseAll(Fixtures.text("chat-stream-compare.sse")).mapNotNull { StreamEventDecoder.decode(it, strict) }
        assertEquals(8, events.size)
        val start = assertIs<ChatStreamEvent.Started>(events[0])
        assertEquals(listOf(ProviderId.OPENAI, ProviderId.ANTHROPIC), start.targets.map { it.provider })
        assertTrue(start.targets.all { it.demo })
        assertEquals("9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", start.compareGroupId)
        assertEquals(" — ünïcödé ✓ \"quoted\"", assertIs<ChatStreamEvent.Delta>(events[3]).text)
        assertEquals("Demo answer:\n- point one", assertIs<ChatStreamEvent.Delta>(events[2]).text)
        val end = assertIs<ChatStreamEvent.MessageEnded>(events[4])
        assertEquals(FinishReason.STOP, end.finishReason)
        assertEquals(42, end.inputTokens)
        val failure = assertIs<ChatStreamEvent.MessageFailed>(events[5])
        assertEquals("provider_timeout", failure.error.code)
        assertTrue(failure.error.retryable)
        assertEquals(3, failure.attempts)
        assertEquals(listOf(ProviderId.OPENAI), failure.alternatives)
        assertEquals("Premium coffee kiosk plan", assertIs<ChatStreamEvent.TitleChanged>(events[6]).title)
        assertIs<ChatStreamEvent.Ended>(events[7])
    }

    @Test
    fun `tool events decode into names and outcomes only and the answer text is unaffected`() {
        val raw = SseParser.parseAll(Fixtures.text("chat-stream-tools.sse"))
        assertEquals(listOf("tool.call", "tool.result"), raw.map { it.event }.filter { it.startsWith("tool.") })
        val events = raw.mapNotNull { StreamEventDecoder.decode(it, strict) }
        // start + 3 deltas + tool call + tool result + end + stream end.
        assertEquals(8, events.size)
        assertEquals("Let me check.\n\nIt has 3 words.", events.filterIsInstance<ChatStreamEvent.Delta>().joinToString("") { it.text })
        val call = events.filterIsInstance<ChatStreamEvent.ToolCalled>().single()
        assertEquals(listOf("call_1", "dash-demo", "text_stats"), listOf(call.callId, call.plugin, call.tool))
        val result = events.filterIsInstance<ChatStreamEvent.ToolFinished>().single()
        assertEquals(ToolCallStatus.OK, result.status)
        assertEquals(3L, result.durationMs)
        val end = assertIs<ChatStreamEvent.MessageEnded>(events[6])
        assertEquals(FinishReason.STOP, end.finishReason)
        assertIs<ChatStreamEvent.Ended>(events[7])
    }

    @Test
    fun `plugin registry and tool activity fixtures decode strictly`() {
        val plugins = strict.decodeFromString(PluginsResponseDto.serializer(), Fixtures.text("plugins-response.json"))
        assertTrue(plugins.toolsEnabled)
        assertEquals(listOf("dash-demo", "example-service"), plugins.plugins.map { it.id })
        val activity = strict.decodeFromString(ToolActivityResponseDto.serializer(), Fixtures.text("tool-activity.json")).activity.single()
        assertEquals("text_stats", activity.tool)
        assertEquals("ok", activity.status)
        // The registry fixture maps onto honest connection states.
        val connections = ToolConnections.from(plugins)
        assertEquals(ConnectionState.CONNECTED, connections[0].state)
        // A plugin whose only tool is not runnable on this server is never offered as available.
        assertEquals(ConnectionState.DISABLED, connections[1].state)
        assertFalse(connections[1].canToggle)
    }

    @Test
    fun `every server tool status maps to a known outcome`() {
        for (wire in listOf("ok", "duplicate", "invalid_arguments", "denied", "unknown_tool", "timeout", "error", "cancelled")) {
            assertEquals(wire, ToolCallStatus.fromWire(wire).wire)
        }
        assertEquals(ToolCallStatus.ERROR, ToolCallStatus.fromWire("something_new"))
    }

    @Test
    fun `the error SSE transcript decodes into a stream failure`() {
        val events = SseParser.parseAll(Fixtures.text("chat-stream-error.sse")).mapNotNull { StreamEventDecoder.decode(it, strict) }
        assertEquals("internal_error", assertIs<ChatStreamEvent.Failed>(events.single()).error.code)
    }

    @Test
    fun `Dash Smart routing matches the shared table`() {
        val table = Json.parseToJsonElement(Fixtures.text("smart-routing.json")).jsonObject
        assertEquals(AssistantMode.entries.map { it.wire }.toSet(), table.keys)
        for (mode in AssistantMode.entries) {
            val expected = table.getValue(mode.wire).jsonArray.map { ProviderId.fromWire(it.jsonPrimitive.content) }
            assertEquals(expected, SmartRouting.table.getValue(mode), "routing for ${mode.wire}")
            val routed = SmartRouting.resolve(ModelChoice.SMART, mode, ProviderId.entries.toSet())
            assertEquals(expected.first(), assertIs<RoutingResult.Routed>(routed).providers.single())
        }
    }

    @Test
    fun `upload rules match the shared rules`() {
        val json = Json.parseToJsonElement(Fixtures.text("file-rules.json")).jsonObject
        assertEquals(json.getValue("maxUploadBytes").jsonPrimitive.long, FileRules.MAX_UPLOAD_BYTES)
        val rules = json.getValue("rules").jsonArray.map { it.jsonObject }
        assertEquals(rules.size, FileRules.rules.size)
        rules.zip(FileRules.rules).forEach { (expected, actual) ->
            assertEquals(expected.getValue("kind").jsonPrimitive.content, actual.kind.wire)
            assertEquals((expected.getValue("extensions") as JsonArray).map { it.jsonPrimitive.content }, actual.extensions)
            assertEquals((expected.getValue("mimeTypes") as JsonArray).map { it.jsonPrimitive.content }, actual.mimeTypes)
        }
    }

    @Test
    fun `limits match the shared limits`() {
        val json = Json.parseToJsonElement(Fixtures.text("limits.json")) as JsonObject
        assertEquals(json.mapValues { it.value.jsonPrimitive.long }, Limits.asMap)
    }

    @Test
    fun `titles match the API's algorithm`() {
        val cases = Json.parseToJsonElement(Fixtures.text("titles.json")).jsonArray
        assertTrue(cases.size >= 10)
        for (case in cases) {
            val input = case.jsonObject.getValue("input").jsonPrimitive.content
            val expected = case.jsonObject.getValue("expected").jsonPrimitive.content
            assertEquals(expected, TitleGenerator.generate(input), "title for \"$input\"")
        }
    }
}
