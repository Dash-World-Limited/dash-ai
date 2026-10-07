package com.dashworldng.ai.core.chat

import com.dashworldng.ai.core.ScriptedGateway
import com.dashworldng.ai.core.assertNoProviderName
import com.dashworldng.ai.core.SequentialIds
import com.dashworldng.ai.core.answer
import com.dashworldng.ai.core.data.InMemoryConversationRepository
import com.dashworldng.ai.core.demo.DemoChatGateway
import com.dashworldng.ai.core.model.AssistantMode
import com.dashworldng.ai.core.model.AttachmentRef
import com.dashworldng.ai.core.model.DocumentKind
import com.dashworldng.ai.core.model.MessageRole
import com.dashworldng.ai.core.model.MessageStatus
import com.dashworldng.ai.core.model.ModelChoice
import com.dashworldng.ai.core.model.ProviderId
import com.dashworldng.ai.core.model.FinishReason
import com.dashworldng.ai.core.model.ToolCallStatus
import com.dashworldng.ai.core.model.ToolUse
import com.dashworldng.ai.core.nextId
import com.dashworldng.ai.core.stream.ApiError
import com.dashworldng.ai.core.stream.ApiException
import com.dashworldng.ai.core.stream.ChatStreamEvent
import com.dashworldng.ai.core.stream.StreamTarget
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class ChatSessionTest {
    private val repository = InMemoryConversationRepository()
    private var time = 1_000L

    private fun TestScope.session(gateway: ChatGateway) = ChatSession(
        scope = this,
        repository = repository,
        gatewayProvider = { gateway },
        clock = { time++ },
        ids = SequentialIds(),
    )

    @Test
    fun `sending creates a titled conversation and streams a labelled answer`() = runTest {
        val gateway = ScriptedGateway()
        val session = session(gateway)

        assertTrue(session.send("  write a business plan for a bakery in Lagos  ", AssistantMode.BUSINESS))
        advanceUntilIdle()

        val state = session.state.value
        val conversation = assertNotNull(state.conversation)
        assertEquals("Write a business plan for a bakery in Lagos", conversation.title)
        assertEquals(AssistantMode.BUSINESS, conversation.mode)
        assertFalse(state.isGenerating)
        assertEquals(listOf(MessageRole.USER, MessageRole.ASSISTANT), state.messages.map { it.role })
        val answer = state.messages[1]
        assertEquals("Hello from DASH AI", answer.content)
        assertEquals(MessageStatus.COMPLETE, answer.status)
        assertNull(answer.provider)
        assertEquals("DASH AI", answer.sourceLabel)
        assertEquals(ModelChoice.SMART, gateway.requests.single().modelChoice)
        assertEquals(state.messages[0].id, answer.replyToId)

        // History survives: the repository holds the same conversation.
        assertEquals(listOf(conversation.id), repository.allConversations().map { it.id })
        assertEquals(state.messages, repository.getMessages(conversation.id))
        assertEquals("write a business plan for a bakery in Lagos", gateway.requests.single().content)
    }

    @Test
    fun `blank messages and sends while generating are rejected`() = runTest {
        val session = session(ScriptedGateway { awaitCancellation() })
        assertFalse(session.send("   ", AssistantMode.GENERAL))
        assertTrue(session.send("first", AssistantMode.GENERAL))
        advanceUntilIdle()
        assertTrue(session.state.value.isGenerating)
        assertFalse(session.send("second", AssistantMode.GENERAL))
        session.stop()
        advanceUntilIdle()
    }

    @Test
    fun `stop keeps the partial answer, marks it stopped and cancels on the server`() = runTest {
        val gateway = ScriptedGateway { request ->
            emit(
                ChatStreamEvent.Started("stream-1", request.conversationId, null, listOf(StreamTarget("a1", ProviderId.ANTHROPIC, "m", false)), "r"),
            )
            emit(ChatStreamEvent.Delta("a1", "Partial ans"))
            awaitCancellation()
        }
        val session = session(gateway)
        session.send("Tell me a long story", AssistantMode.WRITING)
        advanceUntilIdle()
        assertTrue(session.state.value.isGenerating)
        assertEquals("stream-1", session.state.value.activeStreamId)
        assertEquals(MessageStatus.STREAMING, session.state.value.messages.last().status)

        session.stop()
        advanceUntilIdle()

        val answer = session.state.value.messages.last()
        assertEquals(MessageStatus.STOPPED, answer.status)
        assertEquals("Partial ans", answer.content)
        assertFalse(session.state.value.isGenerating)
        assertNull(session.state.value.error)
        assertEquals(listOf("stream-1"), gateway.cancelledStreams)
        assertEquals(MessageStatus.STOPPED, repository.getMessages(answer.conversationId).last().status)
    }

    @Test
    fun `regenerate replaces the answer and resends the same message id`() = runTest {
        var call = 0
        val gateway = ScriptedGateway { request -> answer(request, ProviderId.OPENAI, "Answer ${++call}") }
        val session = session(gateway)
        session.send("Question", AssistantMode.GENERAL)
        advanceUntilIdle()
        val firstAnswer = session.state.value.messages.last()

        assertTrue(session.regenerate(firstAnswer.id))
        advanceUntilIdle()

        val messages = session.state.value.messages
        assertEquals(2, messages.size)
        assertEquals("Answer 2", messages.last().content)
        assertEquals(gateway.requests[0].messageId, gateway.requests[1].messageId)
        assertTrue(repository.getMessages(firstAnswer.conversationId).none { it.id == firstAnswer.id })
    }

    @Test
    fun `an engineering server's provider is kept internally but never shown`() = runTest {
        val session = session(ScriptedGateway { request -> answer(request, ProviderId.ANTHROPIC, "Internal") })
        session.send("Hi", AssistantMode.GENERAL)
        advanceUntilIdle()
        val answer = session.state.value.messages.last()
        assertEquals(ProviderId.ANTHROPIC, answer.provider)
        assertEquals("DASH AI", answer.sourceLabel)
    }

    @Test
    fun `edit and resend replaces everything after the edited message`() = runTest {
        val gateway = ScriptedGateway { request -> answer(request, ProviderId.OPENAI, "Re: ${request.content}") }
        val session = session(gateway)
        session.send("First question", AssistantMode.GENERAL)
        advanceUntilIdle()
        session.send("Second question", AssistantMode.GENERAL)
        advanceUntilIdle()
        val firstUser = session.state.value.messages.first()

        assertTrue(session.editAndResend(firstUser.id, "Edited question", AssistantMode.GENERAL))
        advanceUntilIdle()

        val messages = session.state.value.messages
        assertEquals(listOf("Edited question", "Re: Edited question"), messages.map { it.content })
        assertEquals(firstUser.id, messages.first().id)
        assertTrue(gateway.requests.last().history.isEmpty())
        assertEquals(2, repository.getMessages(firstUser.conversationId).size)
    }

    @Test
    fun `Demo Mode gives one simulated DASH AI answer with no provider`() = runTest {
        val session = session(DemoChatGateway(chunkDelayMillis = 0, ids = SequentialIds("demo")))
        session.send("Plan a product launch", AssistantMode.BUSINESS)
        advanceUntilIdle()

        val answer = session.state.value.messages.filter { it.isAssistant }.single()
        assertTrue(answer.status == MessageStatus.COMPLETE && answer.isDemo)
        assertNull(answer.provider)
        assertNull(answer.compareGroupId)
        assertTrue(answer.content.startsWith("**Demo response · simulated by DASH AI"))
        assertEquals("Demo · DASH AI (simulated)", answer.sourceLabel)
        assertNoProviderName(answer.content, "demo answer")
    }

    @Test
    fun `request failures keep the question and can be retried`() = runTest {
        var fail = true
        val gateway = ScriptedGateway { request ->
            if (fail) throw ApiException(ApiError("provider_not_configured", "DASH AI is temporarily unavailable.", false))
            answer(request, ProviderId.ANTHROPIC, "Recovered")
        }
        val session = session(gateway)
        session.send("Hello", AssistantMode.GENERAL)
        advanceUntilIdle()
        assertEquals("provider_not_configured", session.state.value.error?.code)
        assertEquals(1, session.state.value.messages.size)
        assertFalse(session.state.value.isGenerating)

        fail = false
        assertTrue(session.retryLast())
        advanceUntilIdle()
        assertNull(session.state.value.error)
        assertEquals("Recovered", session.state.value.messages.last().content)
    }

    @Test
    fun `per-answer failures are shown on the answer`() = runTest {
        val gateway = ScriptedGateway { request ->
            emit(ChatStreamEvent.Started("s", request.conversationId, null, listOf(StreamTarget("x", demo = false)), "r"))
            emit(ChatStreamEvent.MessageFailed("x", ApiError("provider_timeout", "DASH AI took too long to respond. Please try again.", true)))
            emit(ChatStreamEvent.Ended("s"))
        }
        val session = session(gateway)
        session.send("Hi", AssistantMode.GENERAL)
        advanceUntilIdle()
        val answer = session.state.value.messages.last()
        assertEquals(MessageStatus.FAILED, answer.status)
        assertEquals("DASH AI took too long to respond. Please try again.", answer.errorMessage)
        assertTrue(answer.errorRetryable)
    }

    @Test
    fun `failures keep the recovery details and Regenerate asks DASH AI again`() = runTest {
        var failing = true
        val gateway = ScriptedGateway { request ->
            if (failing) {
                emit(ChatStreamEvent.Started("s", request.conversationId, null, listOf(StreamTarget("x", demo = false)), "r"))
                emit(ChatStreamEvent.MessageFailed("x", ApiError("provider_unavailable", "DASH AI couldn't complete that response. Please try again.", true), 3))
                emit(ChatStreamEvent.Ended("s"))
            } else {
                answer(request, null, "Back")
            }
        }
        val session = session(gateway)
        session.send("Hi", AssistantMode.GENERAL)
        advanceUntilIdle()
        val recovery = assertNotNull(session.state.value.recovery["x"])
        assertEquals(3, recovery.attempts)
        // Exactly one request: the app never retries by itself.
        assertEquals(1, gateway.requests.size)

        failing = false
        assertTrue(session.regenerate("x"))
        advanceUntilIdle()
        assertEquals(ModelChoice.SMART, gateway.requests.last().modelChoice)
        assertEquals(gateway.requests[0].messageId, gateway.requests[1].messageId)
        assertEquals("Back", session.state.value.messages.last().content)
        assertTrue(session.state.value.recovery.isEmpty())
    }

    @Test
    fun `tool activity is recorded per answer with names and outcomes only`() = runTest {
        val gateway = ScriptedGateway { request ->
            emit(ChatStreamEvent.Started("s", request.conversationId, null, listOf(StreamTarget("x", demo = false)), "r"))
            emit(ChatStreamEvent.ToolCalled("x", "call_1", "dash-demo", "text_stats"))
            emit(ChatStreamEvent.ToolCalled("x", "call_1", "dash-demo", "text_stats")) // duplicate delivery
            emit(ChatStreamEvent.ToolCalled("someone-else", "call_9", "dash-demo", "current_time")) // not this answer
            emit(ChatStreamEvent.ToolFinished("x", "call_1", "dash-demo", "text_stats", ToolCallStatus.OK, 3))
            emit(ChatStreamEvent.ToolCalled("x", "call_2", "dash-demo", "current_time"))
            emit(ChatStreamEvent.Delta("x", "Done"))
            emit(ChatStreamEvent.MessageEnded("x", FinishReason.STOP, 1, 1))
            emit(ChatStreamEvent.Ended("s"))
        }
        val session = session(gateway)
        session.send("Count my words", AssistantMode.GENERAL)
        advanceUntilIdle()
        val uses = session.state.value.toolUses
        assertEquals(setOf("x"), uses.keys)
        assertEquals(listOf("call_1", "call_2"), uses.getValue("x").map { it.callId })
        assertEquals(ToolCallStatus.OK, uses.getValue("x")[0].status)
        // call_2 never reported; the answer completed, so it is shown as running until a stop/failure closes it.
        assertNull(uses.getValue("x")[1].status)
        assertEquals("Done", session.state.value.messages.last().content)
    }

    @Test
    fun `reopening a conversation shows the tools its answers used, as recorded`() = runTest {
        val gateway = ScriptedGateway { request ->
            emit(ChatStreamEvent.Started("s", request.conversationId, null, listOf(StreamTarget("x", demo = false)), "r"))
            emit(ChatStreamEvent.ToolCalled("x", "call_1", "dash-demo", "text_stats"))
            emit(ChatStreamEvent.ToolFinished("x", "call_1", "dash-demo", "text_stats", ToolCallStatus.OK, 3))
            emit(ChatStreamEvent.ToolCalled("x", "call_2", "dash-demo", "current_time")) // never reports an outcome
            emit(ChatStreamEvent.Delta("x", "Done"))
            emit(ChatStreamEvent.MessageEnded("x", FinishReason.STOP, 1, 1))
            emit(ChatStreamEvent.Ended("s"))
        }
        val first = session(gateway)
        first.send("Count my words", AssistantMode.GENERAL)
        advanceUntilIdle()
        val conversationId = first.state.value.conversation!!.id

        // A later visit (another screen, or after the app restarted) reads the saved conversation.
        val later = session(gateway)
        later.open(conversationId)
        val restored = later.state.value.toolUses
        assertEquals(setOf("x"), restored.keys)
        // Only the call with a recorded outcome comes back; nothing is invented for the other one.
        assertEquals(listOf(ToolUse("call_1", "dash-demo", "text_stats", ToolCallStatus.OK, 3)), restored.getValue("x"))
        // The user's message has no tool activity.
        assertTrue(later.state.value.messages.first { it.isUser }.tools.isEmpty())
    }

    @Test
    fun `a stopped answer keeps its stopped tools when reopened`() = runTest {
        val gateway = ScriptedGateway { request ->
            emit(ChatStreamEvent.Started("s", request.conversationId, null, listOf(StreamTarget("x", demo = false)), "r"))
            emit(ChatStreamEvent.ToolCalled("x", "call_1", "dash-demo", "current_time"))
            awaitCancellation()
        }
        val first = session(gateway)
        first.send("Time?", AssistantMode.GENERAL)
        advanceUntilIdle()
        first.stop()
        advanceUntilIdle()
        val later = session(gateway)
        later.open(first.state.value.conversation!!.id)
        assertEquals(ToolCallStatus.CANCELLED, later.state.value.toolUses.getValue("x").single().status)
    }

    @Test
    fun `a lost connection ends the streaming answer at once as failed, keeping its text and offering retry`() = runTest {
        val gateway = ScriptedGateway { request ->
            emit(ChatStreamEvent.Started("s", request.conversationId, null, listOf(StreamTarget("x", demo = false)), "r"))
            emit(ChatStreamEvent.Delta("x", "Part one"))
            emit(ChatStreamEvent.ToolCalled("x", "call_1", "dash-demo", "current_time"))
            awaitCancellation()
        }
        val session = session(gateway)
        session.send("Tell me", AssistantMode.GENERAL)
        advanceUntilIdle()
        assertTrue(session.state.value.isGenerating)
        session.connectionLost()
        advanceUntilIdle()
        val state = session.state.value
        assertFalse(state.isGenerating)
        val answer = state.messages.last()
        assertEquals(MessageStatus.FAILED, answer.status)
        assertEquals("Part one", answer.content)
        assertTrue(answer.errorRetryable)
        assertEquals(ApiError.connectionLost, state.error)
        assertEquals(ToolCallStatus.ERROR, state.toolUses.getValue("x").single().status)
        assertTrue(gateway.cancelledStreams.isEmpty()) // the server cannot be reached; nothing is sent
        // Kept as failed after a restart too.
        assertEquals(MessageStatus.FAILED, repository.getMessages(state.conversation!!.id).last().status)
        session.connectionLost() // nothing streaming: no effect
        assertEquals(state.messages, session.state.value.messages)
    }

    @Test
    fun `stopping closes tools that were still running`() = runTest {
        val gateway = ScriptedGateway { request ->
            emit(ChatStreamEvent.Started("s", request.conversationId, null, listOf(StreamTarget("x", demo = false)), "r"))
            emit(ChatStreamEvent.ToolCalled("x", "call_1", "dash-demo", "current_time"))
            awaitCancellation()
        }
        val session = session(gateway)
        session.send("Time?", AssistantMode.GENERAL)
        advanceUntilIdle()
        assertTrue(session.state.value.toolUses.getValue("x").single().running)
        session.stop()
        advanceUntilIdle()
        assertEquals(ToolCallStatus.CANCELLED, session.state.value.toolUses.getValue("x").single().status)
        assertEquals(MessageStatus.STOPPED, session.state.value.messages.last().status)
    }

    @Test
    fun `a new chat starts without the previous chat's tool activity or recovery`() = runTest {
        val gateway = ScriptedGateway { request ->
            emit(ChatStreamEvent.Started("s", request.conversationId, null, listOf(StreamTarget("x", demo = false)), "r"))
            emit(ChatStreamEvent.ToolCalled("x", "call_1", "dash-demo", "current_time"))
            emit(ChatStreamEvent.MessageFailed("x", ApiError("provider_error", "Failed.", true), 1))
            emit(ChatStreamEvent.Ended("s"))
        }
        val session = session(gateway)
        session.send("Hi", AssistantMode.GENERAL)
        advanceUntilIdle()
        assertTrue(session.state.value.toolUses.isNotEmpty())
        assertTrue(session.state.value.recovery.isNotEmpty())
        session.newChat()
        assertTrue(session.state.value.toolUses.isEmpty())
        assertTrue(session.state.value.recovery.isEmpty())
        assertTrue(session.state.value.isEmpty)
    }

    @Test
    fun `streams that end without finishing an answer mark it failed`() = runTest {
        val gateway = ScriptedGateway { request ->
            emit(ChatStreamEvent.Started("s", request.conversationId, null, listOf(StreamTarget("x", demo = false)), "r"))
            emit(ChatStreamEvent.Delta("x", "cut"))
        }
        val session = session(gateway)
        session.send("Hi", AssistantMode.GENERAL)
        advanceUntilIdle()
        assertEquals(MessageStatus.FAILED, session.state.value.messages.last().status)
    }

    @Test
    fun `history carries every earlier DASH AI answer as plain text, never demo answers`() = runTest {
        var next: ProviderId? = ProviderId.OPENAI
        var demo = false
        val gateway = ScriptedGateway { request ->
            val id = nextId("ans")
            emit(ChatStreamEvent.Started("s", request.conversationId, null, listOf(StreamTarget(id, next, null, demo)), "r"))
            emit(ChatStreamEvent.Delta(id, "answer ${next?.wire} demo=$demo"))
            emit(ChatStreamEvent.MessageEnded(id, com.dashworldng.ai.core.model.FinishReason.STOP, null, null))
        }
        val session = session(gateway)
        session.send("q1", AssistantMode.GENERAL)
        advanceUntilIdle()
        demo = true
        session.send("q2", AssistantMode.GENERAL)
        advanceUntilIdle()
        demo = false
        next = null
        session.send("q3", AssistantMode.GENERAL)
        advanceUntilIdle()
        session.send("q4", AssistantMode.GENERAL)
        advanceUntilIdle()

        val history = gateway.requests.last().history
        assertEquals(listOf("q1", "answer openai demo=false", "q2", "q3", "answer null demo=false"), history.map { it.content })
        assertEquals(listOf(MessageRole.USER, MessageRole.ASSISTANT, MessageRole.USER, MessageRole.USER, MessageRole.ASSISTANT), history.map { it.role })
    }

    @Test
    fun `opening a conversation restores history and marks interrupted answers stopped`() = runTest {
        val session = session(ScriptedGateway())
        session.send("Keep this", AssistantMode.GENERAL)
        advanceUntilIdle()
        val id = session.state.value.conversation!!.id
        val answer = session.state.value.messages.last()
        repository.upsertMessage(answer.copy(status = MessageStatus.STREAMING))

        val reopened = session(ScriptedGateway())
        reopened.open(id)
        assertEquals(2, reopened.state.value.messages.size)
        assertEquals(MessageStatus.STOPPED, reopened.state.value.messages.last().status)
        assertEquals("Keep this", reopened.state.value.conversation!!.title)
    }

    @Test
    fun `switching conversations mid-stream stops the old answer without touching the new chat`() = runTest {
        val gateway = ScriptedGateway { request ->
            emit(ChatStreamEvent.Started("s", request.conversationId, null, listOf(StreamTarget("slow", demo = false)), "r"))
            emit(ChatStreamEvent.Delta("slow", "half"))
            awaitCancellation()
        }
        val session = session(gateway)
        session.send("First chat", AssistantMode.GENERAL)
        advanceUntilIdle()
        val firstId = session.state.value.conversation!!.id

        session.newChat()
        advanceUntilIdle()

        assertNull(session.state.value.conversation)
        assertTrue(session.state.value.messages.isEmpty())
        assertFalse(session.state.value.isGenerating)
        assertEquals(MessageStatus.STOPPED, repository.getMessages(firstId).last().status)
    }

    @Test
    fun `server titles apply unless the user renamed the chat`() = runTest {
        val gateway = ScriptedGateway { request ->
            emit(ChatStreamEvent.TitleChanged(request.conversationId, "Server title"))
            answer(request, ProviderId.OPENAI, "ok")
        }
        val session = session(gateway)
        session.send("local title", AssistantMode.GENERAL)
        advanceUntilIdle()
        assertEquals("Server title", session.state.value.conversation!!.title)

        val id = session.state.value.conversation!!.id
        repository.renameConversation(id, "Mine")
        session.onConversationRenamed(id, "Mine")
        session.send("again", AssistantMode.GENERAL)
        advanceUntilIdle()
        assertEquals("Mine", session.state.value.conversation!!.title)
        assertEquals("Mine", repository.getConversation(id)!!.title)
    }

    @Test
    fun `attachments and mode travel with the request`() = runTest {
        val gateway = ScriptedGateway()
        val session = session(gateway)
        val doc = AttachmentRef("local-1", "remote-1", "plan.pdf", DocumentKind.PDF, 1234)
        session.send("Summarise", AssistantMode.DOCUMENTS, listOf(doc))
        advanceUntilIdle()
        val request = gateway.requests.single()
        assertEquals(AssistantMode.DOCUMENTS, request.mode)
        assertEquals(listOf(doc), request.attachments)
        assertEquals(listOf(doc), session.state.value.messages.first().attachments)
    }

    @Test
    fun `new conversations remember whether they were created in demo mode`() = runTest {
        val session = session(DemoChatGateway(chunkDelayMillis = 0))
        session.send("Hi", AssistantMode.GENERAL)
        advanceUntilIdle()
        assertTrue(session.state.value.conversation!!.isDemo)
    }

    @Test
    fun `live user messages are reported for sync even when the request fails and demo messages never are`() = runTest {
        val reported = mutableListOf<String>()
        val offline = ScriptedGateway { throw ApiException(ApiError.network()) }
        val live = ChatSession(this, repository, { offline }, { time++ }, SequentialIds(), onUserMessageSaved = { reported += it })
        assertTrue(live.send("written while offline", AssistantMode.GENERAL))
        advanceUntilIdle()
        val id = live.state.value.conversation!!.id
        assertEquals(listOf(id), reported)
        assertEquals(listOf("written while offline"), repository.getMessages(id).map { it.content })

        val demo = ChatSession(this, repository, { DemoChatGateway(chunkDelayMillis = 0) }, { time++ }, SequentialIds("d"), onUserMessageSaved = { reported += it })
        demo.send("demo only", AssistantMode.GENERAL)
        advanceUntilIdle()
        assertEquals(listOf(id), reported)
    }

    @Test
    fun `a failing sync callback never breaks sending`() = runTest {
        val session = ChatSession(this, repository, { ScriptedGateway() }, { time++ }, SequentialIds(), onUserMessageSaved = { error("sync storage is broken") })
        session.send("hello", AssistantMode.GENERAL)
        advanceUntilIdle()
        assertEquals(MessageStatus.COMPLETE, session.state.value.messages.last().status)
        assertNull(session.state.value.error)
    }
}
