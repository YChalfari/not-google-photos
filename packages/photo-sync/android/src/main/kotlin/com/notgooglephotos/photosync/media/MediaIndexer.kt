package com.notgooglephotos.photosync.media

import com.notgooglephotos.photosync.engine.Clock
import com.notgooglephotos.photosync.model.SyncSettings
import com.notgooglephotos.photosync.queue.MediaKind
import com.notgooglephotos.photosync.queue.ScanStateEntity
import com.notgooglephotos.photosync.queue.SyncDatabase
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import java.security.MessageDigest

data class ScanSummary(val added: Int, val changed: Int, val fullScans: Int)

/**
 * Brings the queue up to date with MediaStore. Normal scans only read rows whose generation moved
 * since the last scan of that volume; a full scan (daily reconcile, new folder selection, or a
 * MediaStore version change) reads everything and drops rows that are gone.
 */
class MediaIndexer(
    private val library: MediaLibrary,
    private val db: SyncDatabase,
    private val clock: Clock,
) {
    /** New rows added to the phone before [backlogCutoffMs] are marked as first-backup backlog. */
    suspend fun scan(settings: SyncSettings, full: Boolean, backlogCutoffMs: Long?): ScanSummary = withContext(Dispatchers.IO) {
        val backlogBeforeSec = backlogCutoffMs?.let { it / 1000 } ?: Long.MIN_VALUE
        val kinds = if (settings.includeVideos) setOf(MediaKind.IMAGE, MediaKind.VIDEO) else setOf(MediaKind.IMAGE)
        var added = 0
        var changed = 0
        var fullScans = 0
        for (volume in library.volumes()) {
            val previous = db.scanState().get(volume.name)
            // "Gone" is last_seen_scan < this stamp. Scans in the same millisecond, or under a
            // clock that did not move, still need a new stamp or deleted files look present.
            val stamp = previous?.scannedAt?.let { last -> maxOf(clock.now(), last + 1) } ?: clock.now()
            val canResume = !full &&
                previous != null &&
                previous.version == volume.version &&
                previous.selection == settings.selectionKey &&
                (volume.generation == null || previous.generation != null)
            val sinceGeneration = if (canResume && volume.generation != null) previous?.generation else null
            // Without generations (Android 10), re-read anything added or modified since the last scan began.
            val sinceSeconds = if (canResume && volume.generation == null) previous?.scannedAt?.let { it / 1000 - 2 } else null
            val rows = library.query(volume.name, kinds, settings.folders, sinceGeneration, sinceSeconds)
            for (batch in rows.chunked(BATCH_SIZE)) {
                val counts = db.media().upsertScanned(batch, stamp, clock.now(), backlogBeforeSec)
                added += counts.added
                changed += counts.changed
            }
            if (!canResume) {
                db.media().removeUnseen(volume.name, stamp)
                fullScans++
            }
            db.scanState().put(ScanStateEntity(volume.name, volume.version, volume.generation, stamp, settings.selectionKey))
        }
        ScanSummary(added, changed, fullScans)
    }

    private companion object {
        const val BATCH_SIZE = 400
    }
}

/** Hashes originals with SHA-1. The queue caches the result, so each file is hashed once. */
class Hasher(private val library: MediaLibrary) {
    data class Result(val sha1: String, val bytes: Long, val locationRedacted: Boolean)

    suspend fun sha1(uri: String): Result = withContext(Dispatchers.IO) {
        val opened = library.openOriginal(uri)
        opened.stream.use { input ->
            val digest = MessageDigest.getInstance("SHA-1")
            val buffer = ByteArray(256 * 1024)
            var total = 0L
            while (true) {
                ensureActive()
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
                total += read
            }
            Result(digest.digest().toHex(), total, opened.locationRedacted)
        }
    }
}

fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }
