package com.notgooglephotos.photosync.net

import com.notgooglephotos.photosync.media.MediaGoneException
import com.notgooglephotos.photosync.media.OpenedMedia
import com.notgooglephotos.photosync.media.toHex
import com.notgooglephotos.photosync.model.ServerAddress
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.MediaType
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okio.BufferedSink
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.IOException
import java.security.MessageDigest
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * The server's sync API as the phone uses it. Every HTTP request the native side makes goes
 * through this class; endpoint paths, headers, and field names live only here.
 *
 *   GET  /api/health             reachability probe, no auth, short timeouts, no retries
 *   POST /api/devices/pair       JSON {code, deviceName, platform} -> {deviceToken, serverId?, deviceId?, user?}
 *   POST /api/assets/check       JSON {checksums: [sha1-hex]} -> {missing: [...], existing: [{checksum, assetId}]}
 *   POST /api/assets             multipart/form-data, streamed: metadata fields, then the `file` part
 *   GET  /api/memories/upcoming  {memories: [{id, title, subtitle?, date: yyyy-MM-dd, coverUrl?}]}
 */
class SyncApiClient internal constructor(
    val baseUrl: HttpUrl,
    private val deviceToken: String?,
    private val http: OkHttpClient,
    private val probeHttp: OkHttpClient,
    private val requests: AtomicInteger = AtomicInteger(),
) {
    /** Requests made through this client (and others sharing its counter), including ones that failed to connect. */
    val requestCount: Int get() = requests.get()

    suspend fun health(): HealthResult {
        val request = Request.Builder().url(endpoint(HEALTH)).get().build()
        return try {
            execute(probeHttp, request).use { response ->
                if (!response.isSuccessful) return HealthResult.Unhealthy(response.code)
                val json = response.body!!.string().toJsonObjectOrNull()
                HealthResult.Ok(serverId = json?.optNonBlank("serverId") ?: json?.optNonBlank("id"))
            }
        } catch (e: IOException) {
            HealthResult.Unreachable(e.message ?: e.javaClass.simpleName)
        }
    }

    /** Redeems a one-time pairing code (from the server's pairing QR code) for a device token. */
    suspend fun pair(code: String, deviceName: String): ApiResult<PairResult> {
        val payload = JSONObject().put("code", code).put("deviceName", deviceName).put("platform", PLATFORM).toString()
        val request = Request.Builder().url(endpoint(PAIR)).post(payload.toRequestBody(JSON)).build()
        return call(request, ::parsePair)
    }

    /** Sends checksums and learns which ones the server is missing. */
    suspend fun checkAssets(checksums: List<String>): ApiResult<CheckResult> {
        val payload = JSONObject().put("checksums", JSONArray(checksums)).toString()
        val request = authorized(endpoint(CHECK)).post(payload.toRequestBody(JSON)).build()
        return call(request) { body -> parseCheck(checksums, body) }
    }

    /** Streams one original to the server. The file is read once, hashed again on the way out. */
    suspend fun uploadAsset(upload: AssetUpload): UploadResult = withContext(Dispatchers.IO) {
        val opened = try {
            upload.open()
        } catch (e: MediaGoneException) {
            return@withContext UploadResult.Gone
        }
        val filePart = StreamingFileBody(opened, upload.mimeType.toMediaTypeOrNull(), upload.onProgress)
        val form = MultipartBody.Builder().setType(MultipartBody.FORM).apply {
            addFormDataPart("checksum", upload.checksum)
            addFormDataPart("filename", upload.fileName)
            addFormDataPart("capturedAt", isoTime(upload.capturedAtMs, upload.zone))
            addFormDataPart("modifiedAt", isoTime(upload.modifiedAtSec * 1000, upload.zone))
            addFormDataPart("mimeType", upload.mimeType)
            addFormDataPart("size", upload.size.toString())
            addFormDataPart("deviceAssetId", upload.deviceAssetId)
            addFormDataPart("folder", upload.folder)
            addFormDataPart("favorite", upload.favorite.toString())
            upload.versionOf?.let { addFormDataPart("versionOf", it) }
            addFormDataPart("file", upload.fileName, filePart)
        }.build()
        val request = authorized(endpoint(UPLOAD)).post(form).build()
        try {
            execute(http, request).use { response ->
                val text = response.body!!.string()
                when {
                    response.isSuccessful || response.code == 409 -> {
                        if (filePart.sha1Hex != null && filePart.sha1Hex != upload.checksum) {
                            UploadResult.LocalChanged("The file changed while it was uploading")
                        } else {
                            val json = text.toJsonObjectOrNull()
                            UploadResult.Stored(
                                assetId = json?.let(::assetIdOf),
                                duplicate = response.code == 409 || json?.optBoolean("duplicate", false) == true,
                            )
                        }
                    }
                    response.code == 401 || response.code == 403 -> UploadResult.Unauthorized
                    response.code == 408 || response.code == 429 || response.code >= 500 ->
                        UploadResult.ServerTrouble(response.code, errorMessage(response.code, text))
                    else -> UploadResult.Rejected(response.code, errorMessage(response.code, text))
                }
            }
        } catch (e: IOException) {
            val local = generateSequence<Throwable>(e) { it.cause }.filterIsInstance<LocalReadException>().firstOrNull()
            if (local != null) {
                UploadResult.LocalChanged(local.message ?: "The file couldn't be read")
            } else {
                UploadResult.ServerTrouble(null, e.message ?: e.javaClass.simpleName)
            }
        }
    }

    suspend fun upcomingMemories(): ApiResult<List<UpcomingMemory>> {
        val request = authorized(endpoint(MEMORIES_UPCOMING)).get().build()
        return call(request, ::parseMemories)
    }

    /** Downloads a memory cover. The device token is only sent to the server's own host. */
    suspend fun downloadCover(url: String, maxBytes: Long = 4L * 1024 * 1024): ByteArray? {
        val target = baseUrl.resolve(url) ?: return null
        val builder = if (target.host == baseUrl.host) authorized(target) else Request.Builder().url(target)
        return try {
            execute(http, builder.get().build()).use { response ->
                val body = response.body ?: return null
                val length = body.contentLength()
                if (!response.isSuccessful || length > maxBytes) return null
                body.source().use { source ->
                    source.request(maxBytes + 1)
                    if (source.buffer.size > maxBytes) null else source.buffer.readByteArray()
                }
            }
        } catch (e: IOException) {
            null
        }
    }

    private fun endpoint(path: String): HttpUrl = baseUrl.resolve(path) ?: error("Bad endpoint $path")

    private fun authorized(url: HttpUrl): Request.Builder = Request.Builder().url(url).apply {
        deviceToken?.let { header("Authorization", "Bearer $it") }
    }

    private suspend fun <T> call(request: Request, parse: (String) -> T): ApiResult<T> = try {
        execute(http, request).use { response ->
            val text = response.body!!.string()
            when {
                response.isSuccessful -> try {
                    ApiResult.Ok(parse(text))
                } catch (e: JSONException) {
                    ApiResult.HttpError(response.code, "Unexpected response: ${e.message}")
                }
                response.code == 401 || response.code == 403 -> ApiResult.Unauthorized
                else -> ApiResult.HttpError(response.code, errorMessage(response.code, text))
            }
        }
    } catch (e: IOException) {
        ApiResult.NetworkError(e.message ?: e.javaClass.simpleName)
    }

    private suspend fun execute(client: OkHttpClient, request: Request): Response {
        requests.incrementAndGet()
        return client.newCall(request).await()
    }

    companion object {
        const val HEALTH = "api/health"
        const val PAIR = "api/devices/pair"
        const val CHECK = "api/assets/check"
        const val UPLOAD = "api/assets"
        const val MEMORIES_UPCOMING = "api/memories/upcoming"

        /** Bulk check batch size; the server should accept at least this many checksums per request. */
        const val CHECK_BATCH = 200
        const val PLATFORM = "android"

        private val JSON: MediaType = "application/json; charset=utf-8".toMediaType()

        internal fun parsePair(body: String): PairResult {
            val json = JSONObject(body)
            val token = json.optNonBlank("deviceToken") ?: json.optNonBlank("token") ?: throw JSONException("no deviceToken")
            val user = json.optJSONObject("user")
            return PairResult(
                deviceToken = token,
                serverId = json.optNonBlank("serverId"),
                deviceId = json.optNonBlank("deviceId") ?: json.optJSONObject("device")?.optNonBlank("id"),
                userName = user?.let { it.optNonBlank("name") ?: it.optNonBlank("displayName") ?: it.optNonBlank("email") },
            )
        }

        internal fun isoTime(epochMs: Long, zone: ZoneId): String =
            DateTimeFormatter.ISO_OFFSET_DATE_TIME.format(Instant.ofEpochMilli(epochMs).atZone(zone).toOffsetDateTime())

        internal fun parseCheck(sent: List<String>, body: String): CheckResult {
            val json = JSONObject(body)
            val existing = mutableMapOf<String, String?>()
            val missing: Set<String>
            when {
                json.has("missing") -> {
                    missing = json.getJSONArray("missing").let { a -> (0 until a.length()).map { a.getString(it).lowercase() } }.toSet()
                    json.optJSONArray("existing")?.let { array ->
                        for (i in 0 until array.length()) {
                            val entry = array.optJSONObject(i) ?: continue
                            existing[entry.getString("checksum").lowercase()] = assetIdOf(entry)
                        }
                    }
                    sent.filter { it !in missing }.forEach { existing.putIfAbsent(it, null) }
                }
                json.has("results") -> {
                    val results = json.getJSONArray("results")
                    val found = mutableSetOf<String>()
                    for (i in 0 until results.length()) {
                        val entry = results.getJSONObject(i)
                        val checksum = entry.getString("checksum").lowercase()
                        if (entry.optBoolean("exists", false)) {
                            existing[checksum] = assetIdOf(entry)
                            found += checksum
                        }
                    }
                    missing = sent.filterNot { it in found }.toSet()
                }
                else -> throw JSONException("expected 'missing' or 'results'")
            }
            return CheckResult(missing = missing, existing = existing)
        }

        internal fun parseMemories(body: String): List<UpcomingMemory> {
            val trimmed = body.trim()
            val array = if (trimmed.startsWith("[")) JSONArray(trimmed) else JSONObject(trimmed).getJSONArray("memories")
            return (0 until array.length()).mapNotNull { i ->
                val entry = array.getJSONObject(i)
                val date = runCatching { LocalDate.parse(entry.getString("date").take(10)) }.getOrNull() ?: return@mapNotNull null
                UpcomingMemory(
                    id = entry.getString("id"),
                    title = entry.optNonBlank("title") ?: "On this day",
                    subtitle = entry.optNonBlank("subtitle"),
                    date = date,
                    coverUrl = entry.optNonBlank("coverUrl") ?: entry.optNonBlank("coverThumbnailUrl"),
                )
            }
        }

        private fun assetIdOf(json: JSONObject): String? =
            json.optNonBlank("assetId") ?: json.optNonBlank("id") ?: json.optJSONObject("asset")?.optNonBlank("id")

        private fun errorMessage(code: Int, body: String): String {
            val json = body.toJsonObjectOrNull()
            val message = json?.optNonBlank("message") ?: json?.optNonBlank("error") ?: body.take(200).ifBlank { null }
            return if (message != null) "HTTP $code: $message" else "HTTP $code"
        }
    }
}

