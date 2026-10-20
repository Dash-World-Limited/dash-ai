package com.dashworldng.ai

import androidx.compose.ui.test.ComposeTimeoutException
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isRoot
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.printToString
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.dashworldng.ai.core.auth.AuthService
import com.dashworldng.ai.core.model.AssistantMode
import com.dashworldng.ai.core.model.ChatMessage
import com.dashworldng.ai.core.model.Conversation
import com.dashworldng.ai.core.model.MessageRole
import com.dashworldng.ai.core.remote.DashApiClient
import com.dashworldng.ai.data.settings.AccountInfo
import com.dashworldng.ai.data.settings.AppSettings
import com.dashworldng.ai.di.AccountTransitions
import com.dashworldng.ai.di.InMemoryServices
import com.dashworldng.ai.ui.DashAiApp
import com.dashworldng.ai.ui.Routes
import kotlinx.coroutines.runBlocking
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * A DASH AI server that knows two accounts. Requests never leave the process: an OkHttp interceptor
 * answers them, so the real AuthService, DashApiClient and AuthScreen are exercised.
 */
private class FakeAuthServer {
    val calls = mutableListOf<String>()
    private val users = mapOf(
        "ada@example.com" to ("user-ada" to "Ada Obi"),
        "bayo@example.com" to ("user-bayo" to "Bayo Musa"),
    )

    val auth = AuthService {
        DashApiClient(
            "http://127.0.0.1:8787/",
            tokenProvider = { null },
            baseClient = OkHttpClient.Builder().addInterceptor { chain ->
                val request = chain.request()
                val path = request.url.encodedPath
                calls += path
                val sent = Buffer().also { request.body?.writeTo(it) }.readUtf8()
                val (code, body) = when (path) {
                    "/v1/auth/login" -> {
                        val email = Regex("\"email\":\"([^\"]+)\"").find(sent)!!.groupValues[1]
                        val (id, name) = users.getValue(email)
                        200 to """{"token":"token-$id","expiresAt":"2026-12-01T00:00:00Z","user":{"id":"$id","email":"$email","displayName":"$name","createdAt":"2026-10-01T00:00:00Z"}}"""
                    }
                    "/v1/auth/logout" -> 204 to ""
                    else -> 404 to """{"error":{"code":"not_found","message":"Not found.","retryable":false}}"""
                }
                Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(code).message("x")
                    .body(body.toResponseBody("application/json".toMediaType())).build()
            }.build(),
        )
    }
}

