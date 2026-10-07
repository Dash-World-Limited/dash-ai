package com.dashworldng.ai.core.push

import com.dashworldng.ai.core.Fixtures
import com.dashworldng.ai.core.remote.DashApiClient
import com.dashworldng.ai.core.remote.DashJson
import com.dashworldng.ai.core.remote.PushDeviceDto
import com.dashworldng.ai.core.remote.PushDeviceResponseDto
import com.dashworldng.ai.core.remote.PushPreferencesDto
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

class PushTest {
    private val user = "user-00000001"
    private val payload = mapOf(
        "v" to "1",
        "type" to "automation.ready",
        "notificationId" to "note-00000001",
        "automationId" to "auto-00000001",
        "runId" to "run-000000001",
        "account" to accountTag(user),
        "title" to "DASH AI",
        "body" to "Your scheduled result is ready.",
        "createdAt" to "2026-10-07T07:00:09.000Z",
    )

    // ---- payloads ---------------------------------------------------------------------------

    @Test
    fun `the shared payload fixture parses, and the account tag matches the server's algorithm`() {
        val data = Json.parseToJsonElement(Fixtures.text("push-payload.json")) as JsonObject
        val message = PushPayloads.parse(data.mapValues { it.value.jsonPrimitive.content })!!
        assertEquals(PushEventType.RESULT_READY, message.type)
        assertEquals("6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b", message.automationId)
        // Same input, same tag as apps/api/src/push/payload.ts (sha256("dash-ai:push-account:" + id), 16 hex).
        assertEquals("6dbc65f2cf9a27ff", accountTag("user-0001"))
        assertTrue(accountTag(user).matches(Regex("^[a-f0-9]{16}$")))
    }

    @Test
    fun `malformed and unknown pushes are rejected`() {
        assertIs<PushMessage>(PushPayloads.parse(payload))
        assertNull(PushPayloads.parse(payload + ("v" to "2")))
        assertNull(PushPayloads.parse(payload + ("type" to "chat.message")))
        assertNull(PushPayloads.parse(payload - "runId"))
        assertNull(PushPayloads.parse(payload + ("automationId" to "../../admin")))
        assertNull(PushPayloads.parse(payload + ("account" to "not-a-tag")))
        assertNull(PushPayloads.parse(emptyMap()))
    }

    @Test
    fun `lock-screen text is fixed by type and provider-neutral, whatever the payload says`() {
        assertEquals("DASH AI", PushText.TITLE)
        assertEquals("Your scheduled result is ready.", PushText.body(PushEventType.RESULT_READY))
        assertEquals("A scheduled task needs your attention.", PushText.body(PushEventType.FAILED))
        val all = PushEventType.entries.joinToString(" ") { PushText.body(it) } + PushText.TITLE + PushText.CHANNEL_DESCRIPTION
        assertFalse(Regex("openai|chatgpt|anthropic|claude|gemini|firebase|model", RegexOption.IGNORE_CASE).containsMatchIn(all))
    }

    // ---- what is shown ------------------------------------------------------------------------

    @Test
    fun `a push is shown once for the signed-in account and dropped otherwise`() {
        val gate = PushGate(InMemorySeenPushStore())
        assertIs<PushDecision.Show>(gate.decide(payload, user, notificationsAllowed = true))
        assertEquals(PushDecision.Drop("duplicate"), gate.decide(payload, user, notificationsAllowed = true))
        assertEquals(PushDecision.Drop("other_account"), gate.decide(payload + ("notificationId" to "note-00000002"), "user-00000002", true))
        assertEquals(PushDecision.Drop("signed_out"), gate.decide(payload + ("notificationId" to "note-00000003"), null, true))
        assertEquals(PushDecision.Drop("not_allowed"), gate.decide(payload + ("notificationId" to "note-00000004"), user, false))
        assertEquals(PushDecision.Drop("malformed"), gate.decide(mapOf("v" to "1"), user, true))
        // A dropped push does not use up its id: it can still be shown once allowed.
        assertIs<PushDecision.Show>(gate.decide(payload + ("notificationId" to "note-00000004"), user, true))
    }

