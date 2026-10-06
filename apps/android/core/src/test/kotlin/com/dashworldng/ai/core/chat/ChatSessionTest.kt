package com.dashworldng.ai.core.chat

import com.dashworldng.ai.core.ScriptedGateway
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

        assertTrue(session.send("  write a business plan for a bakery in Lagos  ", ModelChoice.OPENAI, AssistantMode.BUSINESS))
        advanceUntilIdle()

        val state = session.state.value
        val conversation = assertNotNull(state.conversation)
        assertEquals("Write a business plan for a bakery in Lagos", conversation.title)
        assertEquals(AssistantMode.BUSINESS, conversation.mode)
        assertFalse(state.isGenerating)
        assertEquals(listOf(MessageRole.USER, MessageRole.ASSISTANT), state.messages.map { it.role })
        val answer = state.messages[1]
        assertEquals("Hello from OpenAI", answer.content)
        assertEquals(MessageStatus.COMPLETE, answer.status)
        assertEquals(ProviderId.OPENAI, answer.provider)
        assertEquals("OpenAI · model-openai", answer.sourceLabel)
        assertEquals(state.messages[0].id, answer.replyToId)

        // History survives: the repository holds the same conversation.
        assertEquals(listOf(conversation.id), repository.allConversations().map { it.id })
        assertEquals(state.messages, repository.getMessages(conversation.id))
        assertEquals("write a business plan for a bakery in Lagos", gateway.requests.single().content)
    }

    @Test
    fun `blank messages and sends while generating are rejected`() = runTest {
        val session = session(ScriptedGateway { awaitCancellation() })
        assertFalse(session.send("   ", ModelChoice.SMART, AssistantMode.GENERAL))
        assertTrue(session.send("first", ModelChoice.SMART, AssistantMode.GENERAL))
        advanceUntilIdle()
        assertTrue(session.state.value.isGenerating)
        assertFalse(session.send("second", ModelChoice.SMART, AssistantMode.GENERAL))
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
        session.send("Tell me a long story", ModelChoice.CLAUDE, AssistantMode.WRITING)
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
        session.send("Question", ModelChoice.OPENAI, AssistantMode.GENERAL)
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
    fun `retry with the other provider switches provider explicitly`() = runTest {
        val gateway = ScriptedGateway { request ->
            val provider = if (request.modelChoice == ModelChoice.CLAUDE) ProviderId.ANTHROPIC else ProviderId.OPENAI
            answer(request, provider, "From ${provider.displayName}")
        }
        val session = session(gateway)
        session.send("Compare later", ModelChoice.OPENAI, AssistantMode.GENERAL)
        advanceUntilIdle()
        assertTrue(session.retryWithOtherProvider(session.state.value.messages.last().id))
        advanceUntilIdle()

        assertEquals(ModelChoice.CLAUDE, gateway.requests.last().modelChoice)
        val answer = session.state.value.messages.last()
        assertEquals(ProviderId.ANTHROPIC, answer.provider)
        assertEquals("From Claude", answer.content)
        assertEquals(2, session.state.value.messages.size)
    }

    @Test
    fun `edit and resend replaces everything after the edited message`() = runTest {
        val gateway = ScriptedGateway { request -> answer(request, ProviderId.OPENAI, "Re: ${request.content}") }
        val session = session(gateway)
        session.send("First question", ModelChoice.OPENAI, AssistantMode.GENERAL)
        advanceUntilIdle()
        session.send("Second question", ModelChoice.OPENAI, AssistantMode.GENERAL)
        advanceUntilIdle()
        val firstUser = session.state.value.messages.first()

        assertTrue(session.editAndResend(firstUser.id, "Edited question", ModelChoice.OPENAI, AssistantMode.GENERAL))
        advanceUntilIdle()

        val messages = session.state.value.messages
        assertEquals(listOf("Edited question", "Re: Edited question"), messages.map { it.content })
        assertEquals(firstUser.id, messages.first().id)
        assertTrue(gateway.requests.last().history.isEmpty())
        assertEquals(2, repository.getMessages(firstUser.conversationId).size)
    }

    @Test
    fun `compare produces two labelled answers in one group`() = runTest {
        val session = session(DemoChatGateway(chunkDelayMillis = 0, ids = SequentialIds("demo")))
        session.send("Plan a product launch", ModelChoice.COMPARE, AssistantMode.BUSINESS)
        advanceUntilIdle()

        val answers = session.state.value.messages.filter { it.isAssistant }
        assertEquals(setOf(ProviderId.OPENAI, ProviderId.ANTHROPIC), answers.map { it.provider }.toSet())
        assertTrue(answers.all { it.status == MessageStatus.COMPLETE && it.isDemo })
        val group = answers.map { it.compareGroupId }.distinct().single()
        assertEquals(session.state.value.messages.first().id, group)
        assertTrue(answers.all { it.content.startsWith("**Demo response") })
        assertTrue(answers.all { it.sourceLabel!!.contains("simulated") })
    }

    @Test
    fun `request failures keep the question and can be retried`() = runTest {
        var fail = true
        val gateway = ScriptedGateway { request ->
            if (fail) throw ApiException(ApiError("provider_not_configured", "Claude is not configured on this server.", false))
            answer(request, ProviderId.ANTHROPIC, "Recovered")
        }
        val session = session(gateway)
        session.send("Hello", ModelChoice.CLAUDE, AssistantMode.GENERAL)
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
            emit(ChatStreamEvent.Started("s", request.conversationId, null, listOf(StreamTarget("x", ProviderId.OPENAI, "m", false)), "r"))
            emit(ChatStreamEvent.MessageFailed("x", ApiError("provider_timeout", "OpenAI took too long to respond.", true)))
            emit(ChatStreamEvent.Ended("s"))
        }
        val session = session(gateway)
        session.send("Hi", ModelChoice.OPENAI, AssistantMode.GENERAL)
        advanceUntilIdle()
        val answer = session.state.value.messages.last()
        assertEquals(MessageStatus.FAILED, answer.status)
        assertEquals("OpenAI took too long to respond.", answer.errorMessage)
        assertTrue(answer.errorRetryable)
    }

    @Test
    fun `provider failures keep the recovery options and never switch provider by themselves`() = runTest {
        var failing = true
        val gateway = ScriptedGateway { request ->
            if (failing) {
                emit(ChatStreamEvent.Started("s", request.conversationId, null, listOf(StreamTarget("x", ProviderId.OPENAI, "m", false)), "r"))
                emit(ChatStreamEvent.MessageFailed("x", ApiError("provider_unavailable", "OpenAI is temporarily unavailable.", true), 3, listOf(ProviderId.ANTHROPIC)))
                emit(ChatStreamEvent.Ended("s"))
            } else {
                answer(request, if (request.modelChoice == ModelChoice.CLAUDE) ProviderId.ANTHROPIC else ProviderId.OPENAI, "Back")
            }
        }
        val session = session(gateway)
        session.send("Hi", ModelChoice.OPENAI, AssistantMode.GENERAL)
        advanceUntilIdle()
        val recovery = assertNotNull(session.state.value.recovery["x"])
        assertEquals(3, recovery.attempts)
        assertEquals(listOf(ProviderId.ANTHROPIC), recovery.alternatives)
        // Exactly one request: nothing was retried or rerouted without the user.
        assertEquals(1, gateway.requests.size)

        // The user explicitly chooses Claude: the same question is resent to Claude, and the stale option is gone.
        failing = false
        assertTrue(session.regenerate("x", ModelChoice.CLAUDE))
        advanceUntilIdle()
        assertEquals(ModelChoice.CLAUDE, gateway.requests.last().modelChoice)
        assertEquals(ProviderId.ANTHROPIC, session.state.value.messages.last().provider)
        assertTrue(session.state.value.recovery.isEmpty())
    }

    @Test
    fun `tool activity is recorded per answer with names and outcomes only`() = runTest {
        val gateway = ScriptedGateway { request ->
            emit(ChatStreamEvent.Started("s", request.conversationId, null, listOf(StreamTarget("x", ProviderId.OPENAI, "m", false)), "r"))
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
        session.send("Count my words", ModelChoice.OPENAI, AssistantMode.GENERAL)
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
            emit(ChatStreamEvent.Started("s", request.conversationId, null, listOf(StreamTarget("x", ProviderId.OPENAI, "m", false)), "r"))
            emit(ChatStreamEvent.ToolCalled("x", "call_1", "dash-demo", "text_stats"))
            emit(ChatStreamEvent.ToolFinished("x", "call_1", "dash-demo", "text_stats", ToolCallStatus.OK, 3))
            emit(ChatStreamEvent.ToolCalled("x", "call_2", "dash-demo", "current_time")) // never reports an outcome
            emit(ChatStreamEvent.Delta("x", "Done"))
            emit(ChatStreamEvent.MessageEnded("x", FinishReason.STOP, 1, 1))
            emit(ChatStreamEvent.Ended("s"))
        }
        val first = session(gateway)
        first.send("Count my words", ModelChoice.OPENAI, AssistantMode.GENERAL)
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
            emit(ChatStreamEvent.Started("s", request.conversationId, null, listOf(StreamTarget("x", ProviderId.OPENAI, "m", false)), "r"))
            emit(ChatStreamEvent.ToolCalled("x", "call_1", "dash-demo", "current_time"))
            awaitCancellation()
        }
        val first = session(gateway)
        first.send("Time?", ModelChoice.OPENAI, AssistantMode.GENERAL)
        advanceUntilIdle()
        first.stop()
        advanceUntilIdle()
        val later = session(gateway)
        later.open(first.state.value.conversation!!.id)
        assertEquals(ToolCallStatus.CANCELLED, later.state.value.toolUses.getValue("x").single().status)
    }

    @Test
    fun `stopping closes tools that were still running`() = runTest {
        val gateway = ScriptedGateway { request ->
            emit(ChatStreamEvent.Started("s", request.conversationId, null, listOf(StreamTarget("x", ProviderId.OPENAI, "m", false)), "r"))
            emit(ChatStreamEvent.ToolCalled("x", "call_1", "dash-demo", "current_time"))
            awaitCancellation()
        }
        val session = session(gateway)
        session.send("Time?", ModelChoice.OPENAI, AssistantMode.GENERAL)
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
            emit(ChatStreamEvent.Started("s", request.conversationId, null, listOf(StreamTarget("x", ProviderId.OPENAI, "m", false)), "r"))
            emit(ChatStreamEvent.ToolCalled("x", "call_1", "dash-demo", "current_time"))
            emit(ChatStreamEvent.MessageFailed("x", ApiError("provider_error", "Failed.", true), 1, listOf(ProviderId.ANTHROPIC)))
            emit(ChatStreamEvent.Ended("s"))
        }
        val session = session(gateway)
        session.send("Hi", ModelChoice.OPENAI, AssistantMode.GENERAL)
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
            emit(ChatStreamEvent.Started("s", request.conversationId, null, listOf(StreamTarget("x", ProviderId.OPENAI, "m", false)), "r"))
            emit(ChatStreamEvent.Delta("x", "cut"))
        }
        val session = session(gateway)
        session.send("Hi", ModelChoice.OPENAI, AssistantMode.GENERAL)
        advanceUntilIdle()
        assertEquals(MessageStatus.FAILED, session.state.value.messages.last().status)
    }

    @Test
    fun `history never forwards another provider's or demo answers`() = runTest {
        var next = ProviderId.OPENAI
        var demo = false
        val gateway = ScriptedGateway { request ->
            val id = nextId("ans")
            emit(ChatStreamEvent.Started("s", request.conversationId, null, listOf(StreamTarget(id, next, "m", demo)), "r"))
            emit(ChatStreamEvent.Delta(id, "answer from ${next.wire} demo=$demo"))
            emit(ChatStreamEvent.MessageEnded(id, com.dashworldng.ai.core.model.FinishReason.STOP, null, null))
        }
        val session = session(gateway)
        session.send("q1", ModelChoice.OPENAI, AssistantMode.GENERAL)
        advanceUntilIdle()
        demo = true
        session.send("q2", ModelChoice.OPENAI, AssistantMode.GENERAL)
        advanceUntilIdle()
        demo = false
        next = ProviderId.ANTHROPIC
        session.send("q3", ModelChoice.CLAUDE, AssistantMode.GENERAL)
        advanceUntilIdle()

        val claudeHistory = gateway.requests.last().history
        assertEquals(listOf("q1", "q2"), claudeHistory.map { it.content })
        assertTrue(claudeHistory.all { it.role == MessageRole.USER })

        session.send("q4", ModelChoice.SMART, AssistantMode.GENERAL)
        advanceUntilIdle()
        val smartHistory = gateway.requests.last().history
        // Smart/Compare send real answers labelled with their provider; the API filters per target.
        assertEquals(
            listOf(null, ProviderId.OPENAI, null, null, ProviderId.ANTHROPIC),
            smartHistory.map { it.origin },
        )
    }

    @Test
    fun `opening a conversation restores history and marks interrupted answers stopped`() = runTest {
        val session = session(ScriptedGateway())
        session.send("Keep this", ModelChoice.OPENAI, AssistantMode.GENERAL)
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
            emit(ChatStreamEvent.Started("s", request.conversationId, null, listOf(StreamTarget("slow", ProviderId.OPENAI, "m", false)), "r"))
            emit(ChatStreamEvent.Delta("slow", "half"))
            awaitCancellation()
        }
        val session = session(gateway)
        session.send("First chat", ModelChoice.OPENAI, AssistantMode.GENERAL)
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
        session.send("local title", ModelChoice.OPENAI, AssistantMode.GENERAL)
        advanceUntilIdle()
        assertEquals("Server title", session.state.value.conversation!!.title)

        val id = session.state.value.conversation!!.id
        repository.renameConversation(id, "Mine")
        session.onConversationRenamed(id, "Mine")
        session.send("again", ModelChoice.OPENAI, AssistantMode.GENERAL)
        advanceUntilIdle()
        assertEquals("Mine", session.state.value.conversation!!.title)
        assertEquals("Mine", repository.getConversation(id)!!.title)
    }

    @Test
    fun `attachments and mode travel with the request`() = runTest {
        val gateway = ScriptedGateway()
        val session = session(gateway)
        val doc = AttachmentRef("local-1", "remote-1", "plan.pdf", DocumentKind.PDF, 1234)
        session.send("Summarise", ModelChoice.SMART, AssistantMode.DOCUMENTS, listOf(doc))
        advanceUntilIdle()
        val request = gateway.requests.single()
        assertEquals(AssistantMode.DOCUMENTS, request.mode)
        assertEquals(listOf(doc), request.attachments)
        assertEquals(listOf(doc), session.state.value.messages.first().attachments)
    }

    @Test
    fun `new conversations remember whether they were created in demo mode`() = runTest {
        val session = session(DemoChatGateway(chunkDelayMillis = 0))
        session.send("Hi", ModelChoice.SMART, AssistantMode.GENERAL)
        advanceUntilIdle()
        assertTrue(session.state.value.conversation!!.isDemo)
    }

    @Test
    fun `live user messages are reported for sync even when the request fails and demo messages never are`() = runTest {
        val reported = mutableListOf<String>()
        val offline = ScriptedGateway { throw ApiException(ApiError.network()) }
        val live = ChatSession(this, repository, { offline }, { time++ }, SequentialIds(), onUserMessageSaved = { reported += it })
        assertTrue(live.send("written while offline", ModelChoice.OPENAI, AssistantMode.GENERAL))
        advanceUntilIdle()
        val id = live.state.value.conversation!!.id
        assertEquals(listOf(id), reported)
        assertEquals(listOf("written while offline"), repository.getMessages(id).map { it.content })

        val demo = ChatSession(this, repository, { DemoChatGateway(chunkDelayMillis = 0) }, { time++ }, SequentialIds("d"), onUserMessageSaved = { reported += it })
        demo.send("demo only", ModelChoice.SMART, AssistantMode.GENERAL)
        advanceUntilIdle()
        assertEquals(listOf(id), reported)
    }

    @Test
    fun `a failing sync callback never breaks sending`() = runTest {
        val session = ChatSession(this, repository, { ScriptedGateway() }, { time++ }, SequentialIds(), onUserMessageSaved = { error("sync storage is broken") })
        session.send("hello", ModelChoice.OPENAI, AssistantMode.GENERAL)
        advanceUntilIdle()
        assertEquals(MessageStatus.COMPLETE, session.state.value.messages.last().status)
        assertNull(session.state.value.error)
    }
}
