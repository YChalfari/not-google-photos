package com.notgooglephotos.photosync

import android.content.Context
import com.notgooglephotos.photosync.engine.Clock
import com.notgooglephotos.photosync.engine.DeviceConditions
import com.notgooglephotos.photosync.engine.FollowUps
import com.notgooglephotos.photosync.engine.NetworkState
import com.notgooglephotos.photosync.engine.RunOptions
import com.notgooglephotos.photosync.engine.RunReport
import com.notgooglephotos.photosync.engine.RunTrigger
import com.notgooglephotos.photosync.engine.SyncEngine
import com.notgooglephotos.photosync.media.FolderInfo
import com.notgooglephotos.photosync.media.MediaGoneException
import com.notgooglephotos.photosync.media.MediaLibrary
import com.notgooglephotos.photosync.media.OpenedMedia
import com.notgooglephotos.photosync.media.ScannedMedia
import com.notgooglephotos.photosync.media.VolumeInfo
import com.notgooglephotos.photosync.model.SyncSettings
import com.notgooglephotos.photosync.net.DiscoveredServer
import com.notgooglephotos.photosync.net.ServerDiscovery
import com.notgooglephotos.photosync.net.ServerResolver
import com.notgooglephotos.photosync.net.SyncApiFactory
import com.notgooglephotos.photosync.queue.MediaKind
import com.notgooglephotos.photosync.queue.SyncDatabase
import com.notgooglephotos.photosync.settings.PlainTokenCipher
import com.notgooglephotos.photosync.settings.SettingsStore
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.MultipartReader
import okio.Buffer
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.time.LocalTime
import java.time.ZoneId

class FakeClock(var nowMs: Long = 1_700_000_000_000L, var zoneId: ZoneId = ZoneId.of("UTC")) : Clock {
    override fun now(): Long = nowMs
    override fun zone(): ZoneId = zoneId
}

class FakeConditions(
    var network: NetworkState = NetworkState(connected = true, unmetered = true, local = true),
    var charging: Boolean = true,
) : DeviceConditions {
    override fun network(): NetworkState = network
    override fun isCharging(): Boolean = charging
}

class RecordingFollowUps : FollowUps {
    val events = mutableListOf<String>()
    override fun whenOnline(unmetered: Boolean) { events += if (unmetered) "wifi" else "online" }
    override fun whenCharging() { events += "charging" }
    override fun ensureFirstBackup() { events += "firstBackup" }
    override fun retryAfterBackoff(atMs: Long) { events += "backoff:$atMs" }
    override fun cancelBackoffRetry() { events += "cancelBackoff" }
}

class FakeDiscovery(var servers: List<DiscoveredServer> = emptyList()) : ServerDiscovery {
    var calls = 0
    override suspend fun discover(timeoutMs: Long, enough: (DiscoveredServer) -> Boolean): List<DiscoveredServer> {
        calls++
        return servers
    }
}

class FakeLibrary : MediaLibrary {
    var readAccess = true
    var locationAccess = false
    var versionName = "v1"
    /** Current MediaStore generation. Null reproduces Android 10 (no generations). */
    var generation: Long? = 0
    var opens = 0
    var queryCalls = 0
    var lastSinceGeneration: Long? = null
    var lastSinceSeconds: Long? = null
    val sinceGenerations = mutableListOf<Long?>()

    /** The open after this many successful opens throws [MediaGoneException]. */
    var goneAfterOpens: Int = Int.MAX_VALUE

    /** URIs whose upload stream is longer than the declared size. */
    val grows = mutableSetOf<String>()

    private val items = mutableListOf<Entry>()
    private var nextId = 1L

    data class Entry(val media: ScannedMedia, val generation: Long, val bytes: ByteArray)

