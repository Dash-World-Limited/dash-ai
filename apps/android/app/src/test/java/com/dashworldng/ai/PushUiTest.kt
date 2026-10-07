package com.dashworldng.ai

import androidx.compose.ui.test.ComposeTimeoutException
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isRoot
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.printToString
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.dashworldng.ai.core.push.FixedNotificationPermission
import com.dashworldng.ai.core.push.FixedPushTokenSource
import com.dashworldng.ai.core.push.PushApi
import com.dashworldng.ai.core.push.PushDestination
import com.dashworldng.ai.core.push.PushText
import com.dashworldng.ai.core.push.RecordingPushNotifier
import com.dashworldng.ai.core.push.accountTag
import com.dashworldng.ai.core.remote.PushDeviceDto
import com.dashworldng.ai.core.remote.PushPreferencesDto
import com.dashworldng.ai.data.settings.AccountInfo
import com.dashworldng.ai.data.settings.AppSettings
import com.dashworldng.ai.di.InMemoryServices
import com.dashworldng.ai.ui.DashAiApp
import com.dashworldng.ai.ui.Routes
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** The server's push endpoints, recorded. */
private class FakePushApi(var prefs: PushPreferencesDto = PushPreferencesDto(automates = true, available = true)) : PushApi {
    val registered = mutableListOf<String>()
    var unregistered = 0
    val updates = mutableListOf<Boolean>()

    override suspend fun register(token: String, appVersion: String?): PushDeviceDto {
        registered += token
        return PushDeviceDto("dev-00000001", "android", appVersion, current = true, createdAt = "2026-10-07T00:00:00.000Z", updatedAt = "2026-10-07T00:00:00.000Z")
    }

    override suspend fun unregister() {
        unregistered++
    }

    override suspend fun preferences() = prefs

    override suspend fun setAutomates(on: Boolean): PushPreferencesDto {
        updates += on
        prefs = prefs.copy(automates = on)
        return prefs
    }
}

