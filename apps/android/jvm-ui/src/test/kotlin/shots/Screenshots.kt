package shots

import androidx.compose.runtime.Composable
import androidx.compose.ui.ImageComposeScene
import androidx.compose.ui.unit.Density
import com.dashworldng.ai.core.chat.ChatItems
import com.dashworldng.ai.core.chat.ChatSessionState
import com.dashworldng.ai.core.model.*
import com.dashworldng.ai.core.presentation.*
import com.dashworldng.ai.core.remote.*
import com.dashworldng.ai.data.settings.AccountInfo
import com.dashworldng.ai.data.settings.ThemePreference
import com.dashworldng.ai.ui.auth.AuthContent
import com.dashworldng.ai.ui.auth.AuthUiState
import com.dashworldng.ai.ui.chat.*
import com.dashworldng.ai.ui.documents.*
import com.dashworldng.ai.ui.home.*
import com.dashworldng.ai.ui.onboarding.OnboardingScreen
import com.dashworldng.ai.ui.onboarding.SplashContent
import com.dashworldng.ai.ui.theme.DashAiTheme
import com.dashworldng.ai.ui.tools.ToolsContent
import com.dashworldng.ai.ui.tools.ToolsUiState
import org.jetbrains.skia.EncodedImageFormat
import java.io.File
import kotlin.test.Test

/** Renders real app composables with the desktop Skia renderer (not an Android device). */
class Screenshots {
    private val out = File(System.getProperty("shots.dir", "build/shots")).apply { mkdirs() }
    private val density = Density(2.625f)
    private val w = (411 * 2.625f).toInt()
    private val h = (891 * 2.625f).toInt()

    private fun shot(name: String, theme: ThemePreference = ThemePreference.LIGHT, frames: Int = 30, content: @Composable () -> Unit) {
        val scene = ImageComposeScene(w, h, density) { DashAiTheme(theme) { content() } }
        var t = 0L
        repeat(frames) { scene.render(t); t += 50_000_000L }
        val img = scene.render(t)
        File(out, "$name.png").writeBytes(img.encodeToData(EncodedImageFormat.PNG)!!.bytes)
        scene.close()
    }

    private val now = System.currentTimeMillis()
    private val day = 86_400_000L
    private val conversations = listOf(
        Conversation("c1", "Launch plan for the Lagos pop-up", AssistantMode.BUSINESS, now - 3_600_000, now - 3_600_000),
        Conversation("c2", "Rewrite the investor update", AssistantMode.WRITING, now - day, now - day),
        Conversation("c3", "Summary of the lease agreement", AssistantMode.DOCUMENTS, now - 3 * day, now - 3 * day),
        Conversation("c4", "EV market overview", AssistantMode.RESEARCH, now - 20 * day, now - 20 * day),
    )
    private val drawer = DrawerCallbacks({}, {}, {}, { _, _ -> }, {}, {})
    private val account = AccountInfo("u1", "ngozi@example.com", "Ngozi Adeyemi", isDemo = false)

    private fun chatEvents() = ChatEvents({}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, { _, _ -> }, {}, {})

    private fun chatState(failed: Boolean = false, demo: Boolean = false): ChatUiState {
        val user = ChatMessage("u", "c1", MessageRole.USER, "Draft a 90-day launch plan for a premium coffee pop-up in Lagos.", now - 60_000)
        val answer = ChatMessage(
            "a", "c1", MessageRole.ASSISTANT,
            if (failed) "" else "## 90-day launch plan\n\n**Goal:** open with a waiting list of 500 people.\n\n1. **Weeks 1–4: Foundations** — confirm the venue, permits and suppliers.\n2. **Weeks 5–8: Build demand** — tasting events and partnerships.\n3. **Weeks 9–12: Launch** — soft opening, then the public launch.\n\n| Week | Focus | Owner |\n| --- | --- | --- |\n| 1–4 | Venue & suppliers | Ops |\n| 5–8 | Community | Marketing |\n\n`Budget: ₦4.2m`",
            now - 50_000,
            status = if (failed) MessageStatus.FAILED else MessageStatus.COMPLETE,
            isDemo = demo,
            replyToId = "u", errorMessage = if (failed) "DASH AI couldn't complete that response. Please try again." else null, errorRetryable = failed,
        )
        val session = ChatSessionState(
            conversation = conversations[0],
            messages = listOf(user, answer),
            toolUses = if (failed) emptyMap() else mapOf("a" to listOf(ToolUse("c", "dash-demo", "current_time", ToolCallStatus.OK, 4))),
            recovery = if (failed) mapOf("a" to AnswerRecovery(3)) else emptyMap(),
        )
        return ChatUiState(
            session = session, items = ChatItems.build(session.messages), demoMode = demo,
            mode = AssistantMode.BUSINESS, conversations = conversations, account = account, pluginNames = mapOf("dash-demo" to "Dash demo tools"),
        )
    }

