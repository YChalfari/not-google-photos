package com.notgooglephotos.photosync.queue

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import androidx.room.Update
import com.notgooglephotos.photosync.media.ScannedMedia

data class UpsertCounts(val added: Int, val changed: Int)

@Dao
abstract class MediaDao {
    @Insert(onConflict = OnConflictStrategy.ABORT)
    protected abstract suspend fun insert(item: MediaItemEntity): Long

    @Update
    protected abstract suspend fun update(item: MediaItemEntity)

    @Query("SELECT * FROM media_items WHERE volume = :volume AND media_id IN (:mediaIds)")
    protected abstract suspend fun findByMediaIds(volume: String, mediaIds: List<Long>): List<MediaItemEntity>

    @Query("UPDATE media_items SET last_seen_scan = :scanStamp, present = 1 WHERE id IN (:ids)")
    protected abstract suspend fun touch(ids: List<Long>, scanStamp: Long)

    /**
     * Records one batch of scanner rows (all from the same volume). New files become pending, and
     * those added to the phone before [backlogBeforeSec] are marked as first-backup backlog.
     * A file whose size or modification time changed is hashed again; if it was already backed up,
     * it uploads as a new version linked to the original asset.
     */
    @Transaction
    open suspend fun upsertScanned(batch: List<ScannedMedia>, scanStamp: Long, now: Long, backlogBeforeSec: Long): UpsertCounts {
        if (batch.isEmpty()) return UpsertCounts(0, 0)
        val existing = findByMediaIds(batch.first().volume, batch.map { it.mediaId }).associateBy { it.mediaId }
        var added = 0
        var changed = 0
        val untouched = mutableListOf<Long>()
        for (media in batch) {
            val row = existing[media.mediaId]
            when {
                row == null -> {
                    insert(media.toNewEntity(now, scanStamp, backlog = media.dateAdded < backlogBeforeSec))
                    added++
                }
                row.size != media.size || row.dateModified != media.dateModified -> {
                    val wasBackedUp = row.state == ItemState.BACKED_UP
                    update(
                        row.withMetadata(media, scanStamp).copy(
                            size = media.size,
                            dateModified = media.dateModified,
                            // An edit is new activity, so it never waits for the first full backup.
                            backlog = false,
                            state = ItemState.PENDING,
                            attempts = 0,
                            lastError = null,
                            serverAssetId = if (wasBackedUp) null else row.serverAssetId,
                            versionOf = if (wasBackedUp) row.serverAssetId else row.versionOf,
                        ),
                    )
                    changed++
                }
                row.hasSameMetadata(media) && row.present -> untouched += row.id
                else -> update(row.withMetadata(media, scanStamp))
            }
        }
        untouched.chunked(500).forEach { touch(it, scanStamp) }
        return UpsertCounts(added, changed)
    }

    /** After a full scan: forget pending rows that are gone; keep backed-up rows as history. */
    @Transaction
    open suspend fun removeUnseen(volume: String, scanStamp: Long) {
        deleteUnseenNotBackedUp(volume, scanStamp)
        hideUnseenBackedUp(volume, scanStamp)
    }

    @Query("DELETE FROM media_items WHERE volume = :volume AND last_seen_scan < :scanStamp AND state != 'BACKED_UP'")
    protected abstract suspend fun deleteUnseenNotBackedUp(volume: String, scanStamp: Long)

    @Query("UPDATE media_items SET present = 0 WHERE volume = :volume AND last_seen_scan < :scanStamp AND state = 'BACKED_UP'")
    protected abstract suspend fun hideUnseenBackedUp(volume: String, scanStamp: Long)

    /**
     * One page of pending items, newest first, strictly after the (capture_time, id) keyset cursor,
     * so items that stay pending during a run are never picked twice.
     */
    @Query(
        """
        SELECT * FROM media_items
        WHERE present = 1 AND state = 'PENDING'
          AND (:includeVideos OR kind = 'IMAGE')
          AND (:includeBacklog OR backlog = 0)
          AND (capture_time < :beforeCapture OR (capture_time = :beforeCapture AND id < :beforeId))
        ORDER BY capture_time DESC, id DESC
        LIMIT :limit
        """,
    )
    abstract suspend fun pendingCandidates(
        includeVideos: Boolean,
        includeBacklog: Boolean,
        beforeCapture: Long,
        beforeId: Long,
        limit: Int,
    ): List<MediaItemEntity>

    @Query(
        """
        SELECT COUNT(*) FROM media_items
        WHERE present = 1 AND state = 'PENDING' AND (:includeVideos OR kind = 'IMAGE') AND (:includeBacklog OR backlog = 0)
        """,
    )
    abstract suspend fun eligiblePending(includeVideos: Boolean, includeBacklog: Boolean): Int

    @Query("SELECT kind, backlog, COUNT(*) AS count FROM media_items WHERE present = 1 AND state = 'PENDING' GROUP BY kind, backlog")
    abstract suspend fun pendingBreakdown(): List<PendingCount>

