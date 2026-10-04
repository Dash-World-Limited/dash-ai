package com.dashworldng.ai.core.presentation

import com.dashworldng.ai.core.model.AnswerRecovery
import com.dashworldng.ai.core.model.AssistantMode
import com.dashworldng.ai.core.model.ChatMessage
import com.dashworldng.ai.core.model.Conversation
import com.dashworldng.ai.core.model.DocumentItem
import com.dashworldng.ai.core.model.DocumentKind
import com.dashworldng.ai.core.model.DocumentStatus
import com.dashworldng.ai.core.model.MessageRole
import com.dashworldng.ai.core.model.MessageStatus
import com.dashworldng.ai.core.model.ModelChoice
import com.dashworldng.ai.core.model.ProviderId
import com.dashworldng.ai.core.model.ToolCallStatus
import com.dashworldng.ai.core.model.ToolUse
import com.dashworldng.ai.core.remote.PluginDto
import com.dashworldng.ai.core.remote.PluginScopeDto
import com.dashworldng.ai.core.remote.PluginToolDto
import com.dashworldng.ai.core.remote.PluginsResponseDto
import com.dashworldng.ai.core.stream.ApiError
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.ZoneOffset
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** UI-facing state logic: everything the screens decide that is not layout. */
class PresentationTest {
    // ---- Start, onboarding and greeting ---------------------------------------------------------

    @Test
    fun `first launch shows onboarding, then sign-in, and returning users go straight home`() {
        assertEquals(StartDestination.ONBOARDING, StartRoute.resolve(onboardingComplete = false, hasAccount = false))
        assertEquals(StartDestination.ONBOARDING, StartRoute.resolve(onboardingComplete = false, hasAccount = true))
        assertEquals(StartDestination.AUTH, StartRoute.resolve(onboardingComplete = true, hasAccount = false))
        assertEquals(StartDestination.HOME, StartRoute.resolve(onboardingComplete = true, hasAccount = true))
    }

    @Test
    fun `the greeting follows the time of day and uses the account's own first name`() {
        assertEquals("Good morning, Ada", Greeting.forHour(8, "Ada Lovelace"))
        assertEquals("Good afternoon, Chinedu", Greeting.forHour(13, "  Chinedu  "))
        assertEquals("Good evening, Ngozi", Greeting.forHour(19, "Ngozi"))
        assertEquals("Hello, Ngozi", Greeting.forHour(2, "Ngozi"))
        // No name, or the app's placeholder names: no name is invented.
        assertEquals("Good morning", Greeting.forHour(9, null))
        assertEquals("Good morning", Greeting.forHour(9, "   "))
        assertEquals("Good morning", Greeting.forHour(9, "Demo user"))
        assertEquals("AL", Greeting.initials("Ada Lovelace", "ada@example.com"))
        assertEquals("N", Greeting.initials("Ngozi", null))
        assertEquals("JD", Greeting.initials(null, "john.doe@example.com"))
        assertNull(Greeting.initials("Demo user", null))
    }

    @Test
    fun `quick actions start chats in real modes and only More tools opens tools`() {
        assertEquals(AssistantMode.WRITING, QuickAction.WRITE.mode)
        assertEquals(AssistantMode.DOCUMENTS, QuickAction.ANALYSE_FILE.mode)
        assertTrue(QuickAction.ANALYSE_FILE.asksForFile)
        assertEquals(AssistantMode.RESEARCH, QuickAction.RESEARCH.mode)
        assertEquals(listOf(QuickAction.MORE_TOOLS), QuickAction.entries.filter { it.opensTools })
    }

    // ---- History ---------------------------------------------------------------------------------

    private fun conversation(id: String, at: LocalDateTime) =
        Conversation(id, id, AssistantMode.GENERAL, 0, at.toInstant(ZoneOffset.UTC).toEpochMilli())

