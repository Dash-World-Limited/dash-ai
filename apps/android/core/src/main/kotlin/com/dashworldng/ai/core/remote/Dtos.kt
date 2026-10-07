package com.dashworldng.ai.core.remote

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** JSON settings shared by the client. Requests always include defaults and explicit nulls. */
object DashJson {
    val default: Json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
        explicitNulls = true
    }

    /** Used by contract tests: fails on any field the DTOs do not know about. */
    val strict: Json = Json {
        ignoreUnknownKeys = false
        encodeDefaults = true
        explicitNulls = true
    }
}

// ---- Errors -------------------------------------------------------------------------------------

@Serializable
data class ApiErrorDto(val code: String, val message: String, val retryable: Boolean)

@Serializable
data class ErrorResponseDto(val error: ApiErrorDto)

// ---- System -------------------------------------------------------------------------------------

@Serializable
data class HealthDto(val status: String, val version: String, val uptimeSeconds: Double)

@Serializable
data class ProviderStatusDto(
    val id: String,
    val displayName: String,
    val configured: Boolean,
    val model: String?,
    val mode: String,
)

@Serializable
data class ResearchDto(val liveSearchAvailable: Boolean, val note: String)

/** Operator-only (`/v1/providers` with the operator token). The app never calls it. */
@Serializable
data class ProvidersResponseDto(
    val providers: List<ProviderStatusDto>,
    val compareAvailable: Boolean,
    val smartRouting: Map<String, List<String>>,
    val research: ResearchDto,
)

/** `GET /v1/assistant`: whether DASH AI can answer. The AI infrastructure behind it is never named. */
@Serializable
data class AssistantStatusDto(val available: Boolean, val demo: Boolean, val research: ResearchDto)

// ---- Auth and account ---------------------------------------------------------------------------

@Serializable
data class RegisterRequestDto(val email: String, val password: String, val displayName: String)

@Serializable
data class LoginRequestDto(val email: String, val password: String)

@Serializable
data class UserDto(val id: String, val email: String, val displayName: String, val createdAt: String)

@Serializable
data class AuthResponseDto(val token: String, val expiresAt: String, val user: UserDto)

@Serializable
data class MeResponseDto(val user: UserDto)

@Serializable
data class UsageTotalsDto(val provider: String? = null, val requests: Int, val inputTokens: Long, val outputTokens: Long)

@Serializable
data class UsageRecordDto(
    val conversationId: String,
    val messageId: String,
    val provider: String? = null,
    val model: String? = null,
    val demo: Boolean,
    val inputTokens: Long?,
    val outputTokens: Long?,
    val createdAt: String,
)

@Serializable
data class UsageSummaryDto(val totals: List<UsageTotalsDto>, val recent: List<UsageRecordDto>)

// ---- Conversations ------------------------------------------------------------------------------

@Serializable
data class ConversationDto(
    val id: String,
    val title: String,
    val mode: String,
    val createdAt: String,
    val updatedAt: String,
)

@Serializable
data class ConversationMessageDto(
    val id: String,
    val role: String,
    val content: String,
    val origin: String?,
    val model: String?,
    val demo: Boolean,
    val status: String,
    val compareGroupId: String?,
    val createdAt: String,
)

@Serializable
data class ConversationDetailDto(
    val conversation: ConversationDto,
    val messages: List<ConversationMessageDto>,
    /** Absent from older servers: read as none. */
    val toolActivity: List<MessageToolActivityDto> = emptyList(),
)

/** A recorded tool call of one message: names, outcome and timing only. */
@Serializable
data class MessageToolActivityDto(
    val messageId: String,
    val callId: String,
    val plugin: String,
    val tool: String,
    val status: String,
    val durationMs: Long,
    val createdAt: String,
)

@Serializable
data class ConversationListDto(val conversations: List<ConversationDto>)

@Serializable
data class CreateConversationRequestDto(val id: String? = null, val title: String? = null, val mode: String = "general")

@Serializable
data class UpdateConversationRequestDto(val title: String)

// ---- Sync ---------------------------------------------------------------------------------------

@Serializable
data class SyncConversationDto(
    val id: String,
    val title: String,
    val mode: String,
    val createdAt: String,
    val updatedAt: String,
    val titleIsCustom: Boolean,
    val titleRev: Long,
)

@Serializable
data class SyncChangeDto(
    val seq: Long,
    val deleted: Boolean,
    val conversation: SyncConversationDto,
    val messages: List<ConversationMessageDto>,
    val toolActivity: List<MessageToolActivityDto> = emptyList(),
)

@Serializable
data class SyncPageDto(
    val changes: List<SyncChangeDto>,
    val cursor: String,
    val latest: String,
    val hasMore: Boolean,
)

@Serializable
data class PushConversationDto(
    val id: String,
    val title: String,
    val titleIsCustom: Boolean,
    val mode: String,
    val createdAt: String,
)