    @Test
    fun `the seen list is bounded`() {
        val seen = InMemorySeenPushStore(capacity = 2)
        assertTrue(seen.markIfNew("a"))
        assertTrue(seen.markIfNew("b"))
        assertTrue(seen.markIfNew("c"))
        assertTrue(seen.markIfNew("a"))
        assertFalse(seen.markIfNew("c"))
    }

    // ---- where a tap goes ---------------------------------------------------------------------

    @Test
    fun `a result opens the result, a failure opens the automation, and crafted extras are refused`() {
        val ready = PushPayloads.parse(payload)!!
        assertEquals(PushDestination.Result("auto-00000001", "run-000000001", "note-00000001"), PushDestination.of(ready))
        val failed = ready.copy(type = PushEventType.FAILED)
        assertEquals(PushDestination.Automation("auto-00000001", "note-00000001"), PushDestination.of(failed))

        val extras = PushLink.extras(ready)
        assertEquals(PushDestination.of(ready), PushLink.parse(extras::get))
        assertEquals(PushDestination.of(failed), PushLink.parse(PushLink.extras(failed)::get))
        assertNull(PushLink.parse(emptyMap<String, String>()::get))
        assertNull(PushLink.parse((extras + (PushLink.EXTRA_AUTOMATION to "x/../../y"))::get))
        assertNull(PushLink.parse((extras + (PushLink.EXTRA_TYPE to "admin"))::get))
        assertNull(PushLink.parse((extras - PushLink.EXTRA_RUN)::get))
    }

    @Test
    fun `the inbox hands a tapped destination over once`() {
        val inbox = PushOpenInbox()
        inbox.post(PushDestination.Automation("auto-00000001"))
        assertEquals(PushDestination.Automation("auto-00000001"), inbox.consume())
        assertNull(inbox.consume())
    }

    // ---- registration -------------------------------------------------------------------------

    private class FakeTokens(var value: String? = "token-aaaaaaaaaaaaaaaa", override val available: Boolean = true) : PushTokenSource {
        var deleted = 0
        override suspend fun token(): String? = value
        override suspend fun deleteToken() {
            deleted += 1
            value = "token-rotated-${deleted}aaaaaaaa"
        }
    }

    private class FakeApi : PushApi {
        val registered = mutableListOf<String>()
        var unregistered = 0
        var fail = false
        var hang = false
        override suspend fun register(token: String, appVersion: String?): PushDeviceDto {
            if (hang) delay(60_000)
            if (fail) error("offline")
            registered += token
            return PushDeviceDto("device-00000001", "android", appVersion, true, "2026-10-07T07:00:00Z", "2026-10-07T07:00:00Z")
        }
        override suspend fun unregister() {
            if (hang) delay(60_000)
            if (fail) error("offline")
            unregistered += 1
        }
        override suspend fun preferences() = PushPreferencesDto(automates = true, available = true)
        override suspend fun setAutomates(on: Boolean) = PushPreferencesDto(automates = on, available = true)
    }

    @Test
    fun `registers once per account and token, re-registers on token refresh and account change`() = runBlocking<Unit> {
        val api = FakeApi()
        val tokens = FakeTokens()
        val state = InMemoryPushStateStore()
        val registrar = PushRegistrar({ api }, tokens, state, "0.1.0")
        assertEquals(PushSyncOutcome.REGISTERED, registrar.sync(user, notificationsAllowed = true))
        assertEquals(PushSyncOutcome.UNCHANGED, registrar.sync(user, notificationsAllowed = true))
        // Token refresh (FirebaseMessagingService.onNewToken).
        assertEquals(PushSyncOutcome.REGISTERED, registrar.sync(user, true, token = "token-bbbbbbbbbbbbbbbb"))
        // Another account signs in on this phone: the server moves the token to it.
        assertEquals(PushSyncOutcome.REGISTERED, registrar.sync("user-00000002", true, token = "token-bbbbbbbbbbbbbbbb"))
        assertEquals(listOf("token-aaaaaaaaaaaaaaaa", "token-bbbbbbbbbbbbbbbb", "token-bbbbbbbbbbbbbbbb"), api.registered)
        // Only a hash of the token is kept on the device.
        assertFalse(state.load().tokenHash!!.contains("token"))
    }