/** Automates notifications on Android: the offer, the setting, receiving pushes and opening them. */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class PushUiTest {
    @get:Rule
    val compose = createComposeRule()

    private val signedIn = AppSettings(
        loaded = true, onboardingComplete = true, demoMode = false, serverUrl = "http://127.0.0.1:8787/",
        account = AccountInfo("user-0001", "chidi@example.com", "Chidi Okafor", isDemo = false),
    )
    private val demo = AppSettings(
        loaded = true, onboardingComplete = true, demoMode = true, serverUrl = "http://127.0.0.1:8787/",
        account = AccountInfo("demo-local", null, "Demo user", isDemo = true),
    )

    private fun services(
        settings: AppSettings = signedIn,
        permission: FixedNotificationPermission = FixedNotificationPermission(granted = false),
        push: FakePushApi = FakePushApi(),
        automations: FakeAutomations = FakeAutomations(),
        deviceToken: String? = null,
        notifier: RecordingPushNotifier = RecordingPushNotifier(),
    ) = InMemoryServices(
        settings,
        automationsOverride = automations,
        pushApiOverride = push,
        permission = permission,
        pushTokens = FixedPushTokenSource(deviceToken),
        notifier = notifier,
    ).also { if (settings.signedInReal()) it.tokens.set("session-token") }

    private fun AppSettings.signedInReal() = !demoMode && account?.isDemo == false

    private fun launch(services: InMemoryServices, start: String) {
        compose.setContent { DashAiApp(services, startDestination = start) }
        compose.waitForIdle()
    }

    private fun await(what: String, condition: () -> Boolean) {
        try {
            compose.waitUntil(timeoutMillis = 5_000, condition = condition)
        } catch (e: ComposeTimeoutException) {
            val tree = runCatching { compose.onAllNodes(isRoot(), useUnmergedTree = true).printToString(maxDepth = 40) }.getOrDefault("<unavailable>")
            throw AssertionError("Timed out waiting for $what. Semantics tree:\n$tree", e)
        }
    }

    private fun has(tag: String) = compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty()
    private fun waitForTag(tag: String) = await("tag '$tag'") { has(tag) }
    private fun waitForText(text: String) = await("text '$text'") {
        compose.onAllNodes(hasText(text, substring = true)).fetchSemanticsNodes().isNotEmpty()
    }

    private fun payload(type: String = "automation.ready", userId: String = "user-0001", id: String = "note-00000001") = mapOf(
        "v" to "1", "type" to type, "notificationId" to id, "automationId" to "auto-0001", "runId" to "run-00000001",
        "account" to accountTag(userId), "title" to "DASH AI", "body" to "Your scheduled result is ready.",
        "createdAt" to "2026-10-07T08:00:00.000Z",
    )

    @Test
    fun noPromptAtLaunchAndTheOfferCanBeDeclinedWithoutLosingAutomates() {
        val permission = FixedNotificationPermission(granted = false)
        val services = services(permission = permission)
        launch(services, Routes.HOME)
        compose.waitForIdle()
        assertFalse(has("notification_offer"), "no notification ask outside Automates")

        launch(services, Routes.AUTOMATES)
        waitForTag("notification_offer")
        waitForText("Know when results are ready")
        compose.onNodeWithTag("notification_offer_later").performClick()
        await("the offer to be answered") { runBlocking { services.settings.settings.first() }.notificationPromptAnswered }
        await("the offer to close") { !has("notification_offer") }
        // Declined: Automates keep working.
        waitForTag("automation_card")
        assertEquals(0, permission.settingsOpened)
    }

    @Test
    fun turningOnOpensAppSettingsWhenAndroidCannotPrompt() {
        val permission = FixedNotificationPermission(granted = false, canPrompt = false)
        val services = services(permission = permission)
        launch(services, Routes.AUTOMATES)
        waitForTag("notification_offer_on")
        compose.onNodeWithTag("notification_offer_on").performClick()
        await("app notification settings to open") { permission.settingsOpened == 1 }
        await("the offer to close") { !has("notification_offer") }
    }

    @Test
    fun noOfferWhenNotificationsAreAllowedOrSignedOut() {
        launch(services(permission = FixedNotificationPermission(granted = true)), Routes.AUTOMATES)
        waitForTag("automation_card")
        assertFalse(has("notification_offer"))
    }

    @Test
    fun theSettingTurnsAutomatesNotificationsOffAndShowsThePhoneState() {
        val push = FakePushApi()
        val permission = FixedNotificationPermission(granted = false)
        launch(services(permission = permission, push = push), Routes.SETTINGS)
        waitForTag("automates_notifications_switch")
        compose.onNodeWithTag("automates_notifications_switch").performScrollTo()
        await("the setting to load") { runCatching { compose.onNodeWithTag("automates_notifications_switch").assertIsEnabled() }.isSuccess }
        // The phone's real state: notifications are off for DASH AI here.
        waitForText("turned off for DASH AI on this phone")
        compose.onNodeWithTag("allow_notifications").assertExists()

        compose.onNodeWithTag("automates_notifications_switch").performClick()
        await("the choice to be saved") { push.updates == listOf(false) }
        waitForText("Off. Automations still run")
    }

    @Test
    fun aRealAccountRegistersThisPhoneOnlyWhenNotificationsAreAllowed() {
        val push = FakePushApi()
        val permission = FixedNotificationPermission(granted = false)
        val services = services(permission = permission, push = push, deviceToken = "fcm-device-token-0001")
        launch(services, Routes.HOME)
        compose.waitForIdle()
        assertEquals(emptyList(), push.registered)
        permission.set(true)
        await("this phone to be registered") { push.registered == listOf("fcm-device-token-0001") }
        // Notifications turned off on the phone: pushes to it stop.
        permission.set(false)
        await("this phone to be unregistered") { push.unregistered == 1 }
    }

    @Test
    fun demoModeNeverRegisters() {
        val push = FakePushApi()
        launch(services(settings = demo, permission = FixedNotificationPermission(true), push = push, deviceToken = "fcm-device-token-0001"), Routes.HOME)
        compose.waitForIdle()
        assertEquals(emptyList(), push.registered)
    }

    @Test
    fun aTappedResultOpensTheResultOnColdStart() {
        val automations = FakeAutomations()
        val services = services(automations = automations)
        // Posted before the first frame, as when the app is started from the notification.
        services.pushOpens.post(PushDestination.Result("auto-0001", "run-00000001", "note-00000001"))
        launch(services, Routes.HOME)
        waitForTag("result_edit")
        await("the notice to be read") { "read" in automations.calls }
        assertNull(services.pushOpens.pending.value)
    }

    @Test
    fun aTappedFailureOpensTheAutomationWhileTheAppIsOpen() {
        val services = services()
        launch(services, Routes.CHAT)
        compose.waitForIdle()
        services.pushOpens.post(PushDestination.Automation("auto-0001", "note-00000002"))
        waitForTag("automation_detail")
    }

    @Test
    fun aTappedNotificationIsIgnoredWhenSignedOut() {
        val services = services(settings = demo)
        services.pushOpens.post(PushDestination.Result("auto-0001", "run-00000001", "note-00000001"))
        launch(services, Routes.HOME)
        await("the open to be consumed") { services.pushOpens.pending.value == null }
        compose.waitForIdle()
        assertFalse(has("result_edit"))
        assertFalse(has("automation_detail"))
    }

    @Test
    fun receivedPushesAreShownOnceAndOnlyForThisAccount() = runBlocking<Unit> {
        val notifier = RecordingPushNotifier()
        val permission = FixedNotificationPermission(granted = true)
        val services = services(permission = permission, notifier = notifier)

        assertTrue(services.receivePush(payload()))
        assertEquals(1, notifier.shown.size)
        // Lock-screen words are fixed by type, never taken from the payload.
        assertEquals("note-00000001", notifier.shown.single().notificationId)
        assertEquals("Your scheduled result is ready.", PushText.body(notifier.shown.single().type))
        // The same notification again (a retry or a duplicate delivery): not shown twice.
        assertFalse(services.receivePush(payload()))
        // Meant for another account that used this phone.
        assertFalse(services.receivePush(payload(userId = "user-0002", id = "note-00000003")))
        // Malformed.
        assertFalse(services.receivePush(payload(id = "x")))
        // Notifications off on the phone: nothing shown, nothing crashes.
        permission.set(false)
        assertFalse(services.receivePush(payload(type = "automation.failed", id = "note-00000004")))
        assertEquals(1, notifier.shown.size)
    }

    @Test
    fun signedOutPhonesShowNothingAndSigningOutClearsNotifications() = runBlocking<Unit> {
        val notifier = RecordingPushNotifier()
        val push = FakePushApi()
        val services = services(permission = FixedNotificationPermission(granted = true), notifier = notifier, push = push, deviceToken = "fcm-device-token-0001")
        services.push.sync("user-0001", notificationsAllowed = true)
        assertEquals(listOf("fcm-device-token-0001"), push.registered)
        assertTrue(services.receivePush(payload()))
        services.pushOpens.post(PushDestination.Result("auto-0001", "run-00000001", "note-00000001"))

        services.accountGuard.signOut { }
        assertEquals(0, notifier.shown.size)
        assertEquals(1, push.unregistered)
        assertNull(services.pushOpens.pending.value)
        assertNull(services.tokens.get())
        // After sign-out, a late push for the previous account is dropped.
        assertFalse(services.receivePush(payload(id = "note-00000005")))
    }
}