    @Query("SELECT state, COUNT(*) AS count FROM media_items WHERE present = 1 GROUP BY state")
    abstract suspend fun countsByState(): List<StateCount>

    @Query(
        """
        SELECT kind, COUNT(*) AS count FROM media_items
        WHERE present = 1 AND state != 'BACKED_UP' AND capture_time >= :startMs AND capture_time < :endMs
        GROUP BY kind
        """,
    )
    abstract suspend fun notBackedUpBetween(startMs: Long, endMs: Long): List<KindCount>

    @Query("SELECT COUNT(*) FROM media_items WHERE present = 1 AND backlog = 1 AND state IN ('PENDING', 'UPLOADING')")
    abstract suspend fun backlogRemaining(): Int

    @Query("SELECT * FROM media_items WHERE id = :id")
    abstract suspend fun get(id: Long): MediaItemEntity?

    @Query("SELECT * FROM media_items ORDER BY id")
    abstract suspend fun all(): List<MediaItemEntity>

    @Query("UPDATE media_items SET state = 'UPLOADING' WHERE id = :id")
    abstract suspend fun markUploading(id: Long)

    @Query("UPDATE media_items SET state = 'PENDING' WHERE state = 'UPLOADING'")
    abstract suspend fun resetInterruptedUploads(): Int

    @Query(
        """
        UPDATE media_items SET state = 'BACKED_UP', server_asset_id = :assetId, backed_up_at = :now, attempts = 0, last_error = NULL
        WHERE id IN (:ids)
        """,
    )
    abstract suspend fun markBackedUp(ids: List<Long>, assetId: String?, now: Long)

    /** The file was "changed" but hashes the same as before (only its timestamp moved): it's still backed up. */
    @Query(
        """
        UPDATE media_items SET state = 'BACKED_UP', server_asset_id = version_of, version_of = NULL, attempts = 0, last_error = NULL
        WHERE id = :id
        """,
    )
    abstract suspend fun restoreUnchanged(id: Long)

    @Query("UPDATE media_items SET state = 'PENDING', attempts = :attempts, last_error = :error WHERE id = :id")
    abstract suspend fun deferRetry(id: Long, attempts: Int, error: String?)

    @Query("UPDATE media_items SET state = 'FAILED', attempts = :attempts, last_error = :error WHERE id = :id")
    abstract suspend fun markFailed(id: Long, attempts: Int, error: String?)

    @Query("UPDATE media_items SET state = 'PENDING', attempts = 0, last_error = NULL WHERE state = 'FAILED'")
    abstract suspend fun resetFailed(): Int

    @Query(
        """
        UPDATE media_items SET checksum = :checksum, hashed_size = :size, hashed_modified = :modified, location_redacted = :redacted
        WHERE id = :id
        """,
    )
    abstract suspend fun setChecksum(id: Long, checksum: String, size: Long, modified: Long, redacted: Boolean)

    /** The file changed under us; it gets hashed again on its next turn. */
    @Query(
        """
        UPDATE media_items SET hashed_size = NULL, hashed_modified = NULL, state = 'PENDING', attempts = :attempts, last_error = :error
        WHERE id = :id
        """,
    )
    abstract suspend fun invalidateChecksum(id: Long, attempts: Int, error: String?)

    /** A different server: nothing is known to be backed up there, so the bulk check starts over. */
    @Query(
        """
        UPDATE media_items SET state = 'PENDING', server_asset_id = NULL, version_of = NULL, backed_up_at = NULL,
          attempts = 0, last_error = NULL
        """,
    )
    abstract suspend fun resetForNewServer()

    @Query("DELETE FROM media_items WHERE present = 0")
    abstract suspend fun deleteNotPresent()

    @Query("DELETE FROM media_items WHERE id = :id")
    abstract suspend fun delete(id: Long)
}

private fun ScannedMedia.toNewEntity(now: Long, scanStamp: Long, backlog: Boolean) = MediaItemEntity(
    volume = volume,
    mediaId = mediaId,
    uri = uri,
    kind = kind,
    mimeType = mimeType,
    displayName = displayName,
    relativePath = relativePath,
    size = size,
    captureTime = captureTime,
    dateAdded = dateAdded,
    dateModified = dateModified,
    favorite = favorite,
    backlog = backlog,
    firstSeenAt = now,
    lastSeenScan = scanStamp,
)

private fun MediaItemEntity.hasSameMetadata(media: ScannedMedia) =
    uri == media.uri &&
        mimeType == media.mimeType &&
        displayName == media.displayName &&
        relativePath == media.relativePath &&
        captureTime == media.captureTime &&
        favorite == media.favorite

private fun MediaItemEntity.withMetadata(media: ScannedMedia, scanStamp: Long) = copy(
    uri = media.uri,
    mimeType = media.mimeType,
    displayName = media.displayName,
    relativePath = media.relativePath,
    captureTime = media.captureTime,
    favorite = media.favorite,
    lastSeenScan = scanStamp,
    present = true,
)
