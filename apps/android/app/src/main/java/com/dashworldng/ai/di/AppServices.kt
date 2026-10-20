package com.dashworldng.ai.di

import android.content.Context
import com.dashworldng.ai.BuildConfig
import com.dashworldng.ai.core.account.InMemoryLocalOwnerStore
import com.dashworldng.ai.core.account.LocalAccountGuard
import com.dashworldng.ai.core.account.LocalOwnerStore
import com.dashworldng.ai.core.auth.AuthService
import com.dashworldng.ai.core.chat.ChatGateway
import com.dashworldng.ai.core.chat.ChatRequest
import com.dashworldng.ai.core.data.ConversationRepository
import com.dashworldng.ai.core.data.DocumentRepository
import com.dashworldng.ai.core.data.InMemoryConversationRepository
import com.dashworldng.ai.core.data.InMemoryDocumentRepository
import com.dashworldng.ai.core.data.InMemoryPromptRepository
import com.dashworldng.ai.core.data.PromptRepository
import com.dashworldng.ai.core.demo.DemoChatGateway
import com.dashworldng.ai.core.documents.DemoDocumentGateway
import com.dashworldng.ai.core.documents.DocumentGateway
import com.dashworldng.ai.core.documents.UploadSource
import com.dashworldng.ai.core.model.AssistantMode
import com.dashworldng.ai.core.model.DocumentItem
import com.dashworldng.ai.core.presentation.SyncTracker
import com.dashworldng.ai.core.tools.ToolsService
import com.dashworldng.ai.core.automations.AutomationNotices
import com.dashworldng.ai.core.automations.AutomationsApi
import com.dashworldng.ai.core.automations.RemoteAutomations
import com.dashworldng.ai.core.push.FixedNotificationPermission
import com.dashworldng.ai.core.push.FixedPushTokenSource
import com.dashworldng.ai.core.push.InMemoryPushStateStore
import com.dashworldng.ai.core.push.InMemorySeenPushStore
import com.dashworldng.ai.core.push.NotificationPermissionState
import com.dashworldng.ai.core.push.PushApi
import com.dashworldng.ai.core.push.PushDecision
import com.dashworldng.ai.core.push.PushGate
import com.dashworldng.ai.core.push.PushNotifier
import com.dashworldng.ai.core.push.PushOpenInbox
import com.dashworldng.ai.core.push.PushRegistrar
import com.dashworldng.ai.core.push.PushStateStore
import com.dashworldng.ai.core.push.PushTokenSource
import com.dashworldng.ai.core.push.RecordingPushNotifier
import com.dashworldng.ai.core.push.RemotePushApi
import com.dashworldng.ai.core.push.SeenPushStore
import com.dashworldng.ai.core.remote.DashApiClient
import com.dashworldng.ai.core.remote.RemoteChatGateway
import com.dashworldng.ai.core.remote.RemoteDocumentGateway
import com.dashworldng.ai.core.stream.ApiError
import com.dashworldng.ai.core.stream.ApiException
import com.dashworldng.ai.core.stream.ChatStreamEvent
import com.dashworldng.ai.core.sync.ConversationSyncService
import com.dashworldng.ai.core.sync.DashApiSyncRemote
import com.dashworldng.ai.core.sync.InMemorySyncStateStore
import com.dashworldng.ai.core.sync.SyncStateStore
import com.dashworldng.ai.core.util.Clock
import com.dashworldng.ai.data.AndroidConnectivityMonitor
import com.dashworldng.ai.data.ConnectivityMonitor
import com.dashworldng.ai.data.FixedConnectivity
import com.dashworldng.ai.data.local.DashDatabase
import com.dashworldng.ai.data.local.RoomConversationRepository
import com.dashworldng.ai.data.local.RoomDocumentRepository
import com.dashworldng.ai.data.local.RoomPromptRepository
import com.dashworldng.ai.data.push.AndroidPush
import com.dashworldng.ai.data.sync.PrefsLocalOwnerStore
import com.dashworldng.ai.data.sync.PrefsSyncStateStore
import com.dashworldng.ai.data.security.InMemoryTokenStore
import com.dashworldng.ai.data.security.KeystoreTokenStore
import com.dashworldng.ai.data.security.TokenStore
import com.dashworldng.ai.data.settings.AppSettings
import com.dashworldng.ai.data.settings.DataStoreSettingsRepository
import com.dashworldng.ai.data.settings.InMemorySettingsRepository
import com.dashworldng.ai.data.settings.SettingsRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.getAndUpdate
import kotlinx.coroutines.launch

