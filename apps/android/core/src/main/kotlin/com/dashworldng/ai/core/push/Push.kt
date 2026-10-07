package com.dashworldng.ai.core.push

import com.dashworldng.ai.core.remote.DashApiClient
import com.dashworldng.ai.core.remote.PushDeviceDto
import com.dashworldng.ai.core.remote.PushPreferencesDto
import com.dashworldng.ai.core.remote.RegisterPushDeviceRequestDto
import com.dashworldng.ai.core.remote.UpdatePushPreferencesRequestDto
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.getAndUpdate
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import java.security.MessageDigest

/*
 * DASH Automates push notifications on the device (docs/push-notifications.md). Everything here is
 * platform-free so it is tested on the JVM; the Android parts (Firebase, NotificationManager, the
 * permission prompt) live in the app module behind the interfaces below.
 */

/** The Automates events a push can announce (the server's NotificationKind). */
enum class PushEventType(val wire: String) {
    RESULT_READY("automation.ready"),
    FAILED("automation.failed");

    companion object {
        fun fromWire(value: String?): PushEventType? = entries.firstOrNull { it.wire == value }
    }
}

/** A validated push. Only ids and the event type are trusted from the payload. */
data class PushMessage(
    val notificationId: String,
    val type: PushEventType,
    val automationId: String,
    val runId: String,
    /** Short hash of the recipient account (see [accountTag]). */
    val account: String,
)

/** The words shown on the lock screen: fixed by event type, never taken from the payload. */
object PushText {
    const val TITLE = "DASH AI"

    fun body(type: PushEventType): String = when (type) {
        PushEventType.RESULT_READY -> "Your scheduled result is ready."
        PushEventType.FAILED -> "A scheduled task needs your attention."
    }

    /** Android notification channel (Settings → Apps → DASH AI → Notifications). */
    const val CHANNEL_ID = "automates"
    const val CHANNEL_NAME = "Automates"
    const val CHANNEL_DESCRIPTION = "When a scheduled task's result is ready or it needs your attention."
}

private val ID = Regex("^[A-Za-z0-9_-]{8,64}$")
private val TAG = Regex("^[a-f0-9]{16}$")

/** The same one-way account tag the server puts in each push. */
fun accountTag(userId: String): String =
    MessageDigest.getInstance("SHA-256").digest("dash-ai:push-account:$userId".toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it) }
        .take(16)

object PushPayloads {
    /** Parses FCM data. Anything malformed, from an unknown version or of an unknown type is rejected. */
    fun parse(data: Map<String, String>): PushMessage? {
        if (data["v"] != "1") return null
        val type = PushEventType.fromWire(data["type"]) ?: return null
        val notificationId = data["notificationId"]?.takeIf(ID::matches) ?: return null
        val automationId = data["automationId"]?.takeIf(ID::matches) ?: return null
        val runId = data["runId"]?.takeIf(ID::matches) ?: return null
        val account = data["account"]?.takeIf(TAG::matches) ?: return null
        return PushMessage(notificationId, type, automationId, runId, account)
    }
}

/** Where tapping a push goes. The screen still loads everything through the owner-checked API. */
sealed interface PushDestination {
    val automationId: String

    /** A ready result: the result screen. */
    data class Result(override val automationId: String, val runId: String, val notificationId: String? = null) : PushDestination

    /** A failed run: the automation's status screen (last run, its reason, Run now). */
    data class Automation(override val automationId: String, val notificationId: String? = null) : PushDestination

    companion object {
        fun of(message: PushMessage): PushDestination = when (message.type) {
            PushEventType.RESULT_READY -> Result(message.automationId, message.runId, message.notificationId)
            PushEventType.FAILED -> Automation(message.automationId, message.notificationId)
        }
    }
}

/**
 * The extras a notification's tap intent carries. Read back defensively: the activity is exported (it
 * is the launcher), so any app could send it these extras. They are only ids; a crafted id opens a
 * screen that shows "not found" unless the signed-in account owns it (the server checks).
 */
object PushLink {
    const val EXTRA_TYPE = "com.dashworldng.ai.push.type"
    const val EXTRA_AUTOMATION = "com.dashworldng.ai.push.automationId"
    const val EXTRA_RUN = "com.dashworldng.ai.push.runId"
    const val EXTRA_NOTIFICATION = "com.dashworldng.ai.push.notificationId"

    fun extras(message: PushMessage): Map<String, String> = mapOf(
        EXTRA_TYPE to message.type.wire,
        EXTRA_AUTOMATION to message.automationId,
        EXTRA_RUN to message.runId,
        EXTRA_NOTIFICATION to message.notificationId,
    )

