package com.dashworldng.ai

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.dashworldng.ai.core.chat.ChatGateway
import com.dashworldng.ai.core.chat.ChatRequest
import com.dashworldng.ai.core.demo.DemoChatGateway
import com.dashworldng.ai.core.model.AssistantMode
import com.dashworldng.ai.core.model.ChatMessage
import com.dashworldng.ai.core.model.Conversation
import com.dashworldng.ai.core.model.MessageRole
import com.dashworldng.ai.core.model.ProviderId
import com.dashworldng.ai.core.stream.ChatStreamEvent
import com.dashworldng.ai.core.stream.StreamTarget
import com.dashworldng.ai.data.settings.AccountInfo
import com.dashworldng.ai.data.settings.AppSettings
import com.dashworldng.ai.di.InMemoryServices
import com.dashworldng.ai.ui.DashAiApp
import com.dashworldng.ai.ui.Routes
import com.dashworldng.ai.ui.theme.DashAiTheme
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.runBlocking
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** A gateway that starts an answer and never finishes it, so tests can press Stop. */
private class HangingGateway : ChatGateway {
    override val isDemo: Boolean = true
    val cancelled = mutableListOf<String>()

    override fun stream(request: ChatRequest): Flow<ChatStreamEvent> = flow {
        emit(ChatStreamEvent.Started("stream-1", request.conversationId, null, listOf(StreamTarget("answer-1", ProviderId.OPENAI, "demo-openai", true)), "test"))
        emit(ChatStreamEvent.Delta("answer-1", "Partial answer"))
        awaitCancellation()
    }

    override suspend fun cancel(streamId: String) {
        cancelled += streamId
    }
}

@RunWith(AndroidJUnit4::class)
@Config(sdk = [34])
class DashAiUiTest {
    @get:Rule
    val compose = createComposeRule()

    private val demoAccount = AccountInfo("demo-local", null, "Demo user", isDemo = true)
    private val signedInDemo = AppSettings(loaded = true, onboardingComplete = true, demoMode = true, serverUrl = "http://127.0.0.1:8787/", account = demoAccount)

    private fun launch(services: InMemoryServices, start: String) {
        compose.setContent { DashAiTheme { DashAiApp(services, startDestination = start) } }
        compose.waitForIdle()
    }

    private fun waitForTag(tag: String) {
        compose.waitUntil(timeoutMillis = 5_000) { compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty() }
    }

    private fun waitForText(text: String) {
        compose.waitUntil(timeoutMillis = 5_000) { compose.onAllNodes(hasText(text, substring = true)).fetchSemanticsNodes().isNotEmpty() }
    }

    @Test
    fun splashLeadsToOnboardingOnFirstLaunch() {
        val services = InMemoryServices(AppSettings(loaded = true))
        compose.mainClock.autoAdvance = false
        launch(services, Routes.SPLASH)
        compose.onNodeWithTag("splash").assertExists()
        compose.mainClock.autoAdvance = true
        waitForTag("onboarding")
        compose.onNodeWithText("Welcome to Dash AI").assertIsDisplayed()
    }

    @Test
    fun onboardingExplainsModelsModesAndPrivacyThenOpensSignIn() {
        val services = InMemoryServices(AppSettings(loaded = true))
        launch(services, Routes.ONBOARDING)
        compose.onNodeWithText("Welcome to Dash AI").assertIsDisplayed()
        compose.onNodeWithTag("onboarding_next").performClick()
        waitForText("Choose how Dash AI thinks")
        compose.onNodeWithTag("onboarding_next").performClick()
        waitForText("Five focused modes")
        compose.onNodeWithTag("onboarding_next").performClick()
        waitForText("Private by design")
        compose.onNodeWithTag("onboarding_start").performClick()
        waitForTag("auth_screen")
        assertTrue(services.settings.settings.value.onboardingComplete)
    }

    @Test
    fun continuingInDemoModeOpensTheAssistant() {
        val services = InMemoryServices(AppSettings(loaded = true, onboardingComplete = true, serverUrl = "http://127.0.0.1:8787/"))
        launch(services, Routes.AUTH)
        compose.onNodeWithTag("continue_demo").performClick()
        waitForTag("empty_chat")
        compose.onNodeWithTag("demo_banner").assertExists()
        assertEquals(true, services.settings.settings.value.account?.isDemo)
    }

    @Test
    fun signInValidatesInputBeforeContactingTheServer() {
        val services = InMemoryServices(AppSettings(loaded = true, onboardingComplete = true, serverUrl = "http://127.0.0.1:8787/"))
        launch(services, Routes.AUTH)
        compose.onNodeWithTag("auth_email").performTextInput("not-an-email")
        compose.onNodeWithTag("auth_submit").performClick()
        compose.waitForIdle()
        compose.onNodeWithText("Enter a valid email address.").assertExists()
        compose.onNodeWithText("Enter your password.").assertExists()
    }

    @Test
    fun sendingAMessageStreamsALabelledDemoAnswer() {
        val services = InMemoryServices(signedInDemo, chatGatewayOverride = DemoChatGateway(chunkDelayMillis = 0))
        launch(services, Routes.CHAT)
        compose.onNodeWithTag("empty_chat").assertExists()
        compose.onNodeWithTag("composer_input").performTextInput("Draft a launch plan")
        compose.onNodeWithTag("send_button").performClick()
        waitForTag("assistant_message")
        waitForText("Demo response · simulated")
        compose.onNodeWithTag("user_message").assertExists()
        compose.onNodeWithTag("model_label").assertTextContains("simulated", substring = true)
        compose.onNodeWithTag("chat_title").assertTextContains("Draft a launch plan")
        compose.onNodeWithTag("send_button").assertExists()
    }

