package com.dashworldng.ai.di

import android.content.Context
import com.dashworldng.ai.BuildConfig
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
import com.dashworldng.ai.core.model.AssistantMode
import com.dashworldng.ai.core.model.DocumentItem
import com.dashworldng.ai.core.remote.DashApiClient
import com.dashworldng.ai.core.remote.RemoteChatGateway
import com.dashworldng.ai.core.remote.RemoteDocumentGateway
import com.dashworldng.ai.core.stream.ApiError
import com.dashworldng.ai.core.stream.ApiException
import com.dashworldng.ai.core.stream.ChatStreamEvent
import com.dashworldng.ai.core.util.Clock
import com.dashworldng.ai.data.AndroidConnectivityMonitor
import com.dashworldng.ai.data.ConnectivityMonitor
import com.dashworldng.ai.data.FixedConnectivity
import com.dashworldng.ai.data.local.DashDatabase
import com.dashworldng.ai.data.local.RoomConversationRepository
import com.dashworldng.ai.data.local.RoomDocumentRepository
import com.dashworldng.ai.data.local.RoomPromptRepository
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
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.getAndUpdate

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

/** Everything the screens need. The real app and UI tests provide different implementations. */
interface AppServices {
    val settings: SettingsRepository
    val conversations: ConversationRepository
    val prompts: PromptRepository
    val documents: DocumentRepository
    val tokens: TokenStore
    val connectivity: ConnectivityMonitor
    val prefill: PrefillBus
    val clock: Clock

    /** Demo Mode → on-device simulation; otherwise the configured Dash AI server. */
    fun chatGateway(): ChatGateway
    fun documentGateway(): DocumentGateway

    /** Null when the configured server address is invalid. */
    fun apiClient(): DashApiClient?
    fun authService(): AuthService?
}

/** Returned when no valid server is configured, so the failure is explained instead of crashing. */
private object UnconfiguredGateway : ChatGateway {
    override val isDemo: Boolean = false

    override fun stream(request: ChatRequest): Flow<ChatStreamEvent> = flow {
        throw ApiException(ApiError("server_not_configured", "Set a valid Dash AI server address in Settings, or turn on Demo Mode.", false))
    }
}

abstract class BaseServices : AppServices {
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
}

/** Production wiring: Room, DataStore, Android Keystore and the platform connectivity service. */
class AppContainer(context: Context) : BaseServices() {
    private val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val database = DashDatabase.create(context)

    override val settings: SettingsRepository = DataStoreSettingsRepository(context, appScope, BuildConfig.DEFAULT_SERVER_URL)
    override val conversations: ConversationRepository = RoomConversationRepository(database)
    override val prompts: PromptRepository = RoomPromptRepository(database)
    override val documents: DocumentRepository = RoomDocumentRepository(database)
    override val tokens: TokenStore = KeystoreTokenStore(context)
    override val connectivity: ConnectivityMonitor = AndroidConnectivityMonitor(context)
    override val prefill: PrefillBus = PrefillBus()
    override val clock: Clock = Clock.System
}

/** In-memory wiring for UI tests and previews. */
class InMemoryServices(
    initialSettings: AppSettings = AppSettings(loaded = true, serverUrl = "http://127.0.0.1:8787/"),
    private val chatGatewayOverride: ChatGateway? = null,
    documentGatewayOverride: DocumentGateway? = null,
    val fixedConnectivity: FixedConnectivity = FixedConnectivity(true),
) : BaseServices() {
    override val settings: SettingsRepository = InMemorySettingsRepository(initialSettings)
    override val conversations: ConversationRepository = InMemoryConversationRepository()
    override val prompts: PromptRepository = InMemoryPromptRepository()
    override val documents: DocumentRepository = InMemoryDocumentRepository()
    override val tokens: TokenStore = InMemoryTokenStore()
    override val connectivity: ConnectivityMonitor = fixedConnectivity
    override val prefill: PrefillBus = PrefillBus()
    override val clock: Clock = Clock.System
    override val demoDocuments: DocumentGateway = documentGatewayOverride ?: DemoDocumentGateway(stepDelayMillis = 0)

    override fun chatGateway(): ChatGateway = chatGatewayOverride ?: super.chatGateway()
}