/** Text, mode and documents handed to the chat composer from another screen. */
data class ComposerPrefill(
    val text: String,
    val mode: AssistantMode? = null,
    val documents: List<DocumentItem> = emptyList(),
    val sendNow: Boolean = false,
    val newChat: Boolean = false,
)

class PrefillBus {
    private val state = MutableStateFlow<ComposerPrefill?>(null)
    val pending: StateFlow<ComposerPrefill?> = state.asStateFlow()

    fun post(prefill: ComposerPrefill) {
        state.value = prefill
    }

    fun consume(): ComposerPrefill? = state.getAndUpdate { null }
}

/**
 * Something another app shared with DASH AI ("Share → DASH AI"): text for the composer and files to
 * attach. [refused] counts items that were not accepted (unsupported or unsafe sources), so the chat
 * can say so instead of dropping them silently.
 */
data class IncomingShare(
    val text: String? = null,
    val files: List<UploadSource> = emptyList(),
    val refused: Int = 0,
)

/** Holds a share until the app can show it (after onboarding and sign-in). */
class ShareInbox {
    private val state = MutableStateFlow<IncomingShare?>(null)
    val pending: StateFlow<IncomingShare?> = state.asStateFlow()

    fun post(share: IncomingShare) {
        state.value = share
    }

    fun consume(): IncomingShare? = state.getAndUpdate { null }
}

/** Everything the screens need. The real app and UI tests provide different implementations. */
interface AppServices {
    val settings: SettingsRepository
    val conversations: ConversationRepository
    val prompts: PromptRepository
    val documents: DocumentRepository
    val tokens: TokenStore
    val connectivity: ConnectivityMonitor
    val prefill: PrefillBus
    val shares: ShareInbox
    val clock: Clock
    val syncState: SyncStateStore

    /**
     * Keeps one account's data on the device at a time: sign-out removes it, signing in as another
     * account removes the previous one's first. `conversations` and `documents` above are fenced by it.
     */
    val accountGuard: LocalAccountGuard

    /** Sign-in, Demo Mode and sign-out: the only way screens change the account (see AccountTransitions). */
    val accounts: AccountTransitions

    /** Sync is skipped while this returns false (for example while a response is being generated). */
    var syncGuard: () -> Boolean

    /** Demo Mode → on-device simulation; otherwise the configured Dash AI server. */
    fun chatGateway(): ChatGateway
    fun documentGateway(): DocumentGateway

    /** Null when the configured server address is invalid. */
    fun apiClient(): DashApiClient?
    fun authService(): AuthService?

    /** Pulls the signed-in account's conversations into Room. Null when no valid server is configured. */
    fun syncService(): ConversationSyncService?

    /** The server's plugin registry and this account's tool choices. Null when no valid server is configured. */
    fun toolsService(): ToolsService?

    /** DASH Automates on the server. Null when no valid server is configured. */
    fun automations(): AutomationsApi?

    /** Unread Automates notices for this app session. */
    val notices: AutomationNotices

    /** What this app session knows about sync (shown as Synced / Syncing / Offline / Sync issue). */
    val syncTracker: SyncTracker

    // ---- Automates push notifications (docs/push-notifications.md) ----

    /** Whether DASH AI may show notifications on this phone (Android permission and settings). */
    val notificationPermission: NotificationPermissionState

    /** Keeps this phone's server registration in line with the signed-in account and the permission. */
    val push: PushRegistrar

    /** A tapped notification's destination, opened once the app is ready. */
    val pushOpens: PushOpenInbox

    /** Push preferences and registration on the server. Null when no valid server is configured. */
    fun pushApi(): PushApi?

    /** Handles an incoming push (FCM data). True when a notification was shown. */
    suspend fun receivePush(data: Map<String, String>): Boolean

    /** A new device token (FCM refreshed it): registers it for the signed-in account. */
    fun onPushToken(token: String)
}

/** The signed-in real account, or null (signed out, Demo Mode, or no session token). */
fun AppSettings.signedInUserId(): String? = if (demoMode) null else account?.takeUnless { it.isDemo }?.userId

/** Returned when no valid server is configured, so the failure is explained instead of crashing. */
private object UnconfiguredGateway : ChatGateway {
    override val isDemo: Boolean = false

