package com.notgooglephotos.photosync

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.notgooglephotos.photosync.engine.FreeUpFilter
import com.notgooglephotos.photosync.engine.FreeUpMediaType
import com.notgooglephotos.photosync.engine.FreeUpRules
import com.notgooglephotos.photosync.media.ScannedMedia
import com.notgooglephotos.photosync.queue.ItemState
import com.notgooglephotos.photosync.queue.MediaItemEntity
import com.notgooglephotos.photosync.queue.MediaKind
import com.notgooglephotos.photosync.queue.SyncDatabase
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

@RunWith(AndroidJUnit4::class)
@Config(sdk = [34])
class FreeUpTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val db = SyncDatabase.inMemory(context)
    private val now = 1_700_000_000_000L

    @After fun tearDown() = db.close()

    @Test
    fun defaultFilterKeepsFavoritesAndIncludesToday() {
        val items = listOf(
            item(1, favorite = true),
            item(2, captureTime = now),
            item(3, kind = MediaKind.VIDEO, size = 50),
            item(4, state = ItemState.PENDING),
            item(5, checksum = null),
            item(6, present = false),
        )
        val selected = FreeUpRules.select(items, FreeUpFilter.parse(JSONObject()), now)
        assertEquals(listOf(2L, 3L), selected.map { it.id })
        val summary = FreeUpRules.summarize(selected)
        assertEquals(2, summary.count)
        assertEquals(150L, summary.bytes)
        assertEquals(1, summary.photos)
        assertEquals(1, summary.videos)
    }

    @Test
    fun explicitAllIncludesFavoritesAndToday() {
        val filter = FreeUpFilter.parse(
            JSONObject()
                .put("olderThanDays", 0)
                .put("keepFavorites", false)
                .put("mediaType", "all"),
        )
        val selected = FreeUpRules.select(
            listOf(item(1, favorite = true, captureTime = now), item(2, kind = MediaKind.VIDEO)),
            filter,
            now,
        )
        assertEquals(listOf(1L, 2L), selected.map { it.id })
        assertFalse(filter.keepFavorites)
        assertEquals(FreeUpMediaType.ALL, filter.mediaType)
    }

    @Test
    fun ageKindAndFolderFiltersNarrowTheSet() {
        val old = now - 3 * FreeUpRules.DAY_MS
        val items = listOf(
            item(1, captureTime = now),
            item(2, captureTime = old),
            item(3, captureTime = old, kind = MediaKind.VIDEO, relativePath = "Pictures/WhatsApp/"),
        )
        val aged = FreeUpRules.select(items, FreeUpFilter.parse(JSONObject().put("olderThanDays", 1).put("keepFavorites", false)), now)
        assertEquals(listOf(2L, 3L), aged.map { it.id })
        val videos = FreeUpRules.select(items, FreeUpFilter.parse(JSONObject().put("mediaType", "videos").put("keepFavorites", false)), now)
        assertEquals(listOf(3L), videos.map { it.id })
        val camera = FreeUpRules.select(
            items,
            FreeUpFilter.parse(JSONObject().put("folders", JSONArray().put("DCIM/")).put("keepFavorites", false)),
            now,
        )
        assertEquals(listOf(1L, 2L), camera.map { it.id })
    }

    @Test
    fun backedUpRowsLeaveTheQueueAfterTheyAreDeleted() = runBlocking {
        val media = db.media()
        media.upsertScanned(listOf(scanned(1), scanned(2, kind = MediaKind.VIDEO)), 1, 1, 0)
        val rows = media.all()
        for (row in rows) media.setChecksum(row.id, "sum-${row.mediaId}", row.size, row.dateModified, false)
        media.markBackedUp(rows.map { it.id }, "asset", 2)
        assertEquals(2, media.backedUpPresent().size)
        media.markNotPresent(listOf(rows.first().id))
        val left = media.backedUpPresent()
        assertEquals(1, left.size)
        assertEquals(2L, left.single().mediaId)
        assertTrue(media.all().any { it.mediaId == 1L && !it.present })
    }

    private fun item(
        id: Long,
        state: ItemState = ItemState.BACKED_UP,
        kind: MediaKind = MediaKind.IMAGE,
        favorite: Boolean = false,
        captureTime: Long = now - 10 * FreeUpRules.DAY_MS,
        checksum: String? = "abc$id",
        present: Boolean = true,
        size: Long = 100,
        relativePath: String = "DCIM/Camera/",
    ) = MediaItemEntity(
        id = id,
        volume = "external_primary",
        mediaId = id,
        uri = "content://media/external/images/media/$id",
        kind = kind,
        mimeType = if (kind == MediaKind.VIDEO) "video/mp4" else "image/jpeg",
        displayName = "$id.jpg",
        relativePath = relativePath,
        size = size,
        captureTime = captureTime,
        dateAdded = captureTime / 1000,
        dateModified = captureTime / 1000,
        favorite = favorite,
        state = state,
        checksum = checksum,
        firstSeenAt = 1,
        lastSeenScan = 1,
        present = present,
    )

    private fun scanned(id: Long, kind: MediaKind = MediaKind.IMAGE) = ScannedMedia(
        volume = "external_primary",
        mediaId = id,
        uri = "content://media/external/images/media/$id",
        kind = kind,
        mimeType = if (kind == MediaKind.VIDEO) "video/mp4" else "image/jpeg",
        displayName = "$id.jpg",
        relativePath = "DCIM/Camera/",
        size = 10,
        captureTime = 1_000,
        dateAdded = 1,
        dateModified = 1,
        favorite = false,
    )
}
