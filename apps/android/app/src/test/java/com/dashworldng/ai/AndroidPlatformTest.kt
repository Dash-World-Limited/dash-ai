package com.dashworldng.ai

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.dashworldng.ai.core.documents.UploadSource
import com.dashworldng.ai.data.settings.AccountInfo
import com.dashworldng.ai.data.settings.AppSettings
import com.dashworldng.ai.data.share.ShareIntents
import com.dashworldng.ai.di.InMemoryServices
import com.dashworldng.ai.di.IncomingShare
import com.dashworldng.ai.ui.DashAiApp
import com.dashworldng.ai.ui.Routes
import com.dashworldng.ai.ui.brand.DashBrand
import java.io.ByteArrayInputStream
import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** Android-only behaviour (intents, system Back) that the desktop UI harness cannot run. */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class AndroidPlatformTest {
    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    private val context: Context = ApplicationProvider.getApplicationContext()

    private val signedInDemo = AppSettings(
        loaded = true,
        onboardingComplete = true,
        demoMode = true,
        serverUrl = "http://127.0.0.1:8787/",
        account = AccountInfo("demo-local", null, "Demo user", isDemo = true),
    )

    private fun launch(services: InMemoryServices, start: String) {
        compose.setContent { DashAiApp(services, startDestination = start) }
        compose.waitForIdle()
    }

    private fun waitForTag(tag: String) = compose.waitUntil(5_000) { compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty() }

    private fun waitForText(text: String) = compose.waitUntil(5_000) { compose.onAllNodes(hasText(text, substring = true)).fetchSemanticsNodes().isNotEmpty() }

    // Runs here, not in the shared UI tests: sharing is Android-only, and the desktop test runtime
    // used by apps/android/jvm-ui never shows the snackbar this checks.
    @Test
    fun sharedTextAndFilesOpenANewChatReadyToEdit() {
        val services = InMemoryServices(signedInDemo)
        val notes = "Quarterly notes. Revenue grew.".toByteArray()
        launch(services, Routes.HOME)
        waitForTag("home_screen")
        // Shared from another app while DASH AI is open.
        services.shares.post(
            IncomingShare(
                text = "Summarise this for my team",
                files = listOf(UploadSource("notes.txt", "text/plain", notes.size.toLong()) { ByteArrayInputStream(notes) }),
                refused = 1,
            ),
        )
        waitForTag("composer_input")
        compose.onNodeWithTag("composer_input").assertTextContains("Summarise this for my team")
        waitForTag("attachment_chip")
        compose.onNodeWithText("notes.txt").assertExists()
        waitForText("One shared item couldn't be added.")
        assertNull(services.shares.pending.value)
        // Nothing was sent: the person decides.
        assertEquals(0, compose.onAllNodesWithTag("user_message").fetchSemanticsNodes().size)
    }

    @Test
    fun sharedTextIsAcceptedAndTrimmedToTheMessageLimit() {
        val share = assertNotNull(ShareIntents.parse(context, Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, "  Hello from another app  ")))
        assertEquals("Hello from another app", share.text)
        assertTrue(share.files.isEmpty())
        val long = assertNotNull(ShareIntents.parse(context, Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, "x".repeat(40_000))))
        assertEquals(32_000, long.text!!.length)
    }

    @Test
    fun onlyOtherAppsContentIsAccepted() {
        // Another app's content provider: accepted (read only when uploaded).
        assertTrue(ShareIntents.isSafe(context, Uri.parse("content://com.example.files/doc/1")))
        // A raw file path, or DASH AI's own storage: refused, so no app can make DASH AI upload its private files.
        assertFalse(ShareIntents.isSafe(context, Uri.parse("file:///data/data/${context.packageName}/databases/dash-ai.db")))
        assertFalse(ShareIntents.isSafe(context, Uri.parse("content://${context.packageName}.provider/x")))
        assertFalse(ShareIntents.isSafe(context, Uri.parse("content://${context.packageName}/x")))

        val unsafe = Intent(Intent.ACTION_SEND).setType("application/pdf").putExtra(Intent.EXTRA_STREAM, Uri.parse("file:///sdcard/secret.pdf"))
        val share = assertNotNull(ShareIntents.parse(context, unsafe))
        assertTrue(share.files.isEmpty())
        assertEquals(1, share.refused)
    }

    @Test
    fun otherIntentsAreIgnored() {
        assertNull(ShareIntents.parse(context, null))
        assertNull(ShareIntents.parse(context, Intent(Intent.ACTION_MAIN)))
        assertNull(ShareIntents.parse(context, Intent(Intent.ACTION_SEND).setType("text/plain")))
    }

    @Test
    fun launcherSplashAndInAppMarkShareOneDefinition() {
        // Unit tests run in the app module directory. Replacing the logo means changing all of these
        // together (docs/branding.md); this keeps them from drifting apart.
        for (name in listOf("ic_launcher_foreground", "ic_launcher_monochrome", "ic_splash_mark")) {
            val xml = File("src/main/res/drawable/$name.xml").readText()
            val paths = Regex("""android:pathData="([^"]+)"""").findAll(xml).map { it.groupValues[1] }.toList()
            assertEquals(listOf(DashBrand.MARK_PATH), paths, name)
        }
    }

    @Test
    fun systemBackClosesTheOpenHistoryDrawerBeforeLeavingHome() {
        val settings = AppSettings(
            loaded = true,
            onboardingComplete = true,
            demoMode = true,
            serverUrl = "http://127.0.0.1:8787/",
            account = AccountInfo("demo-local", null, "Demo user", isDemo = true),
        )
        compose.setContent { DashAiApp(InMemoryServices(settings), startDestination = Routes.HOME) }
        compose.waitForIdle()
        compose.onNodeWithTag("open_history").performClick()
        compose.waitUntil(5_000) {
            runCatching { compose.onNodeWithTag("history_drawer", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot.left >= 0f }.getOrDefault(false)
        }
        compose.runOnUiThread { compose.activity.onBackPressedDispatcher.onBackPressed() }
        compose.waitUntil(5_000) {
            runCatching { compose.onNodeWithTag("history_drawer", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot.right <= 0f }.getOrDefault(true)
        }
        // Still on Home: Back closed the drawer instead of leaving the app.
        assertFalse(compose.activity.isFinishing)
        assertEquals(1, compose.onAllNodesWithTag("home_screen").fetchSemanticsNodes().size)
    }
}