    override fun stream(request: ChatRequest): Flow<ChatStreamEvent> = flow {
        throw ApiException(ApiError("server_not_configured", "Set a valid Dash AI server address in Settings, or turn on Demo Mode.", false))
    }
}

abstract class BaseServices : AppServices {
    /** The unfenced stores: sync writes here; screens and chat sessions use the fenced views. */
    protected abstract val localConversations: ConversationRepository
    protected abstract val localDocuments: DocumentRepository
    protected abstract val ownerStore: LocalOwnerStore
    protected abstract val pushTokens: PushTokenSource
    protected abstract val pushState: PushStateStore
    protected abstract val seenPushes: SeenPushStore
    protected abstract val notifier: PushNotifier

    override val accountGuard: LocalAccountGuard by lazy {
        LocalAccountGuard(
            owner = ownerStore,
            conversations = localConversations,
            documents = localDocuments,
            prompts = prompts,
            syncState = syncState,
            clearCredentials = {
                // While the session token is still here: end this phone's push registration and discard
                // its device token, then remove what the previous account was notified about.
                push.signedOut()
                notifier.clearAll()
                seenPushes.clear()
                pushOpens.clear()
                tokens.set(null)
            },
            exclusive = { block -> syncService()?.exclusive(block) ?: block() },
        )
    }
    override val accounts: AccountTransitions by lazy { AccountTransitions(this) }
    override val conversations: ConversationRepository by lazy { accountGuard.fence(localConversations) }
    override val documents: DocumentRepository by lazy { accountGuard.fence(localDocuments) }

    private var cachedUrl: String? = null
    private var cachedClient: DashApiClient? = null

    protected open val demoChat: ChatGateway by lazy {
        DemoChatGateway(failure = { settings.settings.value.demoFailure })
    }
    protected open val demoDocuments: DocumentGateway by lazy { DemoDocumentGateway() }

    @Synchronized
    override fun apiClient(): DashApiClient? {
        val url = settings.settings.value.serverUrl
        if (url != cachedUrl) {
            cachedUrl = url
            cachedClient = runCatching { DashApiClient(url, tokenProvider = { tokens.get() }) }.getOrNull()
        }
        return cachedClient
    }

    override fun chatGateway(): ChatGateway =
        if (settings.settings.value.demoMode) demoChat else apiClient()?.let { RemoteChatGateway(it) } ?: UnconfiguredGateway

    override fun documentGateway(): DocumentGateway {
        if (settings.settings.value.demoMode) return demoDocuments
        val client = apiClient() ?: throw ApiException(ApiError("server_not_configured", "Set a valid Dash AI server address in Settings.", false))
        return RemoteDocumentGateway(client)
    }

    override fun authService(): AuthService? = apiClient()?.let { client -> AuthService { client } }

    override fun toolsService(): ToolsService? = apiClient()?.let { client -> ToolsService { client } }

    override fun automations(): AutomationsApi? = apiClient()?.let { client -> RemoteAutomations { client } }

    override val notices: AutomationNotices = AutomationNotices()

    override val syncTracker: SyncTracker by lazy { SyncTracker(clock) }

    override val pushOpens: PushOpenInbox = PushOpenInbox()

    override val push: PushRegistrar by lazy { PushRegistrar({ pushApi() }, pushTokens, pushState, BuildConfig.VERSION_NAME) }

    override fun pushApi(): PushApi? = apiClient()?.let { client -> RemotePushApi { client } }

    override suspend fun receivePush(data: Map<String, String>): Boolean {
        val s = settings.settings.first { it.loaded }
        val userId = s.signedInUserId()?.takeIf { tokens.get() != null }
        notificationPermission.refresh()
        return when (val decision = PushGate(seenPushes).decide(data, userId, notificationPermission.granted.value)) {
            is PushDecision.Show -> notifier.show(decision.message)
            is PushDecision.Drop -> false
        }
    }

    @Volatile
    override var syncGuard: () -> Boolean = { true }
    private var syncClient: DashApiClient? = null
    private var cachedSync: ConversationSyncService? = null

    /** Server → Room conversation sync for the configured server; null when no valid server is set. */
    @Synchronized
    override fun syncService(): ConversationSyncService? {
        val client = apiClient() ?: return null
        if (client !== syncClient) {
            syncClient = client
            cachedSync = ConversationSyncService(
                DashApiSyncRemote(client),
                localConversations,
                syncState,
                canSync = { syncGuard() },
                isOwner = { accountGuard.isOwner(it) },
            )
        }
        return cachedSync
    }
}

