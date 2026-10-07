package com.dashworldng.ai

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.ComposeTimeoutException
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isRoot
import androidx.compose.ui.test.printToString
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onNodeWithContentDescription
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
import com.dashworldng.ai.core.remote.AppNotificationDto
import com.dashworldng.ai.core.remote.AutomationDetailDto
import com.dashworldng.ai.core.remote.AutomationDto
import com.dashworldng.ai.core.remote.AutomationRunDto
import com.dashworldng.ai.core.remote.AutomationRunSummaryDto
import com.dashworldng.ai.core.remote.AutomationScheduleDto
import com.dashworldng.ai.core.remote.CreateAutomationRequestDto
import com.dashworldng.ai.core.remote.NotificationListDto
import com.dashworldng.ai.core.remote.UpdateAutomationRequestDto
import com.dashworldng.ai.core.stream.ChatStreamEvent
import com.dashworldng.ai.core.stream.StreamTarget
import com.dashworldng.ai.data.settings.AccountInfo
import com.dashworldng.ai.data.settings.AppSettings
import com.dashworldng.ai.di.InMemoryServices
import com.dashworldng.ai.di.IncomingShare
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
private class HangingGateway(demo: Boolean = true) : ChatGateway {
    override val isDemo: Boolean = demo
    val cancelled = mutableListOf<String>()

    override fun stream(request: ChatRequest): Flow<ChatStreamEvent> = flow {
        emit(ChatStreamEvent.Started("stream-1", request.conversationId, null, listOf(StreamTarget("answer-1", demo = isDemo)), "test"))
        emit(ChatStreamEvent.Delta("answer-1", "Partial answer"))
        awaitCancellation()
    }

    override suspend fun cancel(streamId: String) {
        cancelled += streamId
    }
}

/** A server-side Automates stand-in: one automation with a ready result. */
internal class FakeAutomations : com.dashworldng.ai.core.automations.AutomationsApi {
    private val ts = java.time.Instant.now().minusSeconds(3600).toString()
    private fun summary(id: String, status: String, trigger: String = "schedule") = AutomationRunSummaryDto(
        id = id, automationId = "auto-0001", status = status, trigger = trigger, createdAt = ts, startedAt = ts,
        finishedAt = if (status == "ready") ts else null, editedAt = null, error = null, demo = false,
        preview = if (status == "ready") "1. Finish the quarterly report" else "",
    )
    var content = "1. Finish the quarterly report\n2. Call the bank"
    val runs = mutableListOf(summary("run-00000001", "ready"))
    var status = "active"
    val created = mutableListOf<CreateAutomationRequestDto>()
    val calls = mutableListOf<String>()

    fun automation() = AutomationDto(
        id = "auto-0001", name = "Morning brief", prompt = "Draft three priorities for my day.", mode = "general",
        schedule = AutomationScheduleDto("weekly", "08:00", days = listOf(1, 2, 3, 4, 5)), timeZone = "Africa/Lagos",
        status = status, state = if (status == "paused") "paused" else if (runs.first().status == "queued") "running" else "ready",
        nextRunAt = if (status == "paused") null else java.time.Instant.now().plusSeconds(86_400).toString(),
        lastRun = runs.first(), createdAt = ts, updatedAt = ts,
    )

    private fun full(r: AutomationRunSummaryDto) = AutomationRunDto(
        r.id, r.automationId, r.status, r.trigger, r.createdAt, r.startedAt, r.finishedAt, r.editedAt, r.error, r.demo, r.preview,
        if (r.status == "ready") content else "",
    )

    override suspend fun list() = listOf(automation())
    override suspend fun create(body: CreateAutomationRequestDto): AutomationDto {
        created += body
        return automation()
    }
    override suspend fun detail(id: String) = AutomationDetailDto(automation(), runs.toList())
    override suspend fun update(id: String, body: UpdateAutomationRequestDto) = automation()
    override suspend fun delete(id: String) { calls += "delete" }
    override suspend fun pause(id: String): AutomationDto { status = "paused"; calls += "pause"; return automation() }
    override suspend fun resume(id: String): AutomationDto { status = "active"; calls += "resume"; return automation() }
    override suspend fun runNow(id: String): AutomationRunDto {
        calls += "run"
        runs.add(0, summary("run-00000002", "queued", "manual"))
        return full(runs.first())
    }
    override suspend fun run(id: String, runId: String) = full(runs.first { it.id == runId })
    override suspend fun editRun(id: String, runId: String, content: String): AutomationRunDto {
        this.content = content
        calls += "edit"
        return full(runs.first { it.id == runId })
    }
    override suspend fun regenerate(id: String, runId: String): AutomationRunDto {
        calls += "regenerate"
        runs.add(0, summary("run-00000003", "queued", "regenerate"))
        return full(runs.first())
    }
    override suspend fun notifications() = NotificationListDto(
        listOf(AppNotificationDto("note-00000001", "automation.ready", "Morning brief is ready", "1. Finish the quarterly report", "auto-0001", "run-00000001", ts, null)),
        unread = if ("read" in calls) 0 else 1,
    )
    override suspend fun markRead(ids: List<String>?) { calls += "read" }
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