    fun add(
        name: String,
        bytes: ByteArray,
        folder: String = "DCIM/Camera/",
        kind: MediaKind = MediaKind.IMAGE,
        captureTime: Long,
        dateAdded: Long,
        dateModified: Long = dateAdded,
        favorite: Boolean = false,
        volume: String = VOLUME,
        mimeType: String? = null,
    ): ScannedMedia {
        val id = nextId++
        val media = ScannedMedia(
            volume = volume,
            mediaId = id,
            uri = "content://fake/$volume/$id",
            kind = kind,
            mimeType = mimeType ?: if (kind == MediaKind.VIDEO) "video/mp4" else "image/jpeg",
            displayName = name,
            relativePath = folder,
            size = bytes.size.toLong(),
            captureTime = captureTime,
            dateAdded = dateAdded,
            dateModified = dateModified,
            favorite = favorite,
        )
        items += Entry(media, generation ?: 0, bytes)
        return media
    }

    fun edit(uri: String, bytes: ByteArray) {
        generation = (generation ?: 0) + 1
        val index = items.indexOfFirst { it.media.uri == uri }
        val old = items[index]
        items[index] = Entry(
            old.media.copy(size = bytes.size.toLong(), dateModified = old.media.dateModified + 5),
            generation ?: 0,
            bytes,
        )
    }

    fun remove(uri: String) {
        items.removeAll { it.media.uri == uri }
    }

    fun clear() {
        items.clear()
    }

    override fun hasReadAccess(): Boolean = readAccess
    override fun hasLocationAccess(): Boolean = locationAccess

    override fun volumes(): List<VolumeInfo> = listOf(VolumeInfo(VOLUME, versionName, generation))

    override fun query(
        volume: String,
        kinds: Set<MediaKind>,
        folders: List<String>,
        sinceGeneration: Long?,
        sinceSeconds: Long?,
    ): List<ScannedMedia> {
        queryCalls++
        lastSinceGeneration = sinceGeneration
        lastSinceSeconds = sinceSeconds
        sinceGenerations += sinceGeneration
        return items.filter { entry ->
            entry.media.volume == volume &&
                entry.media.kind in kinds &&
                com.notgooglephotos.photosync.model.SyncSettings.isSelected(entry.media.relativePath, folders) &&
                when {
                    sinceGeneration != null -> entry.generation > sinceGeneration
                    sinceSeconds != null -> entry.media.dateAdded >= sinceSeconds || entry.media.dateModified >= sinceSeconds
                    else -> true
                }
        }.map { it.media }
    }

    override fun queryAllImages(volume: String, sinceGeneration: Long?, sinceSeconds: Long?): List<ScannedMedia> {
        queryCalls++
        lastSinceGeneration = sinceGeneration
        lastSinceSeconds = sinceSeconds
        sinceGenerations += sinceGeneration
        return items.filter { entry ->
            entry.media.volume == volume &&
                entry.media.kind == MediaKind.IMAGE &&
                when {
                    sinceGeneration != null -> entry.generation > sinceGeneration
                    sinceSeconds != null -> entry.media.dateAdded >= sinceSeconds || entry.media.dateModified >= sinceSeconds
                    else -> true
                }
        }.map { it.media }
    }

    override fun listFolders(): List<FolderInfo> = items
        .groupBy { it.media.relativePath }
        .map { (path, rows) -> FolderInfo(path, path.trim('/').substringAfterLast('/'), rows.size) }

    override fun openOriginal(uri: String): OpenedMedia {
        opens++
        if (opens > goneAfterOpens) throw MediaGoneException("gone")
        val entry = items.firstOrNull { it.media.uri == uri } ?: throw MediaGoneException("gone")
        val payload = if (uri in grows) entry.bytes + byteArrayOf(1) else entry.bytes
        return OpenedMedia(ByteArrayInputStream(payload), entry.bytes.size.toLong(), locationRedacted = !locationAccess)
    }

    companion object {
        const val VOLUME = "external_primary"
    }
}