/** Production wiring: Room, DataStore, Android Keystore and the platform connectivity service. */
class AppContainer(context: Context) : BaseServices() {
    private val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val database = DashDatabase.create(context)

    override val settings: SettingsRepository = DataStoreSettingsRepository(context, appScope, BuildConfig.DEFAULT_SERVER_URL)
    override val localConversations: ConversationRepository = RoomConversationRepository(database)
    override val prompts: PromptRepository = RoomPromptRepository(database)
    override val localDocuments: DocumentRepository = RoomDocumentRepository(database)
    override val ownerStore: LocalOwnerStore = PrefsLocalOwnerStore(context)
    override val tokens: TokenStore = KeystoreTokenStore(context)
    override val connectivity: ConnectivityMonitor = AndroidConnectivityMonitor(context)
    override val prefill: PrefillBus = PrefillBus()
    override val shares: ShareInbox = ShareInbox()
    override val clock: Clock = Clock.System
    override val syncState: SyncStateStore = PrefsSyncStateStore(context)
    private val androidPush = AndroidPush(context)
    override val pushTokens: PushTokenSource = androidPush.tokens
    override val pushState: PushStateStore = androidPush.state
    override val seenPushes: SeenPushStore = androidPush.seen
    override val notifier: PushNotifier = androidPush.notifier
    override val notificationPermission: NotificationPermissionState = androidPush.permission

    override fun onPushToken(token: String) {
        appScope.launch {
            val s = settings.settings.first { it.loaded }
            push.sync(s.signedInUserId()?.takeIf { tokens.get() != null }, notificationPermission.granted.value, token = token)
        }
    }

    init {
        appScope.launch {
            // Finish a sign-out the app was killed in the middle of, before screens read any data.
            accountGuard.recover()
            // An account signed in with an older app version has no ownership record yet: adopt it.
            val account = settings.settings.first { it.loaded }.account
            if (account != null && !account.isDemo && tokens.get() != null) accountGuard.adoptExisting(account.userId)
            // The demo profile never shows data an account still owns (an earlier version could leave it).
            accounts.repairAtStart()
        }
    }
}

/** In-memory wiring for UI tests and previews. */
class InMemoryServices(
    initialSettings: AppSettings = AppSettings(loaded = true, serverUrl = "http://127.0.0.1:8787/"),
    private val chatGatewayOverride: ChatGateway? = null,
    documentGatewayOverride: DocumentGateway? = null,
    val fixedConnectivity: FixedConnectivity = FixedConnectivity(true),
    private val automationsOverride: AutomationsApi? = null,
    private val pushApiOverride: PushApi? = null,
    val permission: FixedNotificationPermission = FixedNotificationPermission(granted = false),
    override val pushTokens: PushTokenSource = FixedPushTokenSource(),
    override val notifier: PushNotifier = RecordingPushNotifier(),
    private val authOverride: AuthService? = null,
) : BaseServices() {
    override val pushState: PushStateStore = InMemoryPushStateStore()
    override val seenPushes: SeenPushStore = InMemorySeenPushStore()
    override val notificationPermission: NotificationPermissionState = permission

    override fun pushApi(): PushApi? = pushApiOverride ?: super.pushApi()

    override fun authService(): AuthService? = authOverride ?: super.authService()

    override fun onPushToken(token: String) = Unit

    override val settings: SettingsRepository = InMemorySettingsRepository(initialSettings)
    override val localConversations: ConversationRepository = InMemoryConversationRepository()
    override val prompts: PromptRepository = InMemoryPromptRepository()
    override val localDocuments: DocumentRepository = InMemoryDocumentRepository()
    override val ownerStore: LocalOwnerStore = InMemoryLocalOwnerStore()
    override val tokens: TokenStore = InMemoryTokenStore()
    override val connectivity: ConnectivityMonitor = fixedConnectivity
    override val prefill: PrefillBus = PrefillBus()
    override val shares: ShareInbox = ShareInbox()
    override val clock: Clock = Clock.System
    override val syncState: SyncStateStore = InMemorySyncStateStore()
    override val demoDocuments: DocumentGateway = documentGatewayOverride ?: DemoDocumentGateway(stepDelayMillis = 0)

    override fun chatGateway(): ChatGateway = chatGatewayOverride ?: super.chatGateway()

    override fun automations(): AutomationsApi? = automationsOverride ?: super.automations()
}