@RunWith(AndroidJUnit4::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class AccountTransitionTest {
    @get:Rule
    val compose = createComposeRule()

    private val ada = AccountInfo("user-ada", "ada@example.com", "Ada Obi", isDemo = false)

    /**
     * Ada is signed in and has turned Demo Mode on (Settings), so Tools and Automates ask her to sign
     * in. Her synced chat and an unsynced local one are on the phone.
     */
    private fun adaInDemoMode(server: FakeAuthServer): InMemoryServices {
        val services = InMemoryServices(
            AppSettings(loaded = true, onboardingComplete = true, demoMode = true, serverUrl = "http://127.0.0.1:8787/", account = ada),
            authOverride = server.auth,
        )
        runBlocking {
            services.accountGuard.onSignedIn("user-ada")
            services.tokens.set("token-user-ada")
            seedChat(services, "c-ada", "Ada private plan")
        }
        return services
    }

    private suspend fun seedChat(services: InMemoryServices, id: String, text: String) {
        services.conversations.upsertConversation(Conversation(id, "Title $id", AssistantMode.GENERAL, 1, 1))
        services.conversations.upsertMessage(ChatMessage("m-$id", id, MessageRole.USER, text, 2))
    }

    private fun texts(services: InMemoryServices): List<String> = runBlocking {
        services.conversations.allConversations().flatMap { c -> services.conversations.getMessages(c.id).map { it.content } }
    }

    private fun launch(services: InMemoryServices, start: String) {
        compose.setContent { DashAiApp(services, startDestination = start) }
        compose.waitForIdle()
    }

    private fun waitForTag(tag: String) {
        try {
            compose.waitUntil(timeoutMillis = 5_000) { compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty() }
        } catch (e: ComposeTimeoutException) {
            val tree = runCatching { compose.onAllNodes(isRoot(), useUnmergedTree = true).printToString(maxDepth = 40) }.getOrDefault("<unavailable>")
            throw AssertionError("Timed out waiting for tag '$tag'. Semantics tree:\n$tree", e)
        }
    }

    /** Tapping "Sign in" opens the normal sign-in screen and changes nothing about the account yet. */
    private fun tapSignInOn(signedOutTag: String, services: InMemoryServices) {
        waitForTag(signedOutTag)
        compose.onNode(hasText("Sign in") and hasClickAction() and hasAnyAncestor(hasTestTag(signedOutTag))).performScrollTo().performClick()
        waitForTag("auth_screen")
        val s = services.settings.settings.value
        assertEquals(ada, s.account, "the account is not dropped by asking to sign in")
        assertTrue(s.demoMode)
        assertEquals("token-user-ada", services.tokens.get())
        assertEquals(listOf("Ada private plan"), texts(services))
    }

    private fun signInAs(email: String) {
        compose.onNodeWithTag("auth_email").performTextInput(email)
        compose.onNodeWithTag("auth_password").performTextInput("correct horse battery")
        compose.onNodeWithTag("auth_submit").performScrollTo().performClick()
        waitForTag("home_screen")
    }

    @Test
    fun signingInFromToolsAsTheSameAccountKeepsItsDataAndLeavesDemoMode() {
        val server = FakeAuthServer()
        val services = adaInDemoMode(server)
        launch(services, Routes.TOOLS)
        tapSignInOn("tools_signed_out", services)
        signInAs("ada@example.com")
        val s = services.settings.settings.value
        assertEquals(ada, s.account)
        assertEquals(false, s.demoMode)
        assertEquals("token-user-ada", services.tokens.get())
        assertEquals(listOf("Ada private plan"), texts(services), "same account: local data is kept")
    }

    @Test
    fun signingInFromAutomatesAsAnotherAccountRemovesThePreviousAccountsData() {
        val server = FakeAuthServer()
        val services = adaInDemoMode(server)
        launch(services, Routes.AUTOMATES)
        tapSignInOn("automates_signed_out", services)
        signInAs("bayo@example.com")
        val s = services.settings.settings.value
        assertEquals("user-bayo", s.account?.userId)
        assertEquals(false, s.demoMode)
        assertEquals("token-user-bayo", services.tokens.get())
        assertEquals(emptyList(), texts(services), "another account: the previous account's data is removed first")
    }

    @Test
    fun signingInFromAutomatesAsTheSameAccountKeepsItsData() {
        val server = FakeAuthServer()
        val services = adaInDemoMode(server)
        launch(services, Routes.AUTOMATES)
        tapSignInOn("automates_signed_out", services)
        signInAs("ada@example.com")
        assertEquals(ada, services.settings.settings.value.account)
        assertEquals(listOf("Ada private plan"), texts(services))
    }

    @Test
    fun signingInFromToolsAsAnotherAccountRemovesThePreviousAccountsData() {
        val server = FakeAuthServer()
        val services = adaInDemoMode(server)
        launch(services, Routes.TOOLS)
        tapSignInOn("tools_signed_out", services)
        signInAs("bayo@example.com")
        assertEquals("user-bayo", services.settings.settings.value.account?.userId)
        assertEquals(emptyList(), texts(services))
    }

    @Test
    fun continuingInDemoModeFromToolsNeverShowsTheAccountsDataAsADemo() {
        val server = FakeAuthServer()
        val services = adaInDemoMode(server)
        launch(services, Routes.TOOLS)
        tapSignInOn("tools_signed_out", services)
        compose.onNodeWithTag("continue_demo").performScrollTo().performClick()
        waitForTag("home_screen")
        // Ada's data is still shown only as Ada's: the demo profile was not put over it.
        val s = services.settings.settings.value
        assertEquals(ada, s.account)
        assertTrue(s.demoMode)
        assertEquals(listOf("Ada private plan"), texts(services))
    }

    /** What the old Tools/Automates "Sign in" left behind: no account, but the data still Ada's. */
    @Test
    fun continuingInDemoModeWithNoAccountRemovesDataAnAccountStillOwns() {
        val server = FakeAuthServer()
        val services = adaInDemoMode(server)
        runBlocking { services.settings.update { it.copy(account = null, demoMode = true) } }
        launch(services, Routes.AUTH)
        compose.onNodeWithTag("continue_demo").performScrollTo().performClick()
        waitForTag("home_screen")
        assertEquals(AccountTransitions.DEMO_PROFILE, services.settings.settings.value.account)
        assertEquals(emptyList(), texts(services), "Ada's chats are not shown as a demo")
        assertNull(services.tokens.get(), "the session Ada left on the phone is removed too")
        assertTrue("/v1/auth/logout" in server.calls, "and ended on the server (best effort)")
        assertTrue(runBlocking { !services.accountGuard.isOwner("user-ada") })
    }

    @Test
    fun startUpRemovesAccountDataLeftUnderTheDemoProfile() = runBlocking<Unit> {
        val server = FakeAuthServer()
        val services = adaInDemoMode(server)
        services.settings.update { it.copy(account = AccountTransitions.DEMO_PROFILE, demoMode = true) }
        services.accounts.repairAtStart()
        assertEquals(emptyList(), texts(services))
        assertNull(services.tokens.get())
    }

    @Test
    fun demoModesOwnChatsStayWhenNoAccountOwnsTheData() = runBlocking<Unit> {
        val services = InMemoryServices(AppSettings(loaded = true, onboardingComplete = true, serverUrl = "http://127.0.0.1:8787/", account = AccountTransitions.DEMO_PROFILE))
        services.conversations.upsertConversation(Conversation("demo-1", "Demo chat", AssistantMode.GENERAL, 1, 1, isDemo = true))
        services.accounts.repairAtStart()
        services.accounts.continueInDemo()
        assertEquals(listOf("demo-1"), services.conversations.allConversations().map { it.id })
    }
}