    @Test
    fun `history is grouped by calendar day of last activity and empty sections are omitted`() {
        val now = LocalDateTime.of(2026, 3, 10, 9, 0)
        val zone = ZoneId.of("UTC")
        val list = listOf(
            conversation("today", now.minusHours(1)),
            conversation("just-after-midnight", LocalDateTime.of(2026, 3, 10, 0, 1)),
            conversation("yesterday-late", LocalDateTime.of(2026, 3, 9, 23, 59)),
            conversation("three-days", now.minusDays(3)),
            conversation("seven-days", now.minusDays(7)),
            conversation("old", now.minusDays(30)),
        )
        val groups = HistoryGrouping.group(list, now.toInstant(ZoneOffset.UTC).toEpochMilli(), zone)
        assertEquals(HistorySection.entries.toList(), groups.map { it.section })
        assertEquals(listOf("today", "just-after-midnight"), groups[0].conversations.map { it.id })
        assertEquals(listOf("yesterday-late"), groups[1].conversations.map { it.id })
        assertEquals(listOf("three-days", "seven-days"), groups[2].conversations.map { it.id })
        assertEquals(listOf("old"), groups[3].conversations.map { it.id })

        assertTrue(HistoryGrouping.group(emptyList(), 0, zone).isEmpty())
        assertEquals(listOf(HistorySection.OLDER), HistoryGrouping.group(listOf(list.last()), now.toInstant(ZoneOffset.UTC).toEpochMilli(), zone).map { it.section })
    }

    // ---- Providers -------------------------------------------------------------------------------

    @Test
    fun `the provider sheet lists only real choices and explains unavailable ones`() {
        val onlyOpenAi = ProviderAvailability(configured = setOf(ProviderId.OPENAI), models = mapOf(ProviderId.OPENAI to "gpt-x"))
        val options = ProviderOptions.build(onlyOpenAi, ModelChoice.SMART, demoMode = false)
        assertEquals(ModelChoice.entries.toList(), options.map { it.choice })
        assertEquals(listOf(true, true, false, false), options.map { it.available })
        assertEquals("Not configured on this server.", options[2].unavailableReason)
        assertEquals("Needs both OpenAI and Claude on this server.", options[3].unavailableReason)
        assertEquals("gpt-x", options[1].model)
        assertTrue(options[0].selected)
        assertTrue(options[0].description.startsWith("Automatic"))

        val demo = ProviderOptions.build(ProviderAvailability(configured = emptySet()), ModelChoice.CLAUDE, demoMode = true)
        assertTrue(demo.all { it.available && it.model == null && it.description.endsWith("Simulated in Demo Mode.") })
    }

    @Test
    fun `switching provider is refused while an answer streams or when the provider is not configured`() {
        val both = ProviderAvailability()
        assertTrue(ProviderOptions.canSwitch(ModelChoice.CLAUDE, both, demoMode = false, generating = false))
        assertFalse(ProviderOptions.canSwitch(ModelChoice.CLAUDE, both, demoMode = false, generating = true))
        assertFalse(ProviderOptions.canSwitch(ModelChoice.CLAUDE, ProviderAvailability(configured = setOf(ProviderId.OPENAI)), demoMode = false, generating = false))
    }

    private fun failed(retryable: Boolean, provider: ProviderId = ProviderId.OPENAI, compare: String? = null) = ChatMessage(
        id = "a", conversationId = "c", role = MessageRole.ASSISTANT, content = "", createdAt = 1,
        status = MessageStatus.FAILED, provider = provider, errorMessage = "OpenAI is temporarily unavailable.",
        errorRetryable = retryable, compareGroupId = compare,
    )

    @Test
    fun `provider failure offers retry, an explicit change of provider and continue later`() {
        val card = assertNotNull(Recovery.card(failed(true), AnswerRecovery(3, listOf(ProviderId.ANTHROPIC)), ProviderId.entries.toSet(), online = true))
        assertEquals("Provider temporarily unavailable", card.title)
        assertEquals("OpenAI is temporarily unavailable.", card.message)
        assertEquals("DASH AI tried 3 times before stopping.", card.attemptsNote)
        assertEquals(listOf(RecoveryAction.RETRY, RecoveryAction.CHANGE_PROVIDER, RecoveryAction.CONTINUE_LATER), card.actions)
        assertEquals(listOf(ProviderId.ANTHROPIC), card.alternatives)
    }