/** A stand-in server: health, bulk check, streamed upload, pairing, and upcoming memories. */
class FakeSyncServer {
    val uploads = mutableListOf<Upload>()
    var healths = 0
    var checks = 0
    var pairs = 0
    var unauthorized = false
    var failUploads = 0
    val rejectNames = mutableSetOf<String>()
    var serverId = "srv-1"
    var memoriesBody = """{"memories":[]}"""
    var cover = ByteArray(8) { it.toByte() }
    var pairToken = "paired-token"
    var lastPairBody: String? = null

    data class Upload(
        val checksum: String,
        val fileName: String,
        val bytes: ByteArray,
        val versionOf: String?,
        val deviceAssetId: String,
        val folder: String,
        val favorite: String,
        val intake: String,
    )

    private val known = linkedMapOf<String, String>()
    private val intakeOf = mutableMapOf<String, String>()
    private val rejected = mutableSetOf<String>()
    private val http = MockWebServer()
    private var started = false

    fun baseUrl(): String = http.url("/").toString().trimEnd('/')
    fun port(): Int = http.port

    fun start() {
        if (started) return
        http.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = handle(request)
        }
        http.start()
        started = true
    }

    fun shutdown() {
        if (!started) return
        started = false
        http.shutdown()
    }

    fun assetId(checksum: String): String = "asset-${checksum.take(12)}"

    /** Pretend this checksum was uploaded in an earlier install. */
    fun remember(checksum: String) {
        known[checksum] = assetId(checksum)
        intakeOf[checksum] = "library"
        rejected.remove(checksum)
    }

    /** The owner said no. The next check reports the checksum as rejected. */
    fun reject(checksum: String) {
        known.remove(checksum)
        intakeOf.remove(checksum)
        rejected += checksum
    }

    private fun handle(request: RecordedRequest): MockResponse {
        val path = request.path ?: ""
        if (path.endsWith("/api/health")) {
            healths++
            return json(200, """{"ok":true,"serverId":"$serverId"}""")
        }
        if (unauthorized && request.method != "GET") return json(401, """{"message":"Pair this phone again"}""")
        return when {
            path.endsWith("/api/devices/pair") -> {
                pairs++
                val raw = request.body.readUtf8()
                lastPairBody = raw
                val code = JSONObject(raw).optString("code")
                if (code.isBlank()) json(400, """{"message":"Missing code"}""")
                else json(200, """{"deviceToken":"$pairToken","deviceId":"dev-1","user":{"name":"Ada"},"server":{"serverId":"$serverId","name":"Home","homeUrl":null,"remoteUrl":null}}""")
            }
            path.endsWith("/api/assets/check") -> json(200, checkBody(JSONObject(request.body.readUtf8())))
            path.endsWith("/api/assets") -> upload(request)
            path.endsWith("/api/memories/upcoming") -> json(200, memoriesBody)
            path.contains("/covers/") -> bytes(200, cover, "image/jpeg")
            else -> json(404, """{"message":"No such route $path"}""")
        }
    }

    private fun checkBody(json: JSONObject): String {
        checks++
        val sent = json.getJSONArray("checksums")
        val checksums = (0 until sent.length()).map { sent.getString(it) }
        val missing = checksums.filter { it !in known && it !in rejected }
        val present = checksums.filter { it in known && intakeOf[it] != "review" }.joinToString(",") {
            """{"checksum":"$it","assetId":"${known.getValue(it)}"}"""
        }
        val held = checksums.filter { it in known && intakeOf[it] == "review" }.joinToString(",") {
            """{"checksum":"$it","assetId":"${known.getValue(it)}"}"""
        }
        val refused = checksums.filter { it in rejected }.joinToString(",") { "\"$it\"" }
        return """{"missing":[${missing.joinToString { "\"$it\"" }}],"present":[$present],"held":[$held],"rejected":[$refused]}"""
    }

    private fun upload(request: RecordedRequest): MockResponse {
        val type = request.getHeader("Content-Type") ?: return json(400, """{"message":"Expected multipart"}""")
        val boundary = type.substringAfter("boundary=", "").trim().removePrefix("\"").substringBefore(";")
        val fields = linkedMapOf<String, String>()
        var file: ByteArray? = null
        MultipartReader(request.body, boundary).use { reader ->
            while (true) {
                val part = reader.nextPart() ?: break
                val disposition = part.headers["Content-Disposition"].orEmpty()
                val name = disposition.substringAfter("name=\"", "").substringBefore("\"")
                val bytes = part.body.readByteArray()
                if (name == "file") file = bytes else fields[name] = bytes.toString(Charsets.UTF_8)
                part.close()
            }
        }
        val checksum = fields["checksum"] ?: return json(400, """{"message":"Missing checksum"}""")
        val upload = Upload(
            checksum = checksum,
            fileName = fields["filename"] ?: "file",
            bytes = file ?: ByteArray(0),
            versionOf = fields["versionOf"],
            deviceAssetId = fields["deviceAssetId"] ?: "",
            folder = fields["folder"] ?: "",
            favorite = fields["favorite"] ?: "false",
            intake = fields["intake"] ?: "library",
        )
        val code = when {
            upload.fileName in rejectNames -> 400
            failUploads > 0 -> {
                failUploads--
                500
            }
            else -> {
                uploads += upload
                known[checksum] = assetId(checksum)
                intakeOf[checksum] = upload.intake
                200
            }
        }
        val message = if (code == 200) {
            """{"assetId":"${assetId(checksum)}","status":"created","intake":"${upload.intake}"}"""
        } else {
            """{"message":"Upload failed"}"""
        }
        return json(code, message)
    }

    private fun json(code: Int, body: String): MockResponse =
        MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body)

    private fun bytes(code: Int, body: ByteArray, type: String): MockResponse =
        MockResponse().setResponseCode(code).setHeader("Content-Type", type).setBody(Buffer().write(body))
}