/** A user message written on this device. Devices never upload assistant messages. */
@Serializable
data class PushMessageDto(val id: String, val content: String, val createdAt: String)

/** One device → server operation. `type` is "upload", "rename" or "delete"; unused fields are null. */
@Serializable
data class SyncOperationDto(
    val opId: String,
    val type: String,
    val conversation: PushConversationDto? = null,
    val messages: List<PushMessageDto>? = null,
    val conversationId: String? = null,
    val title: String? = null,
    val baseTitleRev: Long? = null,
)

@Serializable
data class SyncPushRequestDto(val operations: List<SyncOperationDto>)

@Serializable
data class SyncOperationResultDto(val opId: String, val status: String, val appended: Int? = null, val skipped: Int? = null)

@Serializable
data class SyncPushResponseDto(val results: List<SyncOperationResultDto>)

// ---- Chat ---------------------------------------------------------------------------------------

@Serializable
data class OutgoingMessageDto(val id: String, val content: String, val attachmentIds: List<String> = emptyList())

/** An earlier turn. Assistant turns are DASH AI's own; no origin is sent. */
@Serializable
data class HistoryMessageDto(val role: String, val content: String)

@Serializable
data class ChatStreamRequestDto(
    val conversationId: String,
    val mode: String,
    val modelChoice: String,
    val message: OutgoingMessageDto,
    val history: List<HistoryMessageDto> = emptyList(),
)

@Serializable
data class StreamTargetDto(val messageId: String, val provider: String? = null, val model: String? = null, val demo: Boolean)

@Serializable
data class StreamStartDto(
    val streamId: String,
    val conversationId: String,
    val modelChoice: String,
    val compareGroupId: String?,
    val targets: List<StreamTargetDto>,
    val routingReason: String,
)

@Serializable
data class MessageDeltaDto(val messageId: String, val text: String)

@Serializable
data class UsageDto(val inputTokens: Int?, val outputTokens: Int?)

@Serializable
data class MessageEndDto(val messageId: String, val finishReason: String, val usage: UsageDto)

/** How a failed answer can be recovered: attempts made. `alternatives` is always empty from production servers. */
@Serializable
data class MessageRecoveryDto(val attempts: Int, val alternatives: List<String> = emptyList())

@Serializable
data class MessageErrorDto(val messageId: String, val error: ApiErrorDto, val recovery: MessageRecoveryDto? = null)

@Serializable
data class ToolCallDto(val messageId: String, val callId: String, val plugin: String, val tool: String)

@Serializable
data class ToolResultDto(
    val messageId: String,
    val callId: String,
    val plugin: String,
    val tool: String,
    val status: String,
    val durationMs: Long,
)

@Serializable
data class ConversationTitleDto(val conversationId: String, val title: String)

@Serializable
data class StreamEndDto(val streamId: String)

@Serializable
data class StreamErrorDto(val error: ApiErrorDto)

@Serializable
data class CancelStreamResponseDto(val streamId: String, val cancelled: Boolean)

// ---- Documents ----------------------------------------------------------------------------------

@Serializable
data class DocumentResponseDto(
    val id: String,
    val name: String,
    val kind: String,
    val mimeType: String,
    val sizeBytes: Long,
    val status: String,
    val statusDetail: String,
    val extractedChars: Int,
    val pageCount: Int?,
    val createdAt: String,
)

@Serializable
data class DocumentListDto(val documents: List<DocumentResponseDto>)

// ---- Plugins and tools --------------------------------------------------------------------------

@Serializable
data class PluginScopeDto(val id: String, val description: String, val risk: String)

@Serializable
data class PluginToolDto(
    val name: String,
    val qualifiedName: String,
    val description: String,
    val scope: String,
    val risk: String,
    val executable: Boolean,
)

@Serializable
data class PluginDto(
    val id: String,
    val name: String,
    val description: String,
    val version: String,
    val kind: String,
    val scopes: List<PluginScopeDto>,
    val tools: List<PluginToolDto>,
    val enabled: Boolean,
    val grantedScopes: List<String>,
)

@Serializable
data class PluginsResponseDto(val toolsEnabled: Boolean, val plugins: List<PluginDto>)

/** `grantedScopes` is left out (never sent as null) so the server applies its read-only default. */
@OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)
@Serializable
data class UpdatePluginRequestDto(
    val enabled: Boolean,
    @kotlinx.serialization.EncodeDefault(kotlinx.serialization.EncodeDefault.Mode.NEVER) val grantedScopes: List<String>? = null,
)

/** Audit metadata for one tool call. The API never includes arguments or results. */
@Serializable
data class ToolActivityDto(
    val conversationId: String,
    val messageId: String,
    val callId: String,
    val provider: String? = null,
    val plugin: String,
    val tool: String,
    val status: String,
    val durationMs: Long,
    val argBytes: Long,
    val resultChars: Long,
    val createdAt: String,
)

@Serializable
data class ToolActivityResponseDto(val activity: List<ToolActivityDto>)

