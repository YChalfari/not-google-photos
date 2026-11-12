package com.notgooglephotos.photosync.queue

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

enum class MediaKind { IMAGE, VIDEO }

enum class ItemState { PENDING, UPLOADING, BACKED_UP, HELD, SKIPPED, FAILED }

/** `HELD` is on the server but not in the library yet. `SKIPPED` must not be uploaded. */
enum class ItemIntake { LIBRARY, REVIEW }

/** One row per photo or video in the backup scope. This table is how the phone knows what's backed up. */
@Entity(
    tableName = "media_items",
    indices = [
        Index(value = ["volume", "media_id"], unique = true),
        Index("state"),
        Index("checksum"),
        Index("capture_time"),
    ],
)
data class MediaItemEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val volume: String,
    @ColumnInfo(name = "media_id") val mediaId: Long,
    val uri: String,
    val kind: MediaKind,
    @ColumnInfo(name = "mime_type") val mimeType: String?,
    @ColumnInfo(name = "display_name") val displayName: String,
    @ColumnInfo(name = "relative_path") val relativePath: String,
    val size: Long,
    /** Capture time in epoch ms (MediaStore DATE_TAKEN, falling back to DATE_ADDED). */
    @ColumnInfo(name = "capture_time") val captureTime: Long,
    /** Epoch seconds, as MediaStore reports them. */
    @ColumnInfo(name = "date_added") val dateAdded: Long,
    @ColumnInfo(name = "date_modified") val dateModified: Long,
    val favorite: Boolean = false,
    /**
     * Already on the phone when its folder entered the backup selection. Until the first full
     * backup finishes, these items only upload in the first-backup run (Wi-Fi and charging).
     */
    val backlog: Boolean = false,
    val state: ItemState = ItemState.PENDING,
    /** SHA-1 of the original bytes, lowercase hex; valid while size and date_modified match the hashed_* columns. */
    val checksum: String? = null,
    @ColumnInfo(name = "hashed_size") val hashedSize: Long? = null,
    @ColumnInfo(name = "hashed_modified") val hashedModified: Long? = null,
    /** True when the hash (and upload) had to use the location-redacted stream. */
    @ColumnInfo(name = "location_redacted") val locationRedacted: Boolean = false,
    val attempts: Int = 0,
    @ColumnInfo(name = "last_error") val lastError: String? = null,
    @ColumnInfo(name = "server_asset_id") val serverAssetId: String? = null,
    /** Server asset id of the original when this row is an edited version of an already backed-up file. */
    @ColumnInfo(name = "version_of") val versionOf: String? = null,
    @ColumnInfo(name = "backed_up_at") val backedUpAt: Long? = null,
    @ColumnInfo(name = "first_seen_at") val firstSeenAt: Long,
    @ColumnInfo(name = "last_seen_scan") val lastSeenScan: Long,
    /** False once a full scan no longer finds the file in the selected folders. */
    val present: Boolean = true,
    /** `REVIEW` uploads into the holding area. Camera shots stay `LIBRARY`. */
    val intake: ItemIntake = ItemIntake.LIBRARY,
) {
    val deviceAssetId: String get() = "$volume:$mediaId"
}

@Entity(tableName = "sync_runs", indices = [Index("started_at")])
data class SyncRunEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val trigger: String,
    @ColumnInfo(name = "started_at") val startedAt: Long,
    @ColumnInfo(name = "finished_at") val finishedAt: Long? = null,
    val outcome: String? = null,
    val uploaded: Int = 0,
    val failed: Int = 0,
    val bytes: Long = 0,
    /** HTTP requests the run made, so tests and diagnostics can prove there are no retry storms. */
    val requests: Int = 0,
    val message: String? = null,
)

@Entity(tableName = "scan_state")
data class ScanStateEntity(
    @PrimaryKey val volume: String,
    /** MediaStore.getVersion(); when it changes, generation numbers are meaningless and a full scan runs. */
    val version: String,
    val generation: Long?,
    @ColumnInfo(name = "scanned_at") val scannedAt: Long,
    /** SyncSettings.selectionKey at scan time; a different selection forces a full scan. */
    val selection: String,
)

@Entity(tableName = "memories")
data class MemoryEntity(
    @PrimaryKey val id: String,
    val title: String,
    val subtitle: String?,
    /** Local date of the memory, ISO yyyy-MM-dd. */
    val date: String,
    @ColumnInfo(name = "cover_path") val coverPath: String?,
    @ColumnInfo(name = "notify_at") val notifyAt: Long,
    val notified: Boolean = false,
)

data class StateCount(val state: ItemState, val count: Int)

data class KindCount(val kind: MediaKind, val count: Int)

data class PendingCount(val kind: MediaKind, val backlog: Boolean, val count: Int)