    @Test
    fun `recovery only offers providers the server named and has configured`() {
        val noAlternatives = assertNotNull(Recovery.card(failed(true), AnswerRecovery(1, emptyList()), ProviderId.entries.toSet(), online = true))
        assertEquals(listOf(RecoveryAction.RETRY, RecoveryAction.CONTINUE_LATER), noAlternatives.actions)
        val notConfigured = assertNotNull(Recovery.card(failed(true), AnswerRecovery(1, listOf(ProviderId.ANTHROPIC)), setOf(ProviderId.OPENAI), online = true))
        assertTrue(notConfigured.alternatives.isEmpty())
        // Reopened from history (no metadata): the other configured provider, never the same one.
        val reopened = assertNotNull(Recovery.card(failed(false), null, ProviderId.entries.toSet(), online = true))
        assertEquals("This answer couldn't be completed", reopened.title)
        assertEquals(listOf(ProviderId.ANTHROPIC), reopened.alternatives)
        assertEquals(listOf(RecoveryAction.CHANGE_PROVIDER, RecoveryAction.CONTINUE_LATER), reopened.actions)
        // Compare answers are retried together, never switched.
        assertTrue(assertNotNull(Recovery.card(failed(true, compare = "g"), AnswerRecovery(1, listOf(ProviderId.ANTHROPIC)), ProviderId.entries.toSet(), true)).alternatives.isEmpty())
        // Offline: nothing that sends a request.
        assertEquals(listOf(RecoveryAction.CONTINUE_LATER), assertNotNull(Recovery.card(failed(true), AnswerRecovery(1, listOf(ProviderId.ANTHROPIC)), ProviderId.entries.toSet(), online = false)).actions)
        // Only failed answers get a card.
        assertNull(Recovery.card(failed(true).copy(status = MessageStatus.COMPLETE), null, ProviderId.entries.toSet(), true))
    }

    // ---- Sync ------------------------------------------------------------------------------------

    @Test
    fun `sync status is synced, syncing, offline or an issue, and never invents a last sync time`() {
        var now = 1_000L
        val tracker = SyncTracker { now }
        assertEquals(SyncStatusKind.LOCAL_ONLY, SyncStatuses.derive(tracker.snapshot.value, null, online = true).kind)
        val waiting = SyncStatuses.derive(tracker.snapshot.value, "u1", online = true)
        assertEquals(SyncStatusKind.WAITING, waiting.kind)
        assertNull(waiting.lastSyncAt)

        tracker.started("u1")
        assertEquals(SyncStatusKind.SYNCING, SyncStatuses.derive(tracker.snapshot.value, "u1", true).kind)
        now = 5_000L
        tracker.succeeded("u1")
        val synced = SyncStatuses.derive(tracker.snapshot.value, "u1", true)
        assertEquals(SyncStatusKind.SYNCED, synced.kind)
        assertEquals(5_000L, synced.lastSyncAt)

        assertEquals(SyncStatusKind.OFFLINE, SyncStatuses.derive(tracker.snapshot.value, "u1", online = false).kind)

        tracker.started("u1")
        tracker.failed("u1", SyncStatuses.messageFor(ApiError.network()))
        val issue = SyncStatuses.derive(tracker.snapshot.value, "u1", true)
        assertEquals(SyncStatusKind.ISSUE, issue.kind)
        assertEquals(5_000L, issue.lastSyncAt) // the last real success is kept
        assertTrue(issue.detail.startsWith("The server couldn't be reached."))
    }