/**
 * The socket half of [FakeSyncServer], kept separate so the OkHttp mock types stay in one place
 * and the engine tests read a small result list.
 */
class EngineFixture(context: Context) {
    val clock = FakeClock()
    val conditions = FakeConditions()
    val library = FakeLibrary()
    val follow = RecordingFollowUps()
    val discovery = FakeDiscovery()
    val server = FakeSyncServer()
    val store = SettingsStore(context, PlainTokenCipher())
    val db: SyncDatabase = SyncDatabase.inMemory(context)
    val resolver: ServerResolver
    val engine: SyncEngine

    init {
        context.getSharedPreferences(SettingsStore.FILE, Context.MODE_PRIVATE).edit().clear().commit()
        val factory = SyncApiFactory("NGP-test")
        resolver = ServerResolver(factory, discovery)
        engine = SyncEngine(db, store, library, conditions, resolver, follow, clock)
    }

    fun start() {
        server.start()
        store.settings = SyncSettings(
            homeUrl = server.baseUrl(),
            wifiOnly = true,
            includeVideos = true,
            videosOnlyWhileCharging = true,
            reminderTime = LocalTime.of(21, 0),
            unreachableNudgeDays = 3,
        )
        store.deviceToken = "device-token"
        store.firstBackupComplete = true
        store.configuredAt = clock.nowMs
    }

    fun add(
        name: String,
        bytes: ByteArray = "bytes-$name".toByteArray(),
        folder: String = "DCIM/Camera/",
        kind: MediaKind = MediaKind.IMAGE,
        captureTime: Long = clock.nowMs,
        dateAdded: Long = clock.nowMs / 1000,
        favorite: Boolean = false,
        mimeType: String? = null,
    ): ScannedMedia = library.add(name, bytes, folder, kind, captureTime, dateAdded, favorite = favorite, mimeType = mimeType)

    fun run(trigger: RunTrigger, options: RunOptions = RunOptions()): RunReport = runBlocking { engine.run(trigger, options) }

    fun rows() = runBlocking { db.media().all() }

    fun close() {
        server.shutdown()
        db.close()
    }
}
