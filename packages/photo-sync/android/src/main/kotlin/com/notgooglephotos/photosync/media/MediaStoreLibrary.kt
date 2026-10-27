package com.notgooglephotos.photosync.media

import android.Manifest
import android.content.ContentResolver
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.database.Cursor
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.MediaStore
import androidx.core.content.ContextCompat
import com.notgooglephotos.photosync.queue.MediaKind
import java.io.FileNotFoundException

class MediaStoreLibrary(private val context: Context) : MediaLibrary {
    private val resolver: ContentResolver get() = context.contentResolver

    override fun hasReadAccess(): Boolean = when {
        Build.VERSION.SDK_INT >= 34 ->
            granted(Manifest.permission.READ_MEDIA_IMAGES) ||
                granted(Manifest.permission.READ_MEDIA_VIDEO) ||
                granted(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED)
        Build.VERSION.SDK_INT >= 33 -> granted(Manifest.permission.READ_MEDIA_IMAGES) || granted(Manifest.permission.READ_MEDIA_VIDEO)
        else -> granted(Manifest.permission.READ_EXTERNAL_STORAGE)
    }

    override fun hasLocationAccess(): Boolean = granted(Manifest.permission.ACCESS_MEDIA_LOCATION)

    override fun volumes(): List<VolumeInfo> = MediaStore.getExternalVolumeNames(context).sorted().map { name ->
        VolumeInfo(
            name = name,
            version = MediaStore.getVersion(context, name),
            generation = if (Build.VERSION.SDK_INT >= 30) MediaStore.getGeneration(context, name) else null,
        )
    }

    override fun query(
        volume: String,
        kinds: Set<MediaKind>,
        folders: List<String>,
        sinceGeneration: Long?,
        sinceSeconds: Long?,
    ): List<ScannedMedia> {
        if (folders.isEmpty()) return emptyList()
        val rows = mutableListOf<ScannedMedia>()
        for (kind in kinds) {
            val collection = collectionFor(kind, volume)
            val (selection, args) = buildSelection(folders, sinceGeneration, sinceSeconds)
            val queryArgs = Bundle().apply {
                putString(ContentResolver.QUERY_ARG_SQL_SELECTION, selection)
                putStringArray(ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, args.toTypedArray())
                putString(ContentResolver.QUERY_ARG_SQL_SORT_ORDER, "${MediaStore.MediaColumns._ID} ASC")
            }
            resolver.query(collection, PROJECTION, queryArgs, null)?.use { cursor ->
                val columns = Columns(cursor)
                while (cursor.moveToNext()) {
                    columns.read(cursor, volume, kind, collection)?.let(rows::add)
                }
            }
        }
        return rows
    }

    override fun listFolders(): List<FolderInfo> {
        val counts = linkedMapOf<String, Pair<String, Int>>()
        for (volume in MediaStore.getExternalVolumeNames(context)) {
            for (kind in MediaKind.entries) {
                val projection = arrayOf(MediaStore.MediaColumns.RELATIVE_PATH, MediaStore.MediaColumns.BUCKET_DISPLAY_NAME)
                resolver.query(collectionFor(kind, volume), projection, null, null, null)?.use { cursor ->
                    while (cursor.moveToNext()) {
                        val path = cursor.getString(0) ?: continue
                        val name = cursor.getString(1) ?: path.trimEnd('/').substringAfterLast('/')
                        val (label, count) = counts[path] ?: (name to 0)
                        counts[path] = label to count + 1
                    }
                }
            }
        }
        return counts.map { (path, value) -> FolderInfo(path, value.first, value.second) }.sortedByDescending { it.count }
    }

    override fun openOriginal(uri: String): OpenedMedia {
        val parsed = Uri.parse(uri)
        if (hasLocationAccess()) {
            try {
                val original = MediaStore.setRequireOriginal(parsed)
                return open(original, locationRedacted = false)
            } catch (e: SecurityException) {
                // Falls through to the redacted stream below.
            } catch (e: UnsupportedOperationException) {
                // Same: the provider refused original access for this item.
            }
        }
        return open(parsed, locationRedacted = true)
    }