    /**
     * Every text and accessibility description on screen: DASH AI is the product, so no provider or
     * model name, provider choice or Compare may appear. The privacy disclosure ("third-party
     * artificial-intelligence service providers") is allowed by design.
     */
    private fun assertNoProviderWording(where: String) {
        val words = Regex("(?i)\\b(openai|chatgpt|gpt[-\\s]?\\d|anthropic|claude|gemini|dash smart)\\b|\\b(ai|change|another|other|default) providers?\\b|\\bcompare (mode|answers|providers)\\b")
        val texts = compose.onAllNodes(isRoot(), useUnmergedTree = true).fetchSemanticsNodes().flatMap { root ->
            fun collect(node: androidx.compose.ui.semantics.SemanticsNode): List<String> =
                node.config.getOrElseNullable(SemanticsProperties.Text) { null }.orEmpty().map { it.text } +
                    node.config.getOrElseNullable(SemanticsProperties.ContentDescription) { null }.orEmpty() +
                    node.children.flatMap(::collect)
            collect(root)
        }
        val hit = texts.firstOrNull { words.containsMatchIn(it) }
        assertEquals(null, hit, "provider wording on $where")
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
        // Demo users get no invented name: the greeting is the time-of-day salutation alone.
        val greeting = compose.onNodeWithTag("home_greeting").fetchSemanticsNode().config[SemanticsProperties.Text].joinToString("") { it.text }
        assertTrue(greeting in setOf("Good morning", "Good afternoon", "Good evening", "Hello"), "greeting was '$greeting'")
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
        compose.onNodeWithTag("model_label").assertTextContains("Demo · DASH AI (simulated)", substring = true)
        compose.onNodeWithTag("message_list").performScrollToNode(hasTestTag("user_message"))
        compose.onNodeWithTag("user_message").assertExists()
        compose.onNodeWithTag("chat_title").assertTextContains("Draft a launch plan")
        compose.onNodeWithTag("send_button").assertExists()
    }

    @Test
    fun chatSpeaksOnlyAsDashAiWithNoProviderChoiceOrCompare() {
        val services = InMemoryServices(signedInDemo, chatGatewayOverride = DemoChatGateway(chunkDelayMillis = 0))
        launch(services, Routes.CHAT)
        assertEquals(0, compose.onAllNodesWithTag("model_selector").fetchSemanticsNodes().size)
        compose.onNodeWithTag("recipient_label").assertTextContains("Demo Mode", substring = true)
        compose.onNodeWithTag("composer_input").performTextInput("Plan a calm week")
        compose.onNodeWithTag("send_button").performClick()
        waitForText("Demo response · simulated by DASH AI")
        compose.onNodeWithTag("model_label").assertTextContains("DASH AI", substring = true)
        assertEquals(0, compose.onAllNodesWithTag("compare_row").fetchSemanticsNodes().size)
        assertNoProviderWording("chat")
        compose.onNodeWithTag("mode_selector").performClick()
        waitForTag("mode_sheet")
        assertNoProviderWording("mode sheet")
    }

    @Test
    fun settingsHaveNoProviderSelectorAndNameNoProvider() {
        val services = InMemoryServices(signedInDemo)
        launch(services, Routes.SETTINGS)
        compose.onNodeWithText("Chat defaults").assertExists()
        assertEquals(0, compose.onAllNodes(hasTestTag("default_smart")).fetchSemanticsNodes().size)
        assertEquals(0, compose.onAllNodes(hasTestTag("default_openai")).fetchSemanticsNodes().size)
        assertEquals(0, compose.onAllNodes(hasTestTag("default_claude")).fetchSemanticsNodes().size)
        assertNoProviderWording("settings")
    }

