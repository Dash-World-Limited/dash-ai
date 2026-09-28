package com.dashworldng.ai.core.remote

import com.dashworldng.ai.core.chat.ChatGateway
import com.dashworldng.ai.core.chat.ChatRequest
import com.dashworldng.ai.core.documents.DocumentGateway
import com.dashworldng.ai.core.documents.FileCheck
import com.dashworldng.ai.core.documents.FileRules
import com.dashworldng.ai.core.documents.UploadSource
import com.dashworldng.ai.core.model.DocumentItem
import com.dashworldng.ai.core.model.DocumentKind
import com.dashworldng.ai.core.model.DocumentStatus
import com.dashworldng.ai.core.model.MessageRole
import com.dashworldng.ai.core.stream.ApiError
import com.dashworldng.ai.core.stream.ApiException
import com.dashworldng.ai.core.stream.ChatStreamEvent
import com.dashworldng.ai.core.stream.SseParser
import com.dashworldng.ai.core.stream.StreamEventDecoder
import com.dashworldng.ai.core.util.Clock
import com.dashworldng.ai.core.util.IdGenerator
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerializationException
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import java.io.IOException

fun ChatRequest.toDto(): ChatStreamRequestDto = ChatStreamRequestDto(
    conversationId = conversationId,
    mode = mode.wire,
    modelChoice = modelChoice.wire,
    message = OutgoingMessageDto(
        id = messageId,
        content = content,
        attachmentIds = attachments.mapNotNull { it.remoteId },
    ),
    history = history.map { item ->
        HistoryMessageDto(
            role = if (item.role == MessageRole.USER) "user" else "assistant",
            content = item.content,
            origin = item.origin?.wire,
        )
    },
)

/** Streams answers from the Dash AI API over server-sent events. */
class RemoteChatGateway(private val client: DashApiClient) : ChatGateway {
    override val isDemo: Boolean = false

    override fun stream(request: ChatRequest): Flow<ChatStreamEvent> = callbackFlow {
        val call = client.newStreamCall(request.toDto())
        launch(Dispatchers.IO) {
            try {
                call.execute().use { response ->
                    if (!response.isSuccessful) throw client.errorFrom(response)
                    val source = response.body?.source() ?: throw ApiException(ApiError.unexpected)
                    val parser = SseParser()
                    while (isActive) {
                        val line = source.readUtf8Line() ?: break
                        val raw = parser.feed(line) ?: continue
                        StreamEventDecoder.decode(raw)?.let { send(it) }
                    }
                    parser.finish()?.let { raw -> StreamEventDecoder.decode(raw)?.let { send(it) } }
                }
                close()
            } catch (e: ApiException) {
                close(e)
            } catch (e: SerializationException) {
                close(ApiException(ApiError("bad_response", "The server sent a response this app does not understand.", false), cause = e))
            } catch (e: IOException) {
                // Cancelling the call (Stop) surfaces as an IOException; that is not an error.
                if (call.isCanceled()) close() else close(ApiException(ApiError.network("The connection to the Dash AI server was lost."), cause = e))
            }
        }
        awaitClose { call.cancel() }
    }

    override suspend fun cancel(streamId: String) {
        client.call { cancelStream(streamId) }
    }
}

/** Uploads documents to the Dash AI API, which validates and extracts text server-side. */
class RemoteDocumentGateway(
    private val client: DashApiClient,
    private val clock: Clock = Clock.System,
    private val ids: IdGenerator = IdGenerator.Uuid,
) : DocumentGateway {
    override val isDemo: Boolean = false

    override suspend fun upload(source: UploadSource, onProgress: (Float) -> Unit): DocumentItem {
        val kind = when (val check = FileRules.check(source.name, source.mimeType, source.sizeBytes)) {
            is FileCheck.Ok -> check.kind
            is FileCheck.Rejected -> throw ApiException(ApiError(check.code, check.message, retryable = false))
        }
        val mime = FileRules.canonicalMimeType(kind, source.name)
        val body = ProgressRequestBody(mime.toMediaType(), source.sizeBytes, source.open, onProgress)
        val part = MultipartBody.Part.createFormData("file", source.name, body)
        val dto = withContext(Dispatchers.IO) { client.call { uploadDocument(part) } }
        return dto.toDocumentItem(localId = ids.newId(), now = clock.now())
    }

    override suspend fun delete(document: DocumentItem) {
        val remoteId = document.remoteId ?: return
        client.callNoContent { deleteDocument(remoteId) }
    }
}

fun DocumentResponseDto.toDocumentItem(localId: String, now: Long): DocumentItem = DocumentItem(
    id = localId,
    remoteId = id,
    name = name,
    kind = DocumentKind.fromWire(kind) ?: DocumentKind.TXT,
    mimeType = mimeType,
    sizeBytes = sizeBytes,
    status = if (status == "ready") DocumentStatus.READY else DocumentStatus.UNSUPPORTED,
    statusDetail = statusDetail,
    extractedChars = extractedChars,
    pageCount = pageCount,
    createdAt = now,
    isDemo = false,
    progress = 1f,
)
