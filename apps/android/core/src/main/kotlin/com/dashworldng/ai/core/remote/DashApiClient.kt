package com.dashworldng.ai.core.remote

import com.dashworldng.ai.core.stream.ApiError
import com.dashworldng.ai.core.stream.ApiException
import kotlinx.serialization.SerializationException
import okhttp3.Call
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okio.BufferedSink
import okio.source
import retrofit2.HttpException
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory
import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.Multipart
import retrofit2.http.PATCH
import retrofit2.http.POST
import retrofit2.http.PUT
import retrofit2.http.Part
import retrofit2.http.Path
import java.io.IOException
import java.io.InputStream
import java.util.concurrent.TimeUnit

/** REST endpoints of the Dash AI API. Streaming chat uses OkHttp directly (see RemoteChatGateway). */
interface DashApiService {
    @GET("health") suspend fun health(): HealthDto

    @GET("v1/assistant") suspend fun assistant(): AssistantStatusDto

    @POST("v1/auth/register") suspend fun register(@Body body: RegisterRequestDto): AuthResponseDto

    @POST("v1/auth/login") suspend fun login(@Body body: LoginRequestDto): AuthResponseDto

    @POST("v1/auth/logout") suspend fun logout(): retrofit2.Response<Unit>

    @POST("v1/auth/logout-all") suspend fun logoutAll(): retrofit2.Response<Unit>

    @GET("v1/me") suspend fun me(): MeResponseDto

    @DELETE("v1/me") suspend fun deleteAccount(): retrofit2.Response<Unit>

    @GET("v1/usage") suspend fun usage(): UsageSummaryDto

    @GET("v1/conversations") suspend fun conversations(): ConversationListDto

    @POST("v1/conversations") suspend fun createConversation(@Body body: CreateConversationRequestDto): ConversationDto

    @GET("v1/sync/conversations") suspend fun syncConversations(
        @retrofit2.http.Query("cursor") cursor: String,
        @retrofit2.http.Query("limit") limit: Int,
    ): SyncPageDto

    @POST("v1/sync/push") suspend fun syncPush(@Body body: SyncPushRequestDto): SyncPushResponseDto

    @GET("v1/conversations/{id}") suspend fun conversation(@Path("id") id: String): ConversationDetailDto

    @PATCH("v1/conversations/{id}") suspend fun renameConversation(
        @Path("id") id: String,
        @Body body: UpdateConversationRequestDto,
    ): ConversationDto

    @DELETE("v1/conversations/{id}") suspend fun deleteConversation(@Path("id") id: String): retrofit2.Response<Unit>

    @POST("v1/chat/streams/{streamId}/cancel") suspend fun cancelStream(@Path("streamId") streamId: String): CancelStreamResponseDto

    @Multipart
    @POST("v1/documents")
    suspend fun uploadDocument(@Part file: MultipartBody.Part): DocumentResponseDto

    @GET("v1/documents") suspend fun documents(): DocumentListDto

    @DELETE("v1/documents/{id}") suspend fun deleteDocument(@Path("id") id: String): retrofit2.Response<Unit>

    @GET("v1/plugins") suspend fun plugins(): PluginsResponseDto

    @PUT("v1/plugins/{id}") suspend fun updatePlugin(@Path("id") id: String, @Body body: UpdatePluginRequestDto): PluginDto

    @GET("v1/tools/activity") suspend fun toolActivity(): ToolActivityResponseDto
}

/**
 * The only network client in the app. It talks exclusively to the configured Dash AI server;
 * AI service keys never exist on the device.
 */