/** Builds clients for a server address. */
class SyncApiFactory(userAgent: String) {
    private val base: OkHttpClient = OkHttpClient.Builder()
        // One request is one attempt: no silent re-sends of large uploads.
        .retryOnConnectionFailure(false)
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .addInterceptor { chain ->
            chain.proceed(chain.request().newBuilder().header("User-Agent", userAgent).header("Accept", "application/json").build())
        }
        .build()

    private val probe: OkHttpClient = base.newBuilder()
        .connectTimeout(PROBE_TIMEOUT_SEC, TimeUnit.SECONDS)
        .readTimeout(PROBE_TIMEOUT_SEC, TimeUnit.SECONDS)
        .writeTimeout(PROBE_TIMEOUT_SEC, TimeUnit.SECONDS)
        .callTimeout(PROBE_TIMEOUT_SEC + 2, TimeUnit.SECONDS)
        .build()

    /** [counter] is shared by every client a run creates, so the run can report its total request count. */
    fun create(address: String, deviceToken: String?, counter: AtomicInteger = AtomicInteger()): SyncApiClient =
        SyncApiClient(ServerAddress.baseUrl(address), deviceToken, base, probe, counter)

    companion object {
        const val PROBE_TIMEOUT_SEC = 3L
    }
}

sealed interface HealthResult {
    data class Ok(val serverId: String?) : HealthResult
    data class Unhealthy(val code: Int) : HealthResult
    data class Unreachable(val reason: String) : HealthResult
}

