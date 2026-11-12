package com.notgooglephotos.photosync.media

import com.notgooglephotos.photosync.queue.ItemIntake
import com.notgooglephotos.photosync.queue.MediaKind

/**
 * Camera photos and videos go straight to the library. Screenshots, camera document scans,
 * and other still photos go to the holding area. Junk never gets queued.
 */
object IntakeRules {
    private val JUNK = setOf(
        "sent",
        "status",
        "statuses",
        ".statuses",
        "stickers",
        "animated gifs",
        "gif",
        "gifs",
        "voice notes",
        "audio",
    )

    /**
     * Null means leave the file on the phone. [includeOtherPhotos] covers folders outside DCIM;
     * screenshots and DCIM document scans are reviewed even when that is off.
     */
    fun decide(
        relativePath: String,
        kind: MediaKind,
        mimeType: String?,
        includeOtherPhotos: Boolean,
    ): ItemIntake? {
        val segments = segments(relativePath)
        if (segments.any(::isJunk)) return null
        val underDcim = segments.firstOrNull()?.equals("DCIM", ignoreCase = true) == true
        if (kind == MediaKind.VIDEO) return if (underDcim) ItemIntake.LIBRARY else null
        // "Documents" under DCIM is a camera scan. "WhatsApp Documents" and other document folders are not.
        val cameraDocumentScan = underDcim && segments.any { it.equals("Documents", ignoreCase = true) }
        if (segments.any(::isDocumentFolder) && !cameraDocumentScan) return null
        if (!underDcim && mimeType.equals("image/gif", ignoreCase = true)) return null
        val screenshots = segments.any { it.equals("Screenshots", ignoreCase = true) }
        if (screenshots || cameraDocumentScan) return ItemIntake.REVIEW
        if (underDcim) return ItemIntake.LIBRARY
        if (!includeOtherPhotos) return null
        return ItemIntake.REVIEW
    }

    /** Folders the Backup screen may offer as direct-to-library. Screenshots and Download are not. */
    fun isDirectLibraryFolder(relativePath: String): Boolean =
        decide(relativePath, MediaKind.IMAGE, "image/jpeg", includeOtherPhotos = false) == ItemIntake.LIBRARY

    /** `Stickers` and `WhatsApp Stickers` are the same kind of folder. */
    private fun isJunk(segment: String): Boolean {
        val name = segment.lowercase()
        if (name in JUNK) return true
        return JUNK.any { name.endsWith(" $it") }
    }

    private fun isDocumentFolder(segment: String): Boolean {
        val name = segment.lowercase()
        return name == "documents" || name.endsWith(" documents")
    }

    private fun segments(relativePath: String): List<String> =
        relativePath.trim('/').split('/').filter { it.isNotEmpty() }
}