    @Test
    fun `notifications not allowed, or nobody signed in, means not registered`() = runBlocking<Unit> {
        val api = FakeApi()
        val registrar = PushRegistrar({ api }, FakeTokens(), InMemoryPushStateStore(), "0.1.0")
        assertEquals(PushSyncOutcome.NOT_REGISTERED, registrar.sync(null, true))
        assertEquals(PushSyncOutcome.NOT_REGISTERED, registrar.sync(user, notificationsAllowed = false))
        assertEquals(PushSyncOutcome.REGISTERED, registrar.sync(user, true))
        // Permission revoked in Android settings: the server stops pushing to this phone.
        assertEquals(PushSyncOutcome.UNREGISTERED, registrar.sync(user, notificationsAllowed = false))
        assertEquals(1, api.unregistered)
        assertEquals(PushSyncOutcome.UNAVAILABLE, PushRegistrar({ api }, FakeTokens(available = false), InMemoryPushStateStore(), null).sync(user, true))
    }

    @Test
    fun `a failed registration is retried on the next sync and never throws`() = runBlocking<Unit> {
        val api = FakeApi().apply { fail = true }
        val registrar = PushRegistrar({ api }, FakeTokens(), InMemoryPushStateStore(), "0.1.0")
        assertEquals(PushSyncOutcome.FAILED, registrar.sync(user, true))
        api.fail = false
        assertEquals(PushSyncOutcome.REGISTERED, registrar.sync(user, true))
        assertEquals(PushSyncOutcome.FAILED, PushRegistrar({ null }, FakeTokens(), InMemoryPushStateStore(), null).sync(user, true))
    }

    @Test
    fun `signing out unregisters, discards the device token and forgets the account, even offline`() = runBlocking<Unit> {
        val api = FakeApi()
        val tokens = FakeTokens()
        val state = InMemoryPushStateStore()
        val registrar = PushRegistrar({ api }, tokens, state, "0.1.0", timeoutMs = 200, signOutTimeoutMs = 200)
        registrar.sync(user, true)
        registrar.signedOut()
        assertEquals(1, api.unregistered)
        assertEquals(1, tokens.deleted)
        assertEquals(PushRegistrationState(), state.load())

        // Offline or hanging server: sign-out still completes quickly.
        registrar.sync(user, true)
        api.hang = true
        val started = System.currentTimeMillis()
        registrar.signedOut()
        assertTrue(System.currentTimeMillis() - started < 5_000)
        assertEquals(2, tokens.deleted)
        assertEquals(PushRegistrationState(), state.load())
    }

    @Test
    fun `the client speaks the push API`() = runBlocking<Unit> {
        val server = MockWebServer()
        server.start()
        try {
            server.enqueue(MockResponse().setBody(Fixtures.text("push-device.json")))
            server.enqueue(MockResponse().setResponseCode(204))
            server.enqueue(MockResponse().setBody(Fixtures.text("push-preferences.json")))
            server.enqueue(MockResponse().setBody("""{"automates":false,"available":true}"""))
            val api = RemotePushApi { DashApiClient(server.url("/").toString(), tokenProvider = { "dash_session" }) }
            assertEquals("android", api.register("token-aaaaaaaaaaaaaaaa", "0.1.0").platform)
            api.unregister()
            assertTrue(api.preferences().automates)
            assertFalse(api.setAutomates(false).automates)
            server.takeRequest().also {
                assertEquals("PUT", it.method)
                assertEquals("/v1/push/devices/current", it.path)
                assertEquals("""{"platform":"android","token":"token-aaaaaaaaaaaaaaaa","appVersion":"0.1.0"}""", it.body.readUtf8())
            }
            assertEquals("DELETE", server.takeRequest().method)
            assertEquals("/v1/push/preferences", server.takeRequest().path)
            server.takeRequest().also { assertEquals("""{"automates":false}""", it.body.readUtf8()) }
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun `push fixtures decode strictly`() {
        DashJson.strict.decodeFromString(PushDeviceResponseDto.serializer(), Fixtures.text("push-device.json")).also {
            assertTrue(it.device.current)
        }
        DashJson.strict.decodeFromString(PushPreferencesDto.serializer(), Fixtures.text("push-preferences.json"))
    }
}