sealed interface ApiResult<out T> {
    data class Ok<T>(val value: T) : ApiResult<T>
    data object Unauthorized : ApiResult<Nothing>
    data class HttpError(val code: Int, val message: String) : ApiResult<Nothing>
    data class NetworkError(val message: String) : ApiResult<Nothing>
}

data class CheckResult(val missing: Set<String>, val existing: Map<String, String?>)

data class PairResult(val deviceToken: String, val serverId: String?, val deviceId: String?, val userName: String?)

data class UpcomingMemory(
    val id: String,
    val title: String,
    val subtitle: String?,
    val date: LocalDate,
    val coverUrl: String?,
)

class AssetUpload(
    val checksum: String,
    val fileName: String,
    val mimeType: String,
    val size: Long,
    val capturedAtMs: Long,
    val modifiedAtSec: Long,
    val zone: ZoneId,
    val deviceAssetId: String,
    val folder: String,
    val favorite: Boolean,
    val versionOf: String?,
    val open: () -> OpenedMedia,
    val onProgress: (sent: Long, total: Long) -> Unit,
)

sealed interface UploadResult {
    data class Stored(val assetId: String?, val duplicate: Boolean) : UploadResult
    /** The server refused this file for good (4xx other than auth); retrying won't help. */
    data class Rejected(val code: Int, val message: String) : UploadResult
    data object Unauthorized : UploadResult
    /** Network failure, timeout, or a 5xx/429 from the server: back off and try later. */
    data class ServerTrouble(val code: Int?, val message: String) : UploadResult
    /** The file changed or couldn't be read while uploading; hash it again next time. */
    data class LocalChanged(val message: String) : UploadResult
    data object Gone : UploadResult
}

