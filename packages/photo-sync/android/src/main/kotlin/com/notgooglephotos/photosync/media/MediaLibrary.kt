package com.notgooglephotos.photosync.media

import com.notgooglephotos.photosync.queue.ItemIntake
import com.notgooglephotos.photosync.queue.MediaKind
import java.io.InputStream

/** One row read from MediaStore. */
data class ScannedMedia(
    val volume: String,
    val mediaId: Long,
    val uri: String,
    val kind: MediaKind,
    val mimeType: String?,
    val displayName: String,
    val relativePath: String,
    val size: Long,
    /** Epoch ms. */
    val captureTime: Long,
    /** Epoch seconds. */
    val dateAdded: Long,
    /** Epoch seconds. */
    val dateModified: Long,
    val favorite: Boolean,
    /** Set by the scanner. The library itself leaves this as [ItemIntake.LIBRARY]. */
    val intake: ItemIntake = ItemIntake.LIBRARY,
)

data class VolumeInfo(
    val name: String,
    val version: String,
    /** MediaStore generation (Android 11+); null where generations don't exist. */
    val generation: Long?,
)

data class FolderInfo(val relativePath: String, val name: String, val count: Int)

/** An opened original. [length] is -1 when unknown. */
class OpenedMedia(val stream: InputStream, val length: Long, val locationRedacted: Boolean)

/** Thrown when a file disappeared from the phone between scanning and reading it. */
class MediaGoneException(message: String, cause: Throwable? = null) : Exception(message, cause)

/** The phone's photo library. Android implements it on MediaStore; tests use an in-memory fake. */
interface MediaLibrary {
    fun hasReadAccess(): Boolean

    fun hasLocationAccess(): Boolean

    fun volumes(): List<VolumeInfo>

    /**
     * Rows in [folders] of [kinds] on [volume]. With [sinceGeneration] only rows added or changed
     * after that generation; with [sinceSeconds] (the fallback where generations don't exist) only
     * rows added or modified at or after that time.
     */
    fun query(
        volume: String,
        kinds: Set<MediaKind>,
        folders: List<String>,
        sinceGeneration: Long?,
        sinceSeconds: Long?,
    ): List<ScannedMedia>

    /** Every still image on the volume, including folders that are not backed up directly. */
    fun queryAllImages(volume: String, sinceGeneration: Long?, sinceSeconds: Long?): List<ScannedMedia>

    fun listFolders(): List<FolderInfo>

    /** Opens the original bytes (with GPS intact when the location permission allows it). */
    @Throws(MediaGoneException::class)
    fun openOriginal(uri: String): OpenedMedia
}
