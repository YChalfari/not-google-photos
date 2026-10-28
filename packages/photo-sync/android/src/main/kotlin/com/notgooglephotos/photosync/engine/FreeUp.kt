package com.notgooglephotos.photosync.engine

import com.notgooglephotos.photosync.model.SyncSettings
import com.notgooglephotos.photosync.model.strings
import com.notgooglephotos.photosync.net.ApiResult
import com.notgooglephotos.photosync.net.ServerResolver
import com.notgooglephotos.photosync.net.SyncApiClient
import com.notgooglephotos.photosync.queue.ItemState
import com.notgooglephotos.photosync.queue.MediaItemEntity
import com.notgooglephotos.photosync.queue.MediaKind
import com.notgooglephotos.photosync.queue.SyncDatabase
import com.notgooglephotos.photosync.settings.SettingsStore
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicInteger

/** The person asked to delete phone copies. Nothing is deleted when this is thrown. */
class FreeUpRejected(message: String) : Exception(message)

enum class FreeUpMediaType { ALL, PHOTOS, VIDEOS }

data class FreeUpFilter(
    val olderThanDays: Int?,
    val keepFavorites: Boolean,
    val mediaType: FreeUpMediaType,
    /** Null means every folder. An empty list matches nothing. */
    val folders: List<String>?,
) {
    companion object {
        fun parse(json: JSONObject): FreeUpFilter {
            val days = when (val raw = if (json.has("olderThanDays")) json.get("olderThanDays") else null) {
                null, JSONObject.NULL -> null
                is Number -> raw.toInt()
                else -> throw FreeUpRejected("olderThanDays must be a number")
            }
            if (days != null && days < 0) throw FreeUpRejected("olderThanDays can't be negative")
            val type = when (json.optString("mediaType", "all")) {
                "", "all" -> FreeUpMediaType.ALL
                "photos" -> FreeUpMediaType.PHOTOS
                "videos" -> FreeUpMediaType.VIDEOS
                else -> throw FreeUpRejected("mediaType must be all, photos, or videos")
            }
            val keepFavorites = if (json.has("keepFavorites") && !json.isNull("keepFavorites")) {
                json.getBoolean("keepFavorites")
            } else {
                true
            }
            val folders = if (json.has("folders") && !json.isNull("folders")) {
                SyncSettings.normalizeFolders(json.getJSONArray("folders").strings())
            } else {
                null
            }
            return FreeUpFilter(days, keepFavorites, type, folders)
        }
    }
}

data class FreeableSummary(val count: Int, val bytes: Long, val photos: Int, val videos: Int)

data class DeletionTarget(val id: Long, val uri: String, val bytes: Long)

data class DeletionPlan(val targets: List<DeletionTarget>, val skippedUnverified: Int)

/**
 * Decides which backed-up files may leave the phone. The server is asked again before anything
 * is counted, and a file the server does not have is left on the phone.
 */
class FreeUp(
    private val db: SyncDatabase,
    private val store: SettingsStore,
    private val conditions: DeviceConditions,
    private val resolver: ServerResolver,
    private val clock: Clock,
) {
    suspend fun summarize(filter: FreeUpFilter): FreeableSummary = FreeUpRules.summarize(confirm(filter).items)

    suspend fun prepare(filter: FreeUpFilter): DeletionPlan {
        val confirmed = confirm(filter)
        return DeletionPlan(
            targets = confirmed.items.map { DeletionTarget(it.id, it.uri, it.size) },
            skippedUnverified = confirmed.skipped,
        )
    }

    private suspend fun confirm(filter: FreeUpFilter): Confirmed {
        val rows = FreeUpRules.select(db.media().backedUpPresent(), filter, clock.now())
        if (rows.isEmpty()) return Confirmed(emptyList(), 0)
        val addressable = rows.filter { it.uri.startsWith("content://media/") }
        val skippedUri = rows.size - addressable.size
        if (addressable.isEmpty()) return Confirmed(emptyList(), skippedUri)

        val token = store.deviceToken?.takeIf { it.isNotBlank() }
            ?: throw FreeUpRejected("Pair this phone first. Nothing was deleted.")
        if (!store.settings.hasServer) throw FreeUpRejected("Pair this phone first. Nothing was deleted.")
        val network = conditions.network()
        if (!network.connected) throw FreeUpRejected("The phone is offline, so nothing was deleted.")
        val settings = store.settings
        val found = when (val result = resolver.resolve(settings, token, network, AtomicInteger())) {
            is ServerResolver.Result.Unreachable ->
                throw FreeUpRejected("The server didn't answer, so nothing was deleted.")
            is ServerResolver.Result.Reachable -> result
        }
        if (found.movedHome != null || (found.serverId != null && settings.serverId == null)) {
            store.updateSettings { current ->
                current.copy(
                    homeUrl = found.movedHome ?: current.homeUrl,
                    serverId = current.serverId ?: found.serverId,
                )
            }
        }
        val present = mutableSetOf<String>()
        val checksums = addressable.map { it.checksum!!.lowercase() }.distinct()
        for (batch in checksums.chunked(SyncApiClient.CHECK_BATCH)) {
            when (val result = found.client.checkAssets(batch)) {
                is ApiResult.Ok -> present += result.value.existing.keys.map { it.lowercase() }
                ApiResult.Unauthorized -> throw FreeUpRejected("Pair this phone again. Nothing was deleted.")
                is ApiResult.HttpError, is ApiResult.NetworkError ->
                    throw FreeUpRejected("The server didn't confirm these photos, so nothing was deleted.")
            }
        }
        val kept = addressable.filter { it.checksum!!.lowercase() in present }
        return Confirmed(kept, addressable.size - kept.size + skippedUri)
    }

    private data class Confirmed(val items: List<MediaItemEntity>, val skipped: Int)
}

internal object FreeUpRules {
    const val DAY_MS = 86_400_000L
    const val DELETE_BATCH = 400

    fun select(items: List<MediaItemEntity>, filter: FreeUpFilter, nowMs: Long): List<MediaItemEntity> =
        items.filter { matches(it, filter, nowMs) }

    fun summarize(items: List<MediaItemEntity>): FreeableSummary {
        var bytes = 0L
        var photos = 0
        var videos = 0
        for (item in items) {
            bytes += item.size
            if (item.kind == MediaKind.VIDEO) videos++ else photos++
        }
        return FreeableSummary(items.size, bytes, photos, videos)
    }

    private fun matches(item: MediaItemEntity, filter: FreeUpFilter, nowMs: Long): Boolean {
        if (!item.present || item.state != ItemState.BACKED_UP || item.checksum.isNullOrBlank()) return false
        if (filter.keepFavorites && item.favorite) return false
        when (filter.mediaType) {
            FreeUpMediaType.PHOTOS -> if (item.kind != MediaKind.IMAGE) return false
            FreeUpMediaType.VIDEOS -> if (item.kind != MediaKind.VIDEO) return false
            FreeUpMediaType.ALL -> Unit
        }
        val days = filter.olderThanDays
        if (days != null && days > 0 && item.captureTime > nowMs - days * DAY_MS) return false
        val folders = filter.folders
        if (folders != null && !SyncSettings.isSelected(item.relativePath, folders)) return false
        return true
    }
}