    private val docs = listOf(
        DocumentItem("d1", "r1", "Lease agreement 2026.pdf", DocumentKind.PDF, "application/pdf", 482_000, DocumentStatus.READY, "Text extracted from 12 pages.", 31_204, 12, now - day, false),
        DocumentItem("d2", "r2", "Q3 board notes.docx", DocumentKind.DOCX, "application/docx", 58_000, DocumentStatus.READY, "Text extracted.", 8_120, null, now - 2 * day, false),
        DocumentItem("d3", "r3", "Shop front.jpg", DocumentKind.IMAGE, "image/jpeg", 1_900_000, DocumentStatus.UNSUPPORTED, "Images are stored but their contents can't be read yet.", 0, null, now - 4 * day, false),
        DocumentItem("d4", "r4", "Scanned invoice.pdf", DocumentKind.PDF, "application/pdf", 640_000, DocumentStatus.FAILED, "This PDF is password-protected. Upload a copy without a password.", 0, null, now - 5 * day, false),
    )

    @Test fun render() {
        shot("01-splash", frames = 12) { SplashContent(reducedMotion = false) {} }
        shot("02-onboarding") { OnboardingScreen {} }
        shot("03-auth") { AuthContent(AuthUiState(), true, "https://api.dashworld.example/", {}, {}, {}, {}, {}, {}, {}, {}) }
        shot("04-auth-error") {
            AuthContent(AuthUiState(email = "ngozi@example.com", failure = AuthFailures.from(com.dashworldng.ai.core.stream.ApiError("unauthorized", "Email or password is incorrect.", false))), true, "https://api.dashworld.example/", {}, {}, {}, {}, {}, {}, {}, {})
        }
        val home = HomeUiState(account, false, true, conversations, conversations, "", 9)
        shot("05-home") { HomeContent(home, drawer, HomeEvents({}, {}, {}, {})) }
        shot("06-home-dark", ThemePreference.DARK) { HomeContent(home, drawer, HomeEvents({}, {}, {}, {})) }
        shot("07-home-empty-demo") { HomeContent(HomeUiState(AccountInfo("demo-local", null, "Demo user", true), true, true, emptyList(), emptyList(), "", 15), drawer, HomeEvents({}, {}, {}, {})) }
        shot("08-new-chat") { ChatContent(ChatUiState(account = account, mode = AssistantMode.GENERAL, demoMode = false), chatEvents(), drawer, true) }
        shot("09-conversation") { ChatContent(chatState(), chatEvents(), drawer, true) }
        shot("10-conversation-dark", ThemePreference.DARK) { ChatContent(chatState(), chatEvents(), drawer, true) }
        shot("11-recovery") { ChatContent(chatState(failed = true), chatEvents(), drawer, true) }
        shot("12-mode-sheet") {
            ChatContent(chatState(), chatEvents(), drawer, true)
            ModeSheet(AssistantMode.BUSINESS, {}, {}, {})
        }
        shot("13-documents") { DocumentsContent(DocumentsUiState(true, docs, emptyList(), false), {}, {}, {}, {}, {}) }
        shot("14-document-detail") { DocumentDetailContent(true, docs[0], false, {}, {}, {}) }
        shot("15-document-unsupported") { DocumentDetailContent(true, docs[3], false, {}, {}, {}) }
        val plugins = PluginsResponseDto(true, listOf(
            PluginDto("dash-demo", "Dash demo tools", "Harmless built-in tools that show how tool calling works: the current time and text statistics.", "1.0.0", "builtin",
                listOf(PluginScopeDto("demo:read", "Read the server clock and measure text you provide.", "read")),
                listOf(PluginToolDto("current_time", "dash-demo__current_time", "Returns the current date and time.", "demo:read", "read", true), PluginToolDto("text_stats", "dash-demo__text_stats", "Counts characters, words and lines.", "demo:read", "read", true)),
                true, listOf("demo:read")),
        ))
        shot("16-tools") { ToolsContent(ToolsUiState(signedIn = true, connections = ToolConnections.from(plugins)), {}, {}, { _, _ -> }, {}) }
        shot("17-tools-demo") { ToolsContent(ToolsUiState(signedIn = false), {}, {}, { _, _ -> }, {}) }
        shot("18-drawer") {
            androidx.compose.material3.ModalNavigationDrawer(
                drawerState = androidx.compose.material3.rememberDrawerState(androidx.compose.material3.DrawerValue.Open),
                drawerContent = { AppDrawer(conversations, "", "c1", drawer) {} },
            ) { HomeContent(home, drawer, HomeEvents({}, {}, {}, {})) }
        }
        shot("19-documents-empty") { DocumentsContent(DocumentsUiState(true, emptyList(), emptyList(), true), {}, {}, {}, {}, {}) }
    }
}