    private fun open(uri: Uri, locationRedacted: Boolean): OpenedMedia {
        try {
            val descriptor = resolver.openAssetFileDescriptor(uri, "r") ?: throw MediaGoneException("No file for $uri")
            // Redacted copies may differ in length from MediaStore's SIZE, so they stream without a declared length.
            val length = if (locationRedacted) -1L else descriptor.length
            return OpenedMedia(descriptor.createInputStream(), length, locationRedacted)
        } catch (e: FileNotFoundException) {
            throw MediaGoneException("File is gone: $uri", e)
        } catch (e: IllegalArgumentException) {
            throw MediaGoneException("File is gone: $uri", e)
        }
    }

    private fun granted(permission: String) =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

    private class Columns(cursor: Cursor) {
        private val id = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns._ID)
        private val name = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.DISPLAY_NAME)
        private val mime = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.MIME_TYPE)
        private val size = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.SIZE)
        private val taken = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.DATE_TAKEN)
        private val added = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.DATE_ADDED)
        private val modified = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.DATE_MODIFIED)
        private val path = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.RELATIVE_PATH)
        private val favorite = if (Build.VERSION.SDK_INT >= 30) cursor.getColumnIndex(MediaStore.MediaColumns.IS_FAVORITE) else -1

        fun read(cursor: Cursor, volume: String, kind: MediaKind, collection: Uri): ScannedMedia? {
            val bytes = cursor.getLong(size)
            if (bytes <= 0) return null
            val mediaId = cursor.getLong(id)
            val dateAdded = cursor.getLong(added)
            val dateTaken = if (cursor.isNull(taken)) 0L else cursor.getLong(taken)
            return ScannedMedia(
                volume = volume,
                mediaId = mediaId,
                uri = ContentUris.withAppendedId(collection, mediaId).toString(),
                kind = kind,
                mimeType = cursor.getString(mime),
                displayName = cursor.getString(name) ?: "$mediaId",
                relativePath = cursor.getString(path) ?: "",
                size = bytes,
                captureTime = if (dateTaken > 0) dateTaken else dateAdded * 1000,
                dateAdded = dateAdded,
                dateModified = cursor.getLong(modified),
                favorite = favorite >= 0 && cursor.getInt(favorite) == 1,
            )
        }
    }

    companion object {
        private fun collectionFor(kind: MediaKind, volume: String): Uri = when (kind) {
            MediaKind.IMAGE -> MediaStore.Images.Media.getContentUri(volume)
            MediaKind.VIDEO -> MediaStore.Video.Media.getContentUri(volume)
        }

        private val PROJECTION: Array<String> = buildList {
            add(MediaStore.MediaColumns._ID)
            add(MediaStore.MediaColumns.DISPLAY_NAME)
            add(MediaStore.MediaColumns.MIME_TYPE)
            add(MediaStore.MediaColumns.SIZE)
            add(MediaStore.MediaColumns.DATE_TAKEN)
            add(MediaStore.MediaColumns.DATE_ADDED)
            add(MediaStore.MediaColumns.DATE_MODIFIED)
            add(MediaStore.MediaColumns.RELATIVE_PATH)
            if (Build.VERSION.SDK_INT >= 30) add(MediaStore.MediaColumns.IS_FAVORITE)
        }.toTypedArray()

        /** Folder prefixes become `relative_path LIKE 'DCIM/%'` clauses; `%` and `_` in names are escaped. */
        internal fun buildSelection(folders: List<String>, sinceGeneration: Long?, sinceSeconds: Long?): Pair<String, List<String>> {
            val args = mutableListOf<String>()
            val folderClause = folders.joinToString(" OR ", prefix = "(", postfix = ")") { folder ->
                args += escapeLike(folder) + "%"
                "${MediaStore.MediaColumns.RELATIVE_PATH} LIKE ? ESCAPE '\\'"
            }
            val clauses = mutableListOf(folderClause)
            if (sinceGeneration != null && Build.VERSION.SDK_INT >= 30) {
                clauses += "(${MediaStore.MediaColumns.GENERATION_MODIFIED} > ? OR ${MediaStore.MediaColumns.GENERATION_ADDED} > ?)"
                args += sinceGeneration.toString()
                args += sinceGeneration.toString()
            } else if (sinceSeconds != null) {
                clauses += "(${MediaStore.MediaColumns.DATE_ADDED} >= ? OR ${MediaStore.MediaColumns.DATE_MODIFIED} >= ?)"
                args += sinceSeconds.toString()
                args += sinceSeconds.toString()
            }
            return clauses.joinToString(" AND ") to args
        }

        internal fun escapeLike(value: String): String =
            value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    }
}
