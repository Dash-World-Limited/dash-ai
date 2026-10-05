package com.dashworldng.ai

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.ComposeTimeoutException
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isRoot
import androidx.compose.ui.test.printToString
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
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
import com.dashworldng.ai.core.demo.DemoFailure
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
// Samsung A55-sized screen (≈411×891 dp) instead of Robolectric's small default.
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class DashAiUiTest {
    @get:Rule
    val compose = createComposeRule()

    private val demoAccount = AccountInfo("demo-local", null, "Demo user", isDemo = true)
    private val signedInDemo = AppSettings(loaded = true, onboardingComplete = true, demoMode = true, serverUrl = "http://127.0.0.1:8787/", account = demoAccount)

    private fun launch(services: InMemoryServices, start: String) {
        compose.setContent { DashAiApp(services, startDestination = start) }
        compose.waitForIdle()
    }

    /** Waits for a condition; on timeout, fails with the semantics tree (including bounds) for diagnosis. */
    private fun await(what: String, condition: () -> Boolean) {
        try {
            compose.waitUntil(timeoutMillis = 5_000, condition = condition)
        } catch (e: ComposeTimeoutException) {
            val tree = runCatching { compose.onAllNodes(isRoot(), useUnmergedTree = true).printToString(maxDepth = 40) }.getOrDefault("<unavailable>")
            throw AssertionError("Timed out waiting for $what. Semantics tree:\n$tree", e)
        }
    }

    private fun waitForTag(tag: String) = await("tag '$tag'") {
        compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty()
    }

    private fun waitForText(text: String) = await("text '$text'") {
        compose.onAllNodes(hasText(text, substring = true)).fetchSemanticsNodes().isNotEmpty()
    }

    /** The drawer is always composed; wait until it has actually slid on screen before tapping inside it. */
    private fun openHistoryDrawer() {
        compose.onNodeWithTag("open_history").performClick()
        // Wait until the slide-in has finished (left edge on screen); a tap during the animation can
        // land on the scrim, which just closes the drawer.
        await("the history drawer to be fully open") {
            runCatching {
                compose.onNodeWithTag("history_drawer", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot.left >= 0f
            }.getOrDefault(false)
        }
        compose.waitForIdle()
    }

    @Test
    fun splashLeadsToOnboardingOnFirstLaunch() {
        val services = InMemoryServices(AppSettings(loaded = true))
        compose.mainClock.autoAdvance = false
        launch(services, Routes.SPLASH)
        compose.onNodeWithTag("splash").assertExists()
        compose.mainClock.autoAdvance = true
        waitForTag("onboarding")
        compose.onNodeWithText("What are we building today?").assertIsDisplayed()
    }

    @Test
    fun onboardingIsOneCalmScreenThenOpensSignIn() {
        val services = InMemoryServices(AppSettings(loaded = true))
        launch(services, Routes.ONBOARDING)
        compose.onNodeWithTag("onboarding_title").assertTextContains("What are we building today?")
        compose.onNodeWithText("Get answers faster").assertExists()
        compose.onNodeWithText("Go deeper with context").assertExists()
        compose.onNodeWithText("Turn ideas into action").assertExists()
        compose.onNodeWithTag("onboarding_start").performScrollTo().performClick()
        waitForTag("auth_screen")
        assertTrue(services.settings.settings.value.onboardingComplete)
    }

    @Test
    fun returningUsersSkipOnboardingAndGoHome() {
        val services = InMemoryServices(signedInDemo)
        compose.mainClock.autoAdvance = true
        launch(services, Routes.SPLASH)
        waitForTag("home_screen")
        assertEquals(0, compose.onAllNodesWithTag("onboarding").fetchSemanticsNodes().size)
    }

    @Test
    fun authOffersOnlyEmailAndPasswordAndDemoMode() {
        val services = InMemoryServices(AppSettings(loaded = true, onboardingComplete = true, serverUrl = "http://127.0.0.1:8787/"))
        launch(services, Routes.AUTH)
        for (absent in listOf("Google", "Microsoft", "Apple")) {
            assertEquals(0, compose.onAllNodes(hasText(absent, substring = true)).fetchSemanticsNodes().size, "no $absent sign-in")
        }
        compose.onNodeWithTag("tab_create").performClick()
        compose.waitForIdle()
        compose.onNodeWithTag("auth_name").assertExists()
        compose.onNodeWithText("Create your account").assertExists()
    }

    @Test
    fun signingInWhileOfflineExplainsInsteadOfFailingSilently() {
        val services = InMemoryServices(
            AppSettings(loaded = true, onboardingComplete = true, serverUrl = "http://127.0.0.1:8787/"),
            fixedConnectivity = com.dashworldng.ai.data.FixedConnectivity(false),
        )
        launch(services, Routes.AUTH)
        compose.onNodeWithTag("auth_offline").assertExists()
        compose.onNodeWithTag("auth_email").performTextInput("ada@example.com")
        compose.onNodeWithTag("auth_password").performTextInput("correct horse battery")
        compose.onNodeWithTag("auth_submit").performScrollTo().performClick()
        waitForTag("auth_error")
        compose.onNodeWithText("Connect to the internet and try again", substring = true).assertExists()
    }

    @Test
    fun continuingInDemoModeOpensTheAssistant() {
        val services = InMemoryServices(AppSettings(loaded = true, onboardingComplete = true, serverUrl = "http://127.0.0.1:8787/"))
        launch(services, Routes.AUTH)
        compose.onNodeWithTag("continue_demo").performScrollTo().performClick()
        waitForTag("home_screen")
        // Demo users get no invented name.
        compose.onNodeWithTag("home_greeting").assertTextContains("Good", substring = true)
        assertEquals(0, compose.onAllNodes(hasText("Demo user", substring = true)).fetchSemanticsNodes().size)
        assertEquals(true, services.settings.settings.value.account?.isDemo)
        compose.onNodeWithTag("quick_write").performClick()
        waitForTag("empty_chat")
        compose.onNodeWithTag("demo_banner").assertExists()
    }

    @Test
    fun signInValidatesInputBeforeContactingTheServer() {
        val services = InMemoryServices(AppSettings(loaded = true, onboardingComplete = true, serverUrl = "http://127.0.0.1:8787/"))
        launch(services, Routes.AUTH)
        compose.onNodeWithTag("auth_email").performTextInput("not-an-email")
        compose.onNodeWithTag("auth_submit").performScrollTo().performClick()
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
        compose.onNodeWithTag("model_label").assertTextContains("simulated", substring = true)
        compose.onNodeWithTag("message_list").performScrollToNode(hasTestTag("user_message"))
        compose.onNodeWithTag("user_message").assertExists()
        compose.onNodeWithTag("chat_title").assertTextContains("Draft a launch plan")
        compose.onNodeWithTag("send_button").assertExists()
    }

    @Test
    fun modelSelectionIncludingTheCompareWarning() {
        val services = InMemoryServices(signedInDemo, chatGatewayOverride = DemoChatGateway(chunkDelayMillis = 0))
        launch(services, Routes.CHAT)
        compose.onNodeWithTag("selected_model", useUnmergedTree = true).assertTextContains("Dash Smart")

        compose.onNodeWithTag("model_selector").performClick()
        waitForTag("provider_sheet")
        compose.onNodeWithTag("model_option_claude").performClick()
        compose.waitForIdle()
        compose.onNodeWithTag("selected_model", useUnmergedTree = true).assertTextContains("Claude")
        // The choice is remembered for new chats.
        assertEquals(com.dashworldng.ai.core.model.ModelChoice.CLAUDE, services.settings.settings.value.defaultModelChoice)

        compose.onNodeWithTag("model_selector").performClick()
        waitForTag("provider_sheet")
        compose.onNodeWithTag("model_option_compare").performClick()
        compose.waitForIdle()
        compose.onNodeWithText("Compare uses both providers").assertIsDisplayed()
        compose.onNodeWithText("two requests", substring = true).assertExists()
        compose.onNodeWithTag("confirm_compare").performClick()
        compose.waitForIdle()
        compose.onNodeWithTag("selected_model", useUnmergedTree = true).assertTextContains("Compare")

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
        compose.onNodeWithTag("mode_selector").performClick()
        waitForTag("mode_sheet")
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
        openHistoryDrawer()
        waitForTag("history_list")
        compose.onNodeWithText("Quarterly plan").assertExists()
        // Activate via the accessibility click action (as TalkBack does). Robolectric's injected taps
        // inside Material's modal drawer are unreliable; the drawer item wiring is what we verify here.
        compose.onNodeWithText("Quarterly plan").performSemanticsAction(SemanticsActions.OnClick)
        waitForTag("message_list")
        compose.onNodeWithTag("message_list").performScrollToNode(hasText("Plan Q3 please"))
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
        compose.onNodeWithTag("chat_title").assertTextContains("New chat")
    }

    @Test
    fun promptLibrarySearchAndUseFillsTheComposer() {
        val services = InMemoryServices(signedInDemo)
        launch(services, Routes.CHAT)
        openHistoryDrawer()
        compose.onNodeWithTag("drawer_prompts").performSemanticsAction(SemanticsActions.OnClick)
        waitForTag("prompt_library")
        compose.onNodeWithTag("prompt_search").performTextInput("SWOT")
        compose.waitForIdle()
        compose.onNodeWithText("SWOT analysis").assertExists()
        compose.onAllNodes(hasTestTag("use_prompt"))[0].performClick()
        waitForTag("composer_input")
        compose.onNodeWithTag("composer_input").assertTextContains("SWOT analysis", substring = true)
    }

    @Test
    fun homeGreetsTheSignedInUserByTheirOwnName() {
        val account = AccountInfo("user-1", "ngozi@example.com", "Ngozi Adeyemi", isDemo = false)
        val services = InMemoryServices(AppSettings(loaded = true, onboardingComplete = true, demoMode = false, serverUrl = "http://127.0.0.1:8787/", account = account))
        launch(services, Routes.HOME)
        compose.onNodeWithTag("home_greeting").assertTextContains("Ngozi", substring = true)
        compose.onNodeWithTag("home_empty").assertExists()
    }

    @Test
    fun aProviderFailureOffersRetryChangeProviderAndContinueLaterWithoutSwitching() {
        val services = InMemoryServices(signedInDemo.copy(demoFailure = DemoFailure.PROVIDER), chatGatewayOverride = DemoChatGateway(chunkDelayMillis = 0, failure = { DemoFailure.PROVIDER }))
        launch(services, Routes.CHAT)
        compose.onNodeWithTag("composer_input").performTextInput("Hello")
        compose.onNodeWithTag("send_button").performClick()
        waitForTag("recovery_card")
        compose.onNodeWithText("Provider temporarily unavailable").assertExists()
        compose.onNodeWithTag("recovery_retry").assertExists()
        compose.onNodeWithTag("recovery_later").assertExists()
        // Nothing switched on its own: the composer still targets the original choice.
        compose.onNodeWithTag("selected_model", useUnmergedTree = true).assertTextContains("Dash Smart")
        compose.onNodeWithTag("recovery_change_provider").performClick()
        waitForTag("alternative_sheet")
    }

    @Test
    fun toolsNeedAnAccountAndAreNeverInventedInDemoMode() {
        val services = InMemoryServices(signedInDemo)
        launch(services, Routes.TOOLS)
        compose.onNodeWithText("Connect tools to give DASH AI access to the information and actions you choose.").assertExists()
        compose.onNodeWithTag("tools_signed_out").assertExists()
        assertEquals(0, compose.onAllNodesWithTag("tool_connection").fetchSemanticsNodes().size)
    }

    @Test
    fun documentsLibraryHasAnHonestEmptyState() {
        val services = InMemoryServices(signedInDemo)
        launch(services, Routes.DOCUMENTS)
        waitForTag("documents_empty")
        compose.onNodeWithText("Add document").assertExists()
    }

    @Test
    fun appearanceCanBeSwitchedToDarkAndIsRemembered() {
        val services = InMemoryServices(signedInDemo)
        launch(services, Routes.SETTINGS)
        compose.onNodeWithTag("theme_dark").performScrollTo().performClick()
        compose.waitForIdle()
        assertEquals(com.dashworldng.ai.data.settings.ThemePreference.DARK, services.settings.settings.value.theme)
    }

    @Test
    fun securityTextNeverClaimsEndToEndEncryption() {
        val services = InMemoryServices(signedInDemo)
        launch(services, Routes.SETTINGS)
        compose.onNodeWithTag("data_protection").performScrollTo().performClick()
        waitForText("encrypted at rest")
        compose.onNodeWithText("not end-to-end encryption", substring = true).assertExists()
    }
}