    fun parse(get: (String) -> String?): PushDestination? {
        val type = PushEventType.fromWire(get(EXTRA_TYPE)) ?: return null
        val automationId = get(EXTRA_AUTOMATION)?.takeIf(ID::matches) ?: return null
        val notificationId = get(EXTRA_NOTIFICATION)?.takeIf(ID::matches)
        return when (type) {
            PushEventType.RESULT_READY -> PushDestination.Result(automationId, get(EXTRA_RUN)?.takeIf(ID::matches) ?: return null, notificationId)
            PushEventType.FAILED -> PushDestination.Automation(automationId, notificationId)
        }
    }
}

/** Remembers which notification ids were already shown, so a repeated push is never shown twice. */
interface SeenPushStore {
    /** True the first time an id is seen; false for every repeat. */
    fun markIfNew(notificationId: String): Boolean
    fun clear()
}

class InMemorySeenPushStore(private val capacity: Int = 200) : SeenPushStore {
    private val seen = LinkedHashSet<String>()

    @Synchronized
    override fun markIfNew(notificationId: String): Boolean {
        if (!seen.add(notificationId)) return false
        while (seen.size > capacity) seen.remove(seen.first())
        return true
    }

    @Synchronized
    override fun clear() = seen.clear()
}

sealed interface PushDecision {
    data class Show(val message: PushMessage) : PushDecision
    data class Drop(val reason: String) : PushDecision
}

/**
 * Decides whether an incoming push is shown. Dropped: malformed or unknown pushes, pushes while signed
 * out or in Demo Mode, pushes for another account (the phone switched accounts while one was in
 * flight), pushes while notifications are off, and repeats of one already shown.
 */
class PushGate(private val seen: SeenPushStore) {
    fun decide(data: Map<String, String>, signedInUserId: String?, notificationsAllowed: Boolean): PushDecision {
        val message = PushPayloads.parse(data) ?: return PushDecision.Drop("malformed")
        if (signedInUserId == null) return PushDecision.Drop("signed_out")
        if (message.account != accountTag(signedInUserId)) return PushDecision.Drop("other_account")
        if (!notificationsAllowed) return PushDecision.Drop("not_allowed")
        if (!seen.markIfNew(message.notificationId)) return PushDecision.Drop("duplicate")
        return PushDecision.Show(message)
    }
}

/** Holds a tapped notification's destination until the app can open it (after splash and sign-in). */
class PushOpenInbox {
    private val state = MutableStateFlow<PushDestination?>(null)
    val pending: StateFlow<PushDestination?> = state.asStateFlow()

    fun post(destination: PushDestination) {
        state.value = destination
    }

    fun consume(): PushDestination? = state.getAndUpdate { null }

    fun clear() {
        state.value = null
    }
}

/** The device's push token (FCM on Android). [available] is false when push is not built in. */
interface PushTokenSource {
    val available: Boolean
    suspend fun token(): String?

    /** Invalidates the token on this device; a new one is issued later. */
    suspend fun deleteToken()
}

/** Whether DASH AI may show notifications on this device (Android 13+ asks; older versions allow by default). */
interface NotificationPermissionState {
    val granted: StateFlow<Boolean>

    /** True when the system can show a permission prompt (Android 13+); otherwise only Settings can change it. */
    val canPrompt: Boolean

    /** Re-reads the system state (after a prompt, or when the app returns from Settings). */
    fun refresh()

    /** Opens this app's notification settings. */
    fun openSystemSettings()
}

class FixedNotificationPermission(granted: Boolean = true, override val canPrompt: Boolean = true) : NotificationPermissionState {
    private val state = MutableStateFlow(granted)
    override val granted: StateFlow<Boolean> = state.asStateFlow()
    var settingsOpened = 0
        private set

    fun set(value: Boolean) {
        state.value = value
    }

    override fun refresh() = Unit

    override fun openSystemSettings() {
        settingsOpened += 1
    }
}

/** Push registration and preferences on the server (/v1/push). */
interface PushApi {
    suspend fun register(token: String, appVersion: String?): PushDeviceDto
    suspend fun unregister()
    suspend fun preferences(): PushPreferencesDto
    suspend fun setAutomates(on: Boolean): PushPreferencesDto
}

class RemotePushApi(private val client: () -> DashApiClient) : PushApi {
    override suspend fun register(token: String, appVersion: String?): PushDeviceDto =
        client().call { registerPushDevice(RegisterPushDeviceRequestDto(token = token, appVersion = appVersion)) }.device

    override suspend fun unregister() = client().callNoContent { unregisterPushDevice() }