    @Test
    fun modelSelectionIncludingTheCompareWarning() {
        val services = InMemoryServices(signedInDemo, chatGatewayOverride = DemoChatGateway(chunkDelayMillis = 0))
        launch(services, Routes.CHAT)
        compose.onNodeWithTag("selected_model").assertTextContains("Dash Smart")

        compose.onNodeWithTag("model_selector").performClick()
        compose.onNodeWithTag("model_option_claude").performClick()
        compose.waitForIdle()
        compose.onNodeWithTag("selected_model").assertTextContains("Claude")

        compose.onNodeWithTag("model_selector").performClick()
        compose.onNodeWithTag("model_option_compare").performClick()
        compose.waitForIdle()
        compose.onNodeWithText("Compare uses both providers").assertIsDisplayed()
        compose.onNodeWithText("may cost more", substring = true).assertExists()
        compose.onNodeWithTag("confirm_compare").performClick()
        compose.waitForIdle()
        compose.onNodeWithTag("selected_model").assertTextContains("Compare")

        compose.onNodeWithTag("composer_input").performTextInput("Compare these")
        compose.onNodeWithTag("send_button").performClick()
        waitForTag("compare_row")
        waitForText("simulated OpenAI style")
        waitForText("simulated Claude style")
    }

    @Test
    fun switchingModeChangesSuggestionsAndShowsResearchLimits() {
        val services = InMemoryServices(signedInDemo)
        launch(services, Routes.CHAT)
        compose.onNodeWithTag("mode_research").performClick()
        compose.waitForIdle()
        compose.onNodeWithTag("mode_limitation").assertExists()
        compose.onNodeWithText("Live web research is not connected", substring = true).assertExists()
        compose.onNodeWithText(AssistantMode.RESEARCH.suggestions.first()).assertExists()
    }

    @Test
    fun stoppingGenerationKeepsThePartialAnswer() {
        val gateway = HangingGateway()
        val services = InMemoryServices(signedInDemo, chatGatewayOverride = gateway)
        launch(services, Routes.CHAT)
        compose.onNodeWithTag("composer_input").performTextInput("Write a long story")
        compose.onNodeWithTag("send_button").performClick()
        waitForTag("stop_button")
        waitForText("Partial answer")
        compose.onNodeWithText("Generating…").assertExists()

        compose.onNodeWithTag("stop_button").performClick()
        waitForTag("send_button")
        waitForText("Stopped")
        compose.onNodeWithText("Partial answer").assertExists()
        compose.waitUntil(5_000) { gateway.cancelled == listOf("stream-1") }
    }

    @Test
    fun openingHistoryShowsAndRestoresSavedConversations() {
        val services = InMemoryServices(signedInDemo)
        runBlocking {
            services.conversations.upsertConversation(Conversation("conv-1", "Quarterly plan", AssistantMode.BUSINESS, 1_000, 2_000))
            services.conversations.upsertMessage(ChatMessage("m1", "conv-1", MessageRole.USER, "Plan Q3 please", 1_000))
            services.conversations.upsertMessage(
                ChatMessage("m2", "conv-1", MessageRole.ASSISTANT, "## Q3 plan\n- Grow revenue", 1_001, provider = ProviderId.OPENAI, model = "demo-openai", isDemo = true),
            )
        }
        launch(services, Routes.CHAT)
        compose.onNodeWithTag("open_history").performClick()
        waitForTag("history_list")
        compose.onNodeWithText("Quarterly plan").assertExists()
        compose.onNodeWithText("Quarterly plan").performClick()
        waitForText("Plan Q3 please")
        compose.onNodeWithTag("chat_title").assertTextContains("Quarterly plan")
        compose.onNodeWithText("Grow revenue", substring = true).assertExists()
    }

    @Test
    fun newChatClearsTheConversation() {
        val services = InMemoryServices(signedInDemo, chatGatewayOverride = DemoChatGateway(chunkDelayMillis = 0))
        launch(services, Routes.CHAT)
        compose.onNodeWithTag("composer_input").performTextInput("First question")
        compose.onNodeWithTag("send_button").performClick()
        waitForTag("assistant_message")
        compose.onNodeWithTag("new_chat").performClick()
        waitForTag("empty_chat")
        compose.onNodeWithTag("chat_title").assertTextContains("Dash AI")
    }

    @Test
    fun promptLibrarySearchAndUseFillsTheComposer() {
        val services = InMemoryServices(signedInDemo)
        launch(services, Routes.CHAT)
        compose.onNodeWithTag("open_history").performClick()
        waitForTag("drawer_prompts")
        compose.onNodeWithTag("drawer_prompts").performClick()
        waitForTag("prompt_library")
        compose.onNodeWithTag("prompt_search").performTextInput("SWOT")
        compose.waitForIdle()
        compose.onNodeWithText("SWOT analysis").assertExists()
        compose.onAllNodes(hasTestTag("use_prompt"))[0].performClick()
        waitForTag("composer_input")
        compose.onNodeWithTag("composer_input").assertTextContains("SWOT analysis", substring = true)
    }
}