internal class LocalReadException(message: String, cause: Throwable? = null) : IOException(message, cause)

/**
 * Streams a content URI into the request without buffering it, hashing as it goes. When the
 * length is known, it sends exactly that many bytes and fails if the file grew or shrank.
 */
internal class StreamingFileBody(
    private val opened: OpenedMedia,
    private val type: MediaType?,
    private val onProgress: (sent: Long, total: Long) -> Unit,
) : RequestBody() {
    /** SHA-1 of what was sent, once the whole file went out. */
    @Volatile var sha1Hex: String? = null
        private set

    override fun contentType(): MediaType? = type

    override fun contentLength(): Long = opened.length

    override fun isOneShot(): Boolean = true

    override fun writeTo(sink: BufferedSink) {
        val digest = MessageDigest.getInstance("SHA-1")
        val buffer = ByteArray(64 * 1024)
        val expected = opened.length
        var sent = 0L
        var lastReport = 0L
        opened.stream.use { input ->
            while (expected < 0 || sent < expected) {
                val want = if (expected < 0) buffer.size else minOf(buffer.size.toLong(), expected - sent).toInt()
                val read = try {
                    input.read(buffer, 0, want)
                } catch (e: IOException) {
                    throw LocalReadException("Reading the file failed: ${e.message}", e)
                }
                if (read < 0) {
                    if (expected >= 0) throw LocalReadException("The file got shorter while uploading")
                    break
                }
                digest.update(buffer, 0, read)
                sink.write(buffer, 0, read)
                sent += read
                if (sent - lastReport >= PROGRESS_STEP || sent == expected) {
                    lastReport = sent
                    onProgress(sent, expected)
                }
            }
            if (expected >= 0 && input.read() != -1) throw LocalReadException("The file grew while uploading")
        }
        onProgress(sent, if (expected >= 0) expected else sent)
        sha1Hex = digest.digest().toHex()
    }

    private companion object {
        const val PROGRESS_STEP = 256L * 1024
    }
}

internal suspend fun Call.await(): Response = suspendCancellableCoroutine { continuation ->
    continuation.invokeOnCancellation { cancel() }
    enqueue(
        object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                if (!continuation.isCancelled) continuation.resumeWithException(e)
            }

            override fun onResponse(call: Call, response: Response) {
                continuation.resume(response) { _, value, _ -> value.close() }
            }
        },
    )
}

private fun String.toJsonObjectOrNull(): JSONObject? = try {
    JSONObject(this)
} catch (e: JSONException) {
    null
}

private fun JSONObject.optNonBlank(key: String): String? =
    if (!has(key) || isNull(key)) null else optString(key).takeIf { it.isNotBlank() }