    @Test
    fun `sync status never shows another account's state after a switch or sign-out`() {
        val tracker = SyncTracker { 42L }
        tracker.started("u1")
        tracker.succeeded("u1")
        // Another account signed in: nothing of u1 is shown.
        assertEquals(SyncStatusKind.WAITING, SyncStatuses.derive(tracker.snapshot.value, "u2", true).kind)
        tracker.started("u2")
        assertNull(tracker.snapshot.value.lastSuccessAt)
        // Late results for the previous account are ignored.
        tracker.succeeded("u1")
        assertNull(tracker.snapshot.value.lastSuccessAt)
        tracker.reset()
        assertEquals(SyncSnapshot(), tracker.snapshot.value)
    }

    // ---- Documents -------------------------------------------------------------------------------

    private fun doc(name: String, kind: DocumentKind, status: DocumentStatus, remote: String? = "r", demo: Boolean = false) =
        DocumentItem(name, remote, name, kind, "x", 2048, status, "detail", createdAt = 0, isDemo = demo)

    @Test
    fun `document statuses are Ready, Processing, Unsupported or Failed and never claim analysis`() {
        assertEquals("Ready", Documents.status(doc("a", DocumentKind.PDF, DocumentStatus.READY)).text)
        assertEquals("Processing", Documents.status(doc("a", DocumentKind.PDF, DocumentStatus.UPLOADING)).text)
        assertEquals(StatusTone.WARNING, Documents.status(doc("a", DocumentKind.IMAGE, DocumentStatus.UNSUPPORTED)).tone)
        assertEquals("Failed", Documents.status(doc("a", DocumentKind.TXT, DocumentStatus.FAILED)).text)
        assertEquals("Demo · not uploaded", Documents.status(doc("a", DocumentKind.TXT, DocumentStatus.DEMO, demo = true)).text)
        val all = DocumentStatus.entries.map { Documents.status(doc("a", DocumentKind.PDF, it)).text }
        assertTrue(all.none { it.contains("nalys") })
    }

    @Test
    fun `unsupported documents cannot be asked about, and demo documents only in Demo Mode`() {
        assertTrue(Documents.usableInChat(doc("a", DocumentKind.PDF, DocumentStatus.READY), demoMode = false))
        assertFalse(Documents.usableInChat(doc("a", DocumentKind.IMAGE, DocumentStatus.UNSUPPORTED), demoMode = false))
        assertFalse(Documents.usableInChat(doc("a", DocumentKind.PDF, DocumentStatus.READY, remote = null), demoMode = false))
        assertFalse(Documents.usableInChat(doc("a", DocumentKind.TXT, DocumentStatus.DEMO, remote = null, demo = true), demoMode = false))
        assertTrue(Documents.usableInChat(doc("a", DocumentKind.TXT, DocumentStatus.DEMO, remote = null, demo = true), demoMode = true))
    }

    @Test
    fun `document filters only offer kinds that exist and search matches names`() {
        val docs = listOf(doc("Q3 report.pdf", DocumentKind.PDF, DocumentStatus.READY), doc("notes.txt", DocumentKind.TXT, DocumentStatus.READY))
        assertEquals(listOf(DocumentFilter.ALL, DocumentFilter.PDF, DocumentFilter.TEXT), Documents.filtersFor(docs))
        assertTrue(Documents.filtersFor(docs.take(1)).isEmpty())
        assertEquals(listOf("notes.txt"), Documents.filter(docs, DocumentFilter.TEXT, "").map { it.name })
        assertEquals(listOf("Q3 report.pdf"), Documents.filter(docs, DocumentFilter.ALL, "report").map { it.name })
        assertEquals("2 KB", Documents.formatSize(2048))
        assertEquals("1.5 MB", Documents.formatSize(1_572_864))
        assertEquals(listOf("Summarise this document", "What are the key risks?", "Extract the major points"), Documents.SUGGESTIONS)
    }

    // ---- Auth ------------------------------------------------------------------------------------