    @Test
    fun accountAndHomeNameNoProvider() {
        val services = InMemoryServices(signedInDemo)
        launch(services, Routes.ACCOUNT)
        compose.onNodeWithTag("account_screen").assertExists()
        assertNoProviderWording("account")
    }

    @Test
    fun switchingModeChangesSuggestionsAndShowsResearchLimits() {
        val services = InMemoryServices(signedInDemo)
        launch(services, Routes.CHAT)
        compose.onNodeWithTag("mode_selector").performClick()
        waitForTag("mode_sheet")
        compose.onNodeWithTag("mode_research").performSemanticsAction(SemanticsActions.OnClick)
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
                ChatMessage("m2", "conv-1", MessageRole.ASSISTANT, "## Q3 plan\n- Grow revenue", 1_001, isDemo = true),
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
    fun aShareWaitsUntilOnboardingAndSignInAreDone() {
        val services = InMemoryServices()
        services.shares.post(IncomingShare(text = "Shared before signing in"))
        launch(services, Routes.ONBOARDING)
        waitForTag("onboarding")
        compose.waitForIdle()
        assertEquals("Shared before signing in", services.shares.pending.value?.text)
        assertEquals(0, compose.onAllNodesWithTag("composer_input").fetchSemanticsNodes().size)
    }

    @Test
    fun losingTheConnectionEndsAStreamingAnswerWithRetryInsteadOfHanging() {
        val gateway = HangingGateway(demo = false)
        val live = signedInDemo.copy(demoMode = false, account = AccountInfo("user-1", "ada@example.com", "Ada", isDemo = false))
        val services = InMemoryServices(live, chatGatewayOverride = gateway)
        launch(services, Routes.CHAT)
        compose.onNodeWithTag("composer_input").performTextInput("Write a long story")
        compose.onNodeWithTag("send_button").performClick()
        waitForTag("stop_button")
        waitForText("Partial answer")

        services.fixedConnectivity.state.value = false
        waitForTag("send_button")
        waitForText("connection was lost")
        compose.onNodeWithText("Partial answer").assertExists()
        assertEquals(emptyList<String>(), gateway.cancelled) // the server cannot be reached
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
    fun aFailedAnswerOffersRetryAndContinueLaterInDashAisWords() {
        val services = InMemoryServices(signedInDemo.copy(demoFailure = DemoFailure.SERVICE), chatGatewayOverride = DemoChatGateway(chunkDelayMillis = 0, failure = { DemoFailure.SERVICE }))
        launch(services, Routes.CHAT)
        compose.onNodeWithTag("composer_input").performTextInput("Hello")
        compose.onNodeWithTag("send_button").performClick()
        waitForTag("recovery_card")
        compose.onNodeWithText("DASH AI couldn't complete that response").assertExists()
        compose.onNodeWithTag("recovery_retry").assertExists()
        compose.onNodeWithTag("recovery_later").assertExists()
        assertEquals(0, compose.onAllNodesWithTag("recovery_change_provider").fetchSemanticsNodes().size)
        assertNoProviderWording("recovery")
        compose.onNodeWithTag("recovery_later").performSemanticsAction(SemanticsActions.OnClick)
        compose.waitForIdle()
        assertEquals(0, compose.onAllNodesWithTag("recovery_card").fetchSemanticsNodes().size)
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

    private val signedInAccount = AppSettings(
        loaded = true, onboardingComplete = true, demoMode = false, serverUrl = "http://127.0.0.1:8787/",
        account = AccountInfo("user-0001", "chidi@example.com", "Chidi Okafor", isDemo = false),
    )

    private fun assertBadge(tag: String, text: String) {
        compose.onNode(hasTestTag(tag) and hasAnyDescendant(hasText(text)), useUnmergedTree = true).assertExists()
    }

    @Test
    fun automatesNeedAnAccountAndAreNeverInventedInDemoMode() {
        val services = InMemoryServices(signedInDemo, automationsOverride = FakeAutomations())
        launch(services, Routes.AUTOMATES)
        compose.onNodeWithTag("automates_signed_out").assertExists()
        assertEquals(0, compose.onAllNodesWithTag("automation_card").fetchSemanticsNodes().size)
    }

    @Test
    fun automatesShowStateScheduleAndNewResults() {
        val api = FakeAutomations()
        val services = InMemoryServices(signedInAccount, automationsOverride = api)
        launch(services, Routes.AUTOMATES)
        waitForTag("automation_card")
        compose.onNodeWithText("Weekdays at 08:00").assertExists()
        assertBadge("automation_state", "Ready")
        compose.onNodeWithTag("automates_notices").assertExists()
        compose.onNodeWithText("Morning brief is ready").assertExists()
        assertEquals(1, services.notices.unread.value)
        assertNoProviderWording("Automates")
    }

    @Test
    fun anAutomationCanBeRunPausedAndResumed() {
        val api = FakeAutomations()
        val services = InMemoryServices(signedInAccount, automationsOverride = api)
        launch(services, Routes.automation("auto-0001"))
        waitForTag("automation_run_now")
        compose.onNodeWithTag("automation_next_run").assertTextContains("Next run: Tomorrow", substring = true)
        compose.onNodeWithTag("automation_last_run").assertTextContains("Last run:", substring = true)
        compose.onNodeWithTag("automation_pause").performScrollTo().performClick()
        waitForTag("automation_resume")
        assertBadge("automation_detail_state", "Paused")
        compose.onNodeWithTag("automation_resume").performClick()
        waitForTag("automation_pause")
        compose.onNodeWithTag("automation_run_now").performClick()
        waitForText("Running…")
        assertEquals(listOf("pause", "resume", "run"), api.calls)
        assertNoProviderWording("an automation")
    }

    @Test
    fun aResultCanBeEditedAndRegenerated() {
        val api = FakeAutomations()
        val services = InMemoryServices(signedInAccount, automationsOverride = api)
        launch(services, Routes.automationRun("auto-0001", "run-00000001"))
        waitForTag("result_edit")
        compose.onNodeWithText("Call the bank", substring = true).assertExists()
        listOf("result_copy", "result_download", "result_share", "result_regenerate").forEach { compose.onNodeWithTag(it).assertExists() }
        // Opening the result reads its notice.
        await("the notice to be read") { "read" in api.calls }
        compose.onNodeWithTag("result_edit").performClick()
        compose.onNodeWithTag("automation_result_editor").performTextInput("Edited: ")
        compose.onNodeWithTag("automation_result_save").performClick()
        waitForTag("result_edit")
        assertTrue(api.content.startsWith("Edited: "))
        compose.onNodeWithTag("result_regenerate").performClick()
        // Back on the automation, the new run shows as Running.
        waitForTag("automation_detail")
        waitForText("Running…")
        assertTrue("regenerate" in api.calls)
    }

    @Test
    fun theEditorCreatesAScheduleInTheChosenZone() {
        val api = FakeAutomations()
        val services = InMemoryServices(signedInAccount, automationsOverride = api)
        launch(services, Routes.AUTOMATION_NEW)
        waitForTag("automation_editor")
        compose.onNodeWithTag("automation_save").performScrollTo().performClick()
        waitForText("Give the automation a name.")
        compose.onNodeWithTag("automation_name").performTextInput("Weekly report")
        compose.onNodeWithTag("automation_prompt").performTextInput("Summarise my week.")
        compose.onNodeWithTag("automation_day_5").performScrollTo().performClick()
        compose.onNodeWithTag("automation_zone").performScrollTo().performClick()
        compose.onNodeWithTag("zone_search").performTextInput("Lagos")
        compose.onNodeWithText("Africa/Lagos").performScrollTo().performClick()
        compose.onNodeWithTag("automation_save").performScrollTo().performClick()
        await("the automation to be created") { api.created.isNotEmpty() }
        val body = api.created.single()
        assertEquals("Weekly report", body.name)
        assertEquals(AutomationScheduleDto("weekly", "08:00", days = listOf(1, 2, 3, 4)), body.schedule)
        assertEquals("Africa/Lagos", body.timeZone)
        // Saved: the automation opens.
        waitForTag("automation_detail")
    }

    @Test
    fun theMenuShowsNewAutomatesResults() {
        val services = InMemoryServices(signedInDemo)
        launch(services, Routes.CHAT)
        // The count is refreshed from the server while signed in; here it is set directly.
        services.notices.set(2)
        openHistoryDrawer()
        compose.onNodeWithTag("drawer_automates").assertExists()
        compose.onNodeWithContentDescription("2 new", useUnmergedTree = true).assertExists()
    }
}