class DashApiClient(
    baseUrl: String,
    private val tokenProvider: () -> String?,
    baseClient: OkHttpClient = OkHttpClient(),
) {
    val baseUrl: HttpUrl = normalizeBaseUrl(baseUrl)
        ?: throw IllegalArgumentException("Invalid server address")

    private val jsonMediaType = "application/json".toMediaType()

    val http: OkHttpClient = baseClient.newBuilder()
        .connectTimeout(15, TimeUnit.SECONDS)
        // Streams send a heartbeat every 15 s, so a long read gap means the connection is gone.
        .readTimeout(90, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .addInterceptor { chain ->
            val request = chain.request()
            val token = tokenProvider()
            val sameServer = request.url.host == this.baseUrl.host && request.url.port == this.baseUrl.port
            chain.proceed(
                if (token != null && sameServer) request.newBuilder().header("Authorization", "Bearer $token").build() else request,
            )
        }
        .build()

    val service: DashApiService = Retrofit.Builder()
        .baseUrl(this.baseUrl)
        .client(http)
        .addConverterFactory(DashJson.default.asConverterFactory(jsonMediaType))
        .build()
        .create(DashApiService::class.java)

    /** Runs a REST call, converting failures into [ApiException] with a user-safe message. */
    suspend fun <T> call(block: suspend DashApiService.() -> T): T = try {
        service.block()
    } catch (e: HttpException) {
        throw errorFrom(e.code(), e.response()?.errorBody()?.string())
    } catch (e: ApiException) {
        throw e
    } catch (e: IOException) {
        throw ApiException(ApiError.network(), cause = e)
    } catch (e: SerializationException) {
        throw ApiException(ApiError("bad_response", "The server sent a response this app does not understand.", false), cause = e)
    }

    /** Checks a Response<Unit> returned by endpoints without a body. */
    suspend fun callNoContent(block: suspend DashApiService.() -> retrofit2.Response<Unit>) {
        val response = call(block)
        if (!response.isSuccessful) throw errorFrom(response.code(), response.errorBody()?.string())
    }

    fun newStreamCall(body: ChatStreamRequestDto): Call {
        val request = Request.Builder()
            .url(baseUrl.resolve("v1/chat/stream")!!)
            .header("Accept", "text/event-stream")
            .post(DashJson.default.encodeToString(ChatStreamRequestDto.serializer(), body).toRequestBody(jsonMediaType))
            .build()
        return http.newCall(request)
    }

    fun errorFrom(response: Response): ApiException = errorFrom(response.code, response.body?.string())

    fun errorFrom(httpStatus: Int, body: String?): ApiException {
        val parsed = body?.let {
            runCatching { DashJson.default.decodeFromString(ErrorResponseDto.serializer(), it).error }.getOrNull()
        }
        val error = parsed?.let { ApiError(it.code, it.message, it.retryable) } ?: ApiError(
            code = if (httpStatus == 401) "unauthorized" else "http_$httpStatus",
            message = when (httpStatus) {
                401 -> "Sign in to continue."
                404 -> "The Dash AI server does not support this request. Check the server address."
                in 500..599 -> "The Dash AI server had a problem. Try again shortly."
                else -> "The request failed (HTTP $httpStatus)."
            },
            retryable = httpStatus >= 500,
        )
        return ApiException(error, httpStatus)
    }

    companion object {
        fun normalizeBaseUrl(raw: String): HttpUrl? {
            val trimmed = raw.trim()
            if (trimmed.isEmpty()) return null
            val withScheme = if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) trimmed else "https://$trimmed"
            val withSlash = if (withScheme.endsWith("/")) withScheme else "$withScheme/"
            return withSlash.toHttpUrlOrNull()
        }
    }
}

/** A request body that streams from an InputStream and reports upload progress. */
class ProgressRequestBody(
    private val contentType: MediaType,
    private val length: Long,
    private val open: () -> InputStream,
    private val onProgress: (Float) -> Unit,
) : RequestBody() {
    override fun contentType(): MediaType = contentType

    override fun contentLength(): Long = length

    override fun writeTo(sink: BufferedSink) {
        open().source().use { source ->
            var written = 0L
            val buffer = okio.Buffer()
            while (true) {
                val read = source.read(buffer, 64 * 1024)
                if (read == -1L) break
                sink.write(buffer, read)
                written += read
                if (length > 0) onProgress((written.toFloat() / length).coerceIn(0f, 1f))
            }
        }
    }
}