    override suspend fun preferences(): PushPreferencesDto = client().call { pushPreferences() }

    override suspend fun setAutomates(on: Boolean): PushPreferencesDto = client().call { updatePushPreferences(UpdatePushPreferencesRequestDto(on)) }
}

/** What this device last registered: the account and a hash of the token (never the token itself). */
data class PushRegistrationState(val userId: String? = null, val tokenHash: String? = null)

interface PushStateStore {
    fun load(): PushRegistrationState
    fun save(state: PushRegistrationState)
}

class InMemoryPushStateStore(private var state: PushRegistrationState = PushRegistrationState()) : PushStateStore {
    override fun load() = state
    override fun save(state: PushRegistrationState) {
        this.state = state
    }
}

enum class PushSyncOutcome { REGISTERED, UNCHANGED, UNREGISTERED, NOT_REGISTERED, UNAVAILABLE, FAILED }

/**
 * Keeps this device's server registration in line with the app: registered while a real account is
 * signed in and notifications are allowed, not registered otherwise. The server ties the registration
 * to the session, so signing out ends it there too; [signedOut] also discards the device's token, so a
 * registration the server somehow kept can never reach this phone again.
 */
class PushRegistrar(
    private val api: () -> PushApi?,
    private val tokens: PushTokenSource,
    private val state: PushStateStore,
    private val appVersion: String?,
    private val timeoutMs: Long = 10_000,
    /** Each sign-out step waits at most this long (the server also ends the registration with the session). */
    private val signOutTimeoutMs: Long = 3_000,
) {
    private val mutex = Mutex()

    /** [userId] is the signed-in real account (null when signed out or in Demo Mode). */
    suspend fun sync(userId: String?, notificationsAllowed: Boolean, token: String? = null, force: Boolean = false): PushSyncOutcome = mutex.withLock {
        val current = state.load()
        if (userId == null || !notificationsAllowed || !tokens.available) {
            if (current.userId == null) return@withLock if (tokens.available) PushSyncOutcome.NOT_REGISTERED else PushSyncOutcome.UNAVAILABLE
            // Notifications turned off on this phone: stop pushes to it (best effort; signing out also ends it).
            if (userId != null) quietly { api()?.unregister() }
            state.save(PushRegistrationState())
            return@withLock PushSyncOutcome.UNREGISTERED
        }
        val value = token ?: quietly { tokens.token() } ?: return@withLock PushSyncOutcome.FAILED
        val hash = hash(value)
        if (!force && current.userId == userId && current.tokenHash == hash) return@withLock PushSyncOutcome.UNCHANGED
        val client = api() ?: return@withLock PushSyncOutcome.FAILED
        val ok = quietly { client.register(value, appVersion) } != null
        if (!ok) return@withLock PushSyncOutcome.FAILED
        state.save(PushRegistrationState(userId, hash))
        PushSyncOutcome.REGISTERED
    }

    /**
     * Call while the session token is still present, before local credentials are removed. Never throws
     * and never blocks sign-out for long.
     */
    suspend fun signedOut() = mutex.withLock {
        if (state.load().userId != null) quietly(signOutTimeoutMs) { api()?.unregister() }
        if (tokens.available) quietly(signOutTimeoutMs) { tokens.deleteToken() }
        state.save(PushRegistrationState())
    }

    private suspend fun <T> quietly(limitMs: Long = timeoutMs, block: suspend () -> T): T? = try {
        withTimeoutOrNull(limitMs) { block() }
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        null
    }

    private fun hash(token: String): String =
        MessageDigest.getInstance("SHA-256").digest(token.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
}

/** Shows Automates notifications on the device (Android: NotificationManager). */
interface PushNotifier {
    /** Shows (or replaces, for the same notification id) the notification. False when it could not be shown. */
    fun show(message: PushMessage): Boolean

    /** Removes every DASH AI notification (sign-out). */
    fun clearAll()
}

/** Records notifications instead of showing them (tests and previews). */
class RecordingPushNotifier : PushNotifier {
    val shown = mutableListOf<PushMessage>()
    var cleared = 0
        private set

    override fun show(message: PushMessage): Boolean {
        shown.removeAll { it.notificationId == message.notificationId }
        shown += message
        return true
    }

    override fun clearAll() {
        shown.clear()
        cleared += 1
    }
}

/** A build without push (no Firebase configuration), and tests. */
class FixedPushTokenSource(private val value: String? = null) : PushTokenSource {
    override val available: Boolean get() = value != null
    override suspend fun token(): String? = value
    override suspend fun deleteToken() = Unit
}