    @Test
    fun `auth failures distinguish offline, wrong credentials, existing accounts, rate limits and expired sessions`() {
        assertEquals(AuthFailureKind.OFFLINE, AuthFailures.from(ApiError.network()).kind)
        assertEquals(AuthFailureKind.OFFLINE, AuthFailures.from(ApiError("internal_error", "x", true), online = false).kind)
        val wrong = AuthFailures.from(ApiError("unauthorized", "Email or password is incorrect.", false))
        assertEquals(AuthFailureKind.INVALID_CREDENTIALS, wrong.kind)
        assertEquals("Email or password is incorrect.", wrong.message)
        assertFalse(wrong.canRetry)
        assertEquals(AuthFailureKind.ACCOUNT_EXISTS, AuthFailures.from(ApiError("conflict", "An account with this email already exists. Sign in instead.", false)).kind)
        assertEquals(AuthFailureKind.RATE_LIMITED, AuthFailures.from(ApiError("rate_limited", "Wait.", true)).kind)
        assertEquals(AuthFailureKind.SESSION_EXPIRED, AuthFailures.from(ApiError("unauthorized", "Your session has expired. Sign in again.", false)).kind)
        val server = AuthFailures.from(ApiError("internal_error", "boom", true))
        assertEquals(AuthFailureKind.SERVER, server.kind)
        assertTrue(server.canRetry)
    }

    // ---- Tools -----------------------------------------------------------------------------------

    private fun plugin(enabled: Boolean, granted: List<String>, executable: Boolean = true) = PluginDto(
        id = "dash-demo", name = "Dash demo tools", description = "d", version = "1", kind = "builtin",
        scopes = listOf(PluginScopeDto("demo:read", "Read the clock", "read")),
        tools = listOf(PluginToolDto("current_time", "dash-demo__current_time", "Time", "demo:read", "read", executable)),
        enabled = enabled, grantedScopes = granted,
    )

    @Test
    fun `tool connection states follow the registry and the user's choices`() {
        assertEquals(ConnectionState.AVAILABLE, ToolConnections.from(plugin(false, emptyList()), toolsEnabled = true).state)
        assertEquals(ConnectionState.CONNECTED, ToolConnections.from(plugin(true, listOf("demo:read")), toolsEnabled = true).state)
        val needs = ToolConnections.from(plugin(true, emptyList()), toolsEnabled = true)
        assertEquals(ConnectionState.REQUIRES_PERMISSION, needs.state)
        assertEquals(listOf("demo:read"), needs.scopesToGrant)
        val off = ToolConnections.from(plugin(true, listOf("demo:read")), toolsEnabled = false)
        assertEquals(ConnectionState.DISABLED, off.state)
        assertFalse(off.canToggle)
        assertEquals(ConnectionState.DISABLED, ToolConnections.from(plugin(false, emptyList(), executable = false), true).state)
        assertEquals(listOf("Current time"), ToolConnections.from(plugin(false, emptyList()), true).tools.map { it.label })
        assertTrue(ToolConnections.from(PluginsResponseDto(true, emptyList())).isEmpty())
    }

    @Test
    fun `tool activity labels name the tool and outcome without arguments or results`() {
        val names = mapOf("dash-demo" to "Dash demo tools")
        assertEquals("Using Text stats", ToolLabels.label(ToolUse("1", "dash-demo", "text_stats"), names).title)
        val ok = ToolLabels.label(ToolUse("1", "dash-demo", "text_stats", ToolCallStatus.OK, 3), names)
        assertEquals("Used Text stats", ok.title)
        assertEquals("Dash demo tools · finished in 3 ms", ok.detail)
        assertEquals("Text stats not permitted", ToolLabels.label(ToolUse("1", "dash-demo", "text_stats", ToolCallStatus.DENIED), names).title)
        assertEquals("Couldn't use Text stats", ToolLabels.label(ToolUse("1", "x", "text_stats", ToolCallStatus.INVALID_ARGUMENTS)).title)
        assertEquals("X", ToolLabels.pluginLabel("x", emptyMap()))
        assertEquals("Used 2 tools", ToolLabels.summary(listOf(ToolUse("1", "p", "a", ToolCallStatus.OK), ToolUse("2", "p", "b", ToolCallStatus.OK))))
        assertEquals("Using tools…", ToolLabels.summary(listOf(ToolUse("1", "p", "a"))))
    }
}