// ---- DASH Automates -----------------------------------------------------------------------------

/**
 * When an automation runs, in its own time zone. `kind` is once | daily | weekly | monthly; only the
 * fields of that kind are set (the others are left out of the JSON, never sent as null).
 */
@OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)
@Serializable
data class AutomationScheduleDto(
    val kind: String,
    val time: String,
    @kotlinx.serialization.EncodeDefault(kotlinx.serialization.EncodeDefault.Mode.NEVER) val date: String? = null,
    /** 0 = Sunday … 6 = Saturday. */
    @kotlinx.serialization.EncodeDefault(kotlinx.serialization.EncodeDefault.Mode.NEVER) val days: List<Int>? = null,
    @kotlinx.serialization.EncodeDefault(kotlinx.serialization.EncodeDefault.Mode.NEVER) val day: Int? = null,
)

/** A run as lists show it (no content). Never names a provider or model. */
@Serializable
data class AutomationRunSummaryDto(
    val id: String,
    val automationId: String,
    val status: String,
    val trigger: String,
    val createdAt: String,
    val startedAt: String?,
    val finishedAt: String?,
    val editedAt: String?,
    val error: String?,
    val demo: Boolean,
    val preview: String,
)

@Serializable
data class AutomationRunDto(
    val id: String,
    val automationId: String,
    val status: String,
    val trigger: String,
    val createdAt: String,
    val startedAt: String?,
    val finishedAt: String?,
    val editedAt: String?,
    val error: String?,
    val demo: Boolean,
    val preview: String,
    val content: String,
)

@Serializable
data class AutomationDto(
    val id: String,
    val name: String,
    val prompt: String,
    val mode: String,
    val schedule: AutomationScheduleDto,
    val timeZone: String,
    val status: String,
    /** scheduled | running | ready | failed | paused | completed: the one label clients show. */
    val state: String,
    val nextRunAt: String?,
    val lastRun: AutomationRunSummaryDto?,
    val createdAt: String,
    val updatedAt: String,
)

@Serializable
data class CreateAutomationRequestDto(
    val name: String,
    val prompt: String,
    val mode: String,
    val schedule: AutomationScheduleDto,
    val timeZone: String,
)

/** Only the fields being changed are sent; a schedule or time-zone change recomputes the next run. */
@OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)
@Serializable
data class UpdateAutomationRequestDto(
    @kotlinx.serialization.EncodeDefault(kotlinx.serialization.EncodeDefault.Mode.NEVER) val name: String? = null,
    @kotlinx.serialization.EncodeDefault(kotlinx.serialization.EncodeDefault.Mode.NEVER) val prompt: String? = null,
    @kotlinx.serialization.EncodeDefault(kotlinx.serialization.EncodeDefault.Mode.NEVER) val mode: String? = null,
    @kotlinx.serialization.EncodeDefault(kotlinx.serialization.EncodeDefault.Mode.NEVER) val schedule: AutomationScheduleDto? = null,
    @kotlinx.serialization.EncodeDefault(kotlinx.serialization.EncodeDefault.Mode.NEVER) val timeZone: String? = null,
)

@Serializable
data class AutomationListDto(val automations: List<AutomationDto>)

@Serializable
data class AutomationDetailDto(val automation: AutomationDto, val runs: List<AutomationRunSummaryDto>)

@Serializable
data class AutomationRunResponseDto(val run: AutomationRunDto)

@Serializable
data class UpdateAutomationRunRequestDto(val content: String)

@Serializable
data class AppNotificationDto(
    val id: String,
    /** automation.ready | automation.failed */
    val kind: String,
    val title: String,
    val body: String,
    val automationId: String,
    val runId: String,
    val createdAt: String,
    val readAt: String?,
)

@Serializable
data class NotificationListDto(val notifications: List<AppNotificationDto>, val unread: Int)

@OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)
@Serializable
data class MarkNotificationsReadRequestDto(
    @kotlinx.serialization.EncodeDefault(kotlinx.serialization.EncodeDefault.Mode.NEVER) val ids: List<String>? = null,
)

@Serializable
data class MarkNotificationsReadResponseDto(val updated: Int)

// ---- Push notifications -------------------------------------------------------------------------

/** Registers this signed-in session's device. The token is sent once and never comes back. */
@Serializable
data class RegisterPushDeviceRequestDto(val platform: String = "android", val token: String, val appVersion: String? = null)

@Serializable
data class PushDeviceDto(
    val id: String,
    val platform: String,
    val appVersion: String?,
    val current: Boolean,
    val createdAt: String,
    val updatedAt: String,
)

@Serializable
data class PushDeviceResponseDto(val device: PushDeviceDto)

/** `available` is false when the server has no push delivery configured. */
@Serializable
data class PushPreferencesDto(val automates: Boolean, val available: Boolean)

@Serializable
data class UpdatePushPreferencesRequestDto(val automates: Boolean)
