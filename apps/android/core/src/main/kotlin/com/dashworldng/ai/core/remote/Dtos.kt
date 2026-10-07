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
