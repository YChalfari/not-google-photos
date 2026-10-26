package com.notgooglephotos.photosync

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.notgooglephotos.photosync.media.MediaStoreLibrary
import com.notgooglephotos.photosync.media.ScannedMedia
import com.notgooglephotos.photosync.model.SyncSettings
import com.notgooglephotos.photosync.model.SyncTrigger
import com.notgooglephotos.photosync.model.TimeOfDay
import com.notgooglephotos.photosync.queue.ItemState
import com.notgooglephotos.photosync.queue.MediaKind
import com.notgooglephotos.photosync.queue.SyncDatabase
import com.notgooglephotos.photosync.settings.PlainTokenCipher
import com.notgooglephotos.photosync.settings.SettingsStore
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import java.time.LocalTime

@RunWith(AndroidJUnit4::class)
@Config(sdk = [34])
class QueueAndSettingsTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val db = SyncDatabase.inMemory(context)

    @After fun tearDown() = db.close()

    @Test
    fun queueTracksChangesVersionsAndBacklog() = runBlocking {
        val media = db.media()
        val first = media.upsertScanned(listOf(row(1, size = 10, modified = 5, added = 100)), 1, 1, backlogBeforeSec = 1_000)
        assertEquals(1, first.added)
        assertTrue(media.all().single().backlog)

        val newer = media.upsertScanned(listOf(row(2, size = 10, modified = 5, added = 5_000, capture = 50)), 2, 2, 1_000)
        assertEquals(1, newer.added)
        assertFalse(media.all().first { it.mediaId == 2L }.backlog)

        media.markBackedUp(listOf(media.all().first { it.mediaId == 1L }.id), "asset-1", 10)
        media.upsertScanned(listOf(row(1, size = 11, modified = 6, added = 100)), 3, 3, 1_000)
        val edited = media.all().first { it.mediaId == 1L }
        assertEquals(ItemState.PENDING, edited.state)
        assertEquals("asset-1", edited.versionOf)
        assertFalse(edited.backlog)

        val page = media.pendingCandidates(true, true, Long.MAX_VALUE, Long.MAX_VALUE, 1)
        assertEquals(1, page.size)
        val rest = media.pendingCandidates(true, true, page.single().captureTime, page.single().id, 10)
        assertFalse(rest.any { it.id == page.single().id })

        media.removeUnseen("external_primary", 99)
        assertTrue(media.all().isEmpty() || media.all().all { it.state == ItemState.BACKED_UP })
    }

    @Test
    fun unseenPendingRowsAreDeletedAndBackedUpRowsStay() = runBlocking {
        val media = db.media()
        media.upsertScanned(listOf(row(1, size = 4, modified = 1, added = 10), row(2, size = 4, modified = 1, added = 10, capture = 2)), 5, 5, 0)
        val kept = media.all().first { it.mediaId == 1L }
        media.markBackedUp(listOf(kept.id), "asset", 6)
        media.removeUnseen("external_primary", 9)
        val rows = media.all()
        assertEquals(1, rows.size)
        assertEquals(1L, rows.single().mediaId)
        assertFalse(rows.single().present)
    }

    @Test
    fun settingsRoundTripAndSelectionGrowth() {
        val store = SettingsStore(context, PlainTokenCipher())
        context.getSharedPreferences(SettingsStore.FILE, Context.MODE_PRIVATE).edit().clear().commit()
        val merged = SyncSettings().merge(
            JSONObject()
                .put("homeUrl", "http://192.168.1.20:8787")
                .put("folders", JSONArray(listOf("Pictures/WhatsApp/", "dcim")))
                .put("reminderTime", "07:05")
                .put("includeVideos", false),
        )
        assertEquals("http://192.168.1.20:8787", merged.homeUrl)
        assertEquals(listOf("DCIM/", "Pictures/WhatsApp/"), merged.folders)
        assertEquals(LocalTime.of(7, 5), merged.reminderTime)
        assertFalse(merged.includeVideos)
        store.settings = merged
        store.deviceToken = "secret"
        assertEquals("secret", store.deviceToken)
        assertTrue(store.isConfigured)
        val again = SyncSettings.fromJson(JSONObject(store.settings.toJson().toString()))
        assertEquals(merged, again)
        assertTrue(SyncSettings.grew(SyncSettings(), merged.copy(includeVideos = true)))
        assertFalse(SyncSettings.grew(merged, merged.copy(folders = listOf("DCIM/Camera/"))))
        val triggers = SyncTrigger.listFromJson(
            JSONArray()
                .put(JSONObject().put("kind", "interval").put("everyMin", 5))
                .put(JSONObject().put("kind", "timesOfDay").put("times", JSONArray(listOf("9:00", "21:00")))),
        )
        assertEquals(15L, (triggers[0] as SyncTrigger.Interval).everyMin)
        assertEquals(listOf(TimeOfDay.parse("09:00"), TimeOfDay.parse("21:00")), (triggers[1] as SyncTrigger.TimesOfDay).times)
    }

    @Test
    @Config(sdk = [34])
    fun folderSelectionUsesGenerationOnModernReleases() {
        val (sql, args) = MediaStoreLibrary.buildSelection(listOf("DCIM/", "My_Folder/"), sinceGeneration = 12, sinceSeconds = null)
        assertTrue(sql.contains("generation_modified > ?"))
        assertTrue(sql.contains("LIKE ? ESCAPE '\\'"))
        assertEquals(listOf("DCIM/%", "My\\_Folder/%", "12", "12"), args)
    }

    @Test
    @Config(sdk = [29])
    fun folderSelectionFallsBackToTimestampsWithoutGenerations() {
        val (sql, args) = MediaStoreLibrary.buildSelection(listOf("DCIM/"), sinceGeneration = 12, sinceSeconds = 50)
        assertFalse(sql.contains("generation_modified"))
        assertTrue(sql.contains("date_added >= ?"))
        assertEquals(listOf("DCIM/%", "50", "50"), args)
    }

    private fun row(id: Long, size: Long, modified: Long, added: Long, capture: Long = added * 1000) = ScannedMedia(
        volume = "external_primary",
        mediaId = id,
        uri = "content://media/$id",
        kind = MediaKind.IMAGE,
        mimeType = "image/jpeg",
        displayName = "$id.jpg",
        relativePath = "DCIM/Camera/",
        size = size,
        captureTime = capture,
        dateAdded = added,
        dateModified = modified,
        favorite = false,
    )
}
