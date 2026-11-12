package com.notgooglephotos.photosync

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.notgooglephotos.photosync.engine.NetworkState
import com.notgooglephotos.photosync.engine.RunOutcome
import com.notgooglephotos.photosync.engine.RunTrigger
import com.notgooglephotos.photosync.net.DiscoveredServer
import com.notgooglephotos.photosync.queue.ItemIntake
import com.notgooglephotos.photosync.queue.ItemState
import com.notgooglephotos.photosync.queue.MediaKind
import com.notgooglephotos.photosync.settings.SettingsStore
import org.json.JSONObject
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import java.security.MessageDigest

@RunWith(AndroidJUnit4::class)
@Config(sdk = [34])
class SyncEngineTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private lateinit var fx: EngineFixture

    @Before fun setUp() {
        permitCleartext()
        fx = EngineFixture(context)
        fx.start()
    }

    @After fun tearDown() = fx.close()

    @Test
    fun uploadsMissingFilesNewestFirstAndSkipsWhatTheServerHas() {
        val older = fx.add("older.jpg", bytes = "older".toByteArray(), captureTime = fx.clock.nowMs - 10_000)
        val newer = fx.add("newer.jpg", bytes = "newer".toByteArray(), captureTime = fx.clock.nowMs)
        val report = fx.run(RunTrigger.MANUAL)
        assertEquals(RunOutcome.COMPLETED, report.outcome)
        assertEquals(2, report.uploaded)
        assertEquals(listOf("newer.jpg", "older.jpg"), fx.server.uploads.map { it.fileName })
        assertEquals(1, fx.server.checks)
        assertEquals(1, fx.server.healths)
        assertEquals(ItemState.BACKED_UP, fx.rows().first { it.uri == older.uri }.state)
        assertEquals(0, fx.discovery.calls)

        val opens = fx.library.opens
        val again = fx.run(RunTrigger.INTERVAL)
        assertEquals(RunOutcome.NOTHING_TO_DO, again.outcome)
        assertEquals(0, again.uploaded)
        assertEquals(opens, fx.library.opens)
        assertEquals(2, fx.server.uploads.size)
    }

    @Test
    fun unreachableServerIsOneRequestAndDoesNotScanOrRetry() {
        val url = fx.server.baseUrl()
        fx.server.shutdown()
        fx.store.settings = fx.store.settings.copy(homeUrl = url, remoteUrl = null)
        fx.add("a.jpg")
        val report = fx.run(RunTrigger.MANUAL)
        assertEquals(RunOutcome.SERVER_UNREACHABLE, report.outcome)
        assertEquals(1, report.requests)
        assertEquals(0, fx.library.queryCalls)
        assertTrue(fx.follow.events.isEmpty())
        assertEquals(5, (1..5).sumOf { fx.run(RunTrigger.INTERVAL).requests })
    }

    @Test
    fun meteredWifiOnlyWaitsForWifiWithoutCallingTheServer() {
        fx.conditions.network = NetworkState(connected = true, unmetered = false, local = false)
        fx.add("a.jpg")
        val report = fx.run(RunTrigger.MANUAL)
        assertEquals(RunOutcome.WAITING_FOR_WIFI, report.outcome)
        assertEquals(0, report.requests)
        assertEquals(listOf("wifi"), fx.follow.events)
    }

    @Test
    fun unreachableOnMobileDataAsksForWifi() {
        fx.store.settings = fx.store.settings.copy(wifiOnly = false)
        fx.conditions.network = NetworkState(connected = true, unmetered = false, local = false)
        val url = fx.server.baseUrl()
        fx.server.shutdown()
        fx.store.settings = fx.store.settings.copy(homeUrl = url)
        val report = fx.run(RunTrigger.MANUAL)
        assertEquals(RunOutcome.SERVER_UNREACHABLE, report.outcome)
        assertEquals(1, report.requests)
        assertTrue(fx.follow.events.contains("wifi"))
    }

    @Test
    fun homeAddressThatMovedIsRediscovered() {
        val found = fx.server.baseUrl()
        fx.store.settings = fx.store.settings.copy(homeUrl = "http://127.0.0.1:9", serverId = "srv-1")
        fx.discovery.servers = listOf(DiscoveredServer("Mac", "srv-1", found, "127.0.0.1", fx.server.port()))
        fx.add("a.jpg")
        val report = fx.run(RunTrigger.MANUAL)
        assertEquals(RunOutcome.COMPLETED, report.outcome)
        assertEquals(1, report.uploaded)
        assertEquals(found, fx.store.settings.homeUrl)
        assertEquals(1, fx.discovery.calls)
    }

    @Test
    fun differentServerIdIsNotUploadedTo() {
        fx.store.settings = fx.store.settings.copy(serverId = "someone-else")
        fx.add("a.jpg")
        val report = fx.run(RunTrigger.MANUAL)
        assertEquals(RunOutcome.SERVER_UNREACHABLE, report.outcome)
        assertTrue(report.message!!.contains("different server"))
        assertEquals(0, fx.server.uploads.size)
    }

    @Test
    fun identicalBytesUploadOnce() {
        fx.add("one.jpg", bytes = "same".toByteArray(), captureTime = 2)
        fx.add("two.jpg", bytes = "same".toByteArray(), captureTime = 1)
        val report = fx.run(RunTrigger.MANUAL)
        assertEquals(1, report.uploaded)
        assertEquals(1, report.alreadyOnServer)
        assertEquals(1, fx.server.uploads.size)
        assertEquals(3, fx.library.opens)
        assertTrue(fx.rows().all { it.state == ItemState.BACKED_UP && it.serverAssetId == fx.server.assetId(fx.rows().first().checksum!!) })
    }

    @Test
    fun checkBatchesAtTwoHundred() {
        repeat(201) { fx.add("p$it.jpg", bytes = "p$it".toByteArray(), captureTime = it.toLong()) }
        fx.run(RunTrigger.MANUAL)
        assertEquals(2, fx.server.checks)
        assertEquals(201, fx.server.uploads.size)
    }

    @Test
    fun editedPhotoUploadsAsANewVersion() {
        val photo = fx.add("a.jpg", bytes = "one".toByteArray())
        fx.run(RunTrigger.MANUAL)
        val original = fx.server.assetId(fx.rows().single().checksum!!)
        fx.library.edit(photo.uri, "two".toByteArray())
        val report = fx.run(RunTrigger.MANUAL)
        assertEquals(1, report.uploaded)
        assertEquals(original, fx.server.uploads.last().versionOf)
        assertEquals(ItemState.BACKED_UP, fx.rows().single().state)
    }

    @Test
    fun timestampOnlyChangeStaysBackedUp() {
        val photo = fx.add("a.jpg", bytes = "one".toByteArray())
        fx.run(RunTrigger.MANUAL)
        val checksum = fx.rows().single().checksum
        fx.library.edit(photo.uri, "one".toByteArray())
        val report = fx.run(RunTrigger.MANUAL)
        assertEquals(0, report.uploaded)
        assertEquals(1, report.alreadyOnServer)
        val row = fx.rows().single()
        assertEquals(ItemState.BACKED_UP, row.state)
        assertEquals(checksum, row.checksum)
        assertNull(row.versionOf)
    }

    @Test
    fun uploadFailureBacksOffAndManualIgnoresThePause() {
        fx.server.failUploads = 100
        fx.add("a.jpg")
        val first = fx.run(RunTrigger.MANUAL)
        assertEquals(RunOutcome.UPLOAD_FAILED, first.outcome)
        assertEquals(fx.clock.nowMs + 30 * 60_000L, fx.store.uploadsPausedUntil)
        assertEquals(ItemState.PENDING, fx.rows().single().state)
        assertEquals(1, fx.rows().single().attempts)

        val paused = fx.run(RunTrigger.INTERVAL)
        assertEquals(RunOutcome.BACKING_OFF, paused.outcome)
        assertEquals(0, paused.requests)

        val manual = fx.run(RunTrigger.MANUAL)
        assertEquals(RunOutcome.UPLOAD_FAILED, manual.outcome)
        assertEquals(fx.clock.nowMs + 60 * 60_000L, fx.store.uploadsPausedUntil)

        repeat(8) {
            fx.clock.nowMs = fx.store.uploadsPausedUntil!!
            val before = fx.clock.nowMs
            fx.run(RunTrigger.BACKOFF)
            assertEquals(com.notgooglephotos.photosync.engine.Backoff.delayMs(it + 3), fx.store.uploadsPausedUntil!! - before)
        }
        val row = fx.rows().single()
        assertEquals(ItemState.FAILED, row.state)
        assertEquals(10, row.attempts)
    }

    @Test
    fun revokedTokenNeedsPairingAndDoesNotPauseUploads() {
        fx.server.unauthorized = true
        fx.add("a.jpg")
        val report = fx.run(RunTrigger.MANUAL)
        assertEquals(RunOutcome.NEEDS_PAIRING, report.outcome)
        assertTrue(fx.store.needsPairing)
        assertNull(fx.store.uploadsPausedUntil)
        assertEquals(0, fx.server.uploads.size)
        assertEquals(ItemState.PENDING, fx.rows().single().state)
    }

    @Test
    fun rejectedFileFailsWithoutPausingTheRest() {
        fx.add("bad.jpg", bytes = "bad".toByteArray(), captureTime = 2)
        fx.add("good.jpg", bytes = "good".toByteArray(), captureTime = 1)
        fx.server.rejectNames += "bad.jpg"
        val report = fx.run(RunTrigger.MANUAL)
        assertEquals(RunOutcome.COMPLETED, report.outcome)
        assertEquals(1, report.uploaded)
        assertEquals(1, report.failed)
        assertNull(fx.store.uploadsPausedUntil)
        assertEquals(ItemState.FAILED, fx.rows().first { it.displayName == "bad.jpg" }.state)
        assertEquals(ItemState.BACKED_UP, fx.rows().first { it.displayName == "good.jpg" }.state)
    }

    @Test
    fun fileThatGrowsDuringUploadIsRetriedLaterWithoutAGlobalPause() {
        val photo = fx.add("a.jpg")
        fx.library.grows += photo.uri
        val report = fx.run(RunTrigger.MANUAL)
        assertEquals(RunOutcome.NOTHING_TO_DO, report.outcome)
        assertNull(fx.store.uploadsPausedUntil)
        val row = fx.rows().single()
        assertEquals(ItemState.PENDING, row.state)
        assertEquals(1, row.attempts)
        assertNull(row.hashedSize)
    }

    @Test
    fun fileGoneBetweenHashAndUploadIsDropped() {
        fx.add("a.jpg")
        fx.library.goneAfterOpens = 1
        val report = fx.run(RunTrigger.MANUAL)
        assertEquals(RunOutcome.NOTHING_TO_DO, report.outcome)
        assertTrue(fx.rows().isEmpty())
        assertEquals(0, fx.server.uploads.size)
    }

    @Test
    fun firstBackupHoldsOlderItemsForWifiAndCharging() {
        fx.store.settings = fx.store.settings.copy(requireCharging = true)
        fx.store.firstBackupComplete = false
        fx.store.backlogCutoffMs = fx.clock.nowMs
        val cutoff = fx.clock.nowMs / 1000
        val knownBytes = "already-on-server".toByteArray()
        fx.server.remember(sha1(knownBytes))
        fx.add("known.jpg", bytes = knownBytes, dateAdded = cutoff - 200, captureTime = 0)
        fx.add("old.jpg", dateAdded = cutoff - 100, captureTime = 1)
        fx.add("new.jpg", dateAdded = cutoff + 100, captureTime = 2)
        val normal = fx.run(RunTrigger.INTERVAL)
        assertEquals(1, normal.uploaded)
        assertEquals(1, normal.alreadyOnServer)
        assertEquals(listOf("new.jpg"), fx.server.uploads.map { it.fileName })
        assertTrue(fx.follow.events.contains("firstBackup"))
        assertEquals(ItemState.BACKED_UP, fx.rows().first { it.displayName == "known.jpg" }.state)
        assertEquals(ItemState.PENDING, fx.rows().first { it.displayName == "old.jpg" }.state)

        fx.conditions.charging = false
        val waiting = fx.run(RunTrigger.FIRST_BACKUP)
        assertEquals(RunOutcome.WAITING_FOR_CHARGING, waiting.outcome)
        assertEquals(0, waiting.requests)

        fx.conditions.charging = true
        val full = fx.run(RunTrigger.FIRST_BACKUP)
        assertEquals(1, full.uploaded)
        assertEquals("old.jpg", fx.server.uploads.last().fileName)
        assertTrue(fx.store.firstBackupComplete)
        assertTrue(fx.rows().all { it.state == ItemState.BACKED_UP })
    }

    @Test
    fun backUpNowUploadsOlderPhotosTheServerDoesNotHave() {
        fx.store.firstBackupComplete = false
        fx.store.backlogCutoffMs = fx.clock.nowMs
        val cutoff = fx.clock.nowMs / 1000
        fx.conditions.charging = false
        fx.add("old.jpg", dateAdded = cutoff - 100, captureTime = 1)
        val report = fx.run(RunTrigger.MANUAL)
        assertEquals(RunOutcome.COMPLETED, report.outcome)
        assertEquals(1, report.uploaded)
        assertEquals("old.jpg", fx.server.uploads.single().fileName)
        assertTrue(fx.store.firstBackupComplete)
    }

    @Test
    fun firstBackupRunsUnpluggedWhenChargingIsNotRequired() {
        fx.store.firstBackupComplete = false
        fx.store.backlogCutoffMs = fx.clock.nowMs
        fx.store.settings = fx.store.settings.copy(requireCharging = false)
        val cutoff = fx.clock.nowMs / 1000
        fx.conditions.charging = false
        fx.add("old.jpg", dateAdded = cutoff - 100, captureTime = 2)
        fx.add("old.mp4", bytes = "video".toByteArray(), kind = MediaKind.VIDEO, dateAdded = cutoff - 50, captureTime = 1)
        val report = fx.run(RunTrigger.FIRST_BACKUP)
        assertEquals(RunOutcome.COMPLETED, report.outcome)
        assertEquals(2, report.uploaded)
        assertEquals(setOf("old.jpg", "old.mp4"), fx.server.uploads.map { it.fileName }.toSet())
        assertTrue(fx.store.firstBackupComplete)
        assertTrue(fx.rows().all { it.state == ItemState.BACKED_UP })
    }

    @Test
    fun normalRunUploadsOlderPhotosWhenChargingIsNotRequired() {
        fx.store.firstBackupComplete = false
        fx.store.backlogCutoffMs = fx.clock.nowMs
        fx.store.settings = fx.store.settings.copy(requireCharging = false)
        val cutoff = fx.clock.nowMs / 1000
        fx.conditions.charging = false
        fx.add("old.jpg", dateAdded = cutoff - 100, captureTime = 1)
        val report = fx.run(RunTrigger.INTERVAL)
        assertEquals(RunOutcome.COMPLETED, report.outcome)
        assertEquals(1, report.uploaded)
        assertEquals("old.jpg", fx.server.uploads.single().fileName)
        assertTrue(fx.store.firstBackupComplete)
    }

    @Test
    fun videosWaitUntilThePhoneIsCharging() {
        fx.store.settings = fx.store.settings.copy(requireCharging = true)
        fx.conditions.charging = false
        fx.add("still.jpg", captureTime = 2)
        fx.add("clip.mp4", bytes = "video".toByteArray(), kind = MediaKind.VIDEO, captureTime = 1)
        val report = fx.run(RunTrigger.MANUAL)
        assertEquals(1, report.uploaded)
        assertEquals(ItemState.PENDING, fx.rows().first { it.kind == MediaKind.VIDEO }.state)
        assertTrue(fx.follow.events.contains("charging"))

        fx.conditions.charging = true
        fx.follow.events.clear()
        val next = fx.run(RunTrigger.CHARGING)
        assertEquals(1, next.uploaded)
        assertTrue(fx.rows().all { it.state == ItemState.BACKED_UP })
    }

    @Test
    fun disabledSkipsAutomaticRunsButNotManual() {
        fx.store.settings = fx.store.settings.copy(enabled = false)
        fx.add("a.jpg")
        assertEquals(RunOutcome.DISABLED, fx.run(RunTrigger.INTERVAL).outcome)
        assertEquals(0, fx.server.healths)
        assertEquals(1, fx.run(RunTrigger.MANUAL).uploaded)
    }

    @Test
    fun reconcileDropsPendingRowsThatAreGoneAndKeepsBackedUpHistory() {
        val kept = fx.add("kept.jpg", captureTime = 2)
        fx.run(RunTrigger.MANUAL)
        fx.library.generation = (fx.library.generation ?: 0) + 1
        val gone = fx.add("gone.jpg", captureTime = 1)
        runBlocking { fx.engine.indexOnly() }
        assertEquals(ItemState.PENDING, fx.rows().first { it.uri == gone.uri }.state)
        fx.library.remove(gone.uri)
        fx.library.remove(kept.uri)
        fx.run(RunTrigger.RECONCILE)
        val rows = fx.rows()
        assertTrue(rows.none { it.uri == gone.uri })
        val history = rows.single { it.uri == kept.uri }
        assertEquals(ItemState.BACKED_UP, history.state)
        assertEquals(false, history.present)
    }

    @Test
    fun aSecondPhoneDoesNotReuploadBytesTheServerAlreadyHas() {
        val bytes = "shared-bytes".toByteArray()
        fx.add("phone-a.jpg", bytes = bytes)
        fx.run(RunTrigger.MANUAL)
        runBlocking { fx.db.clearAllTables() }
        fx.library.clear()
        fx.add("phone-b.jpg", bytes = bytes)
        val report = fx.run(RunTrigger.MANUAL)
        assertEquals(0, report.uploaded)
        assertEquals(1, report.alreadyOnServer)
        assertEquals(1, fx.server.uploads.size)
        assertEquals(ItemState.BACKED_UP, fx.rows().single().state)
    }

    @Test
    fun screenshotsAndOtherPhotosWaitAndJunkNeverUploads() {
        fx.add("shot.jpg", bytes = "camera".toByteArray())
        fx.add("screen.png", bytes = "screen".toByteArray(), folder = "DCIM/Screenshots/")
        fx.add("scan.jpg", bytes = "scan".toByteArray(), folder = "DCIM/Documents/")
        fx.add("rec.mp4", bytes = "video".toByteArray(), folder = "DCIM/Screenshots/", kind = MediaKind.VIDEO)
        fx.add("dl.jpg", bytes = "download".toByteArray(), folder = "Download/")
        fx.add("same.jpg", bytes = "camera".toByteArray(), folder = "WhatsApp/Media/WhatsApp Images/")
        fx.add("anim.gif", bytes = "gif".toByteArray(), folder = "Download/", mimeType = "image/gif")
        fx.add("sent.jpg", bytes = "sent".toByteArray(), folder = "WhatsApp/Media/WhatsApp Images/Sent/")
        fx.add("note.jpg", bytes = "note".toByteArray(), folder = "WhatsApp/Media/WhatsApp Documents/")
        fx.add("clip.mp4", bytes = "clip".toByteArray(), folder = "Download/", kind = MediaKind.VIDEO)

        val report = fx.run(RunTrigger.MANUAL)
        assertEquals(RunOutcome.COMPLETED, report.outcome)
        val rows = fx.rows().associateBy { it.displayName }
        assertEquals(
            setOf("shot.jpg", "screen.png", "scan.jpg", "rec.mp4", "dl.jpg", "same.jpg"),
            rows.keys,
        )
        assertEquals(ItemState.BACKED_UP, rows.getValue("shot.jpg").state)
        assertEquals(ItemIntake.LIBRARY, rows.getValue("shot.jpg").intake)
        assertEquals(ItemState.BACKED_UP, rows.getValue("same.jpg").state)
        assertEquals(ItemState.HELD, rows.getValue("screen.png").state)
        assertEquals(ItemState.HELD, rows.getValue("scan.jpg").state)
        assertEquals(ItemState.HELD, rows.getValue("dl.jpg").state)
        assertEquals(ItemState.BACKED_UP, rows.getValue("rec.mp4").state)
        assertEquals(ItemIntake.LIBRARY, rows.getValue("rec.mp4").intake)

        val byName = fx.server.uploads.associateBy { it.fileName }
        assertEquals(5, fx.server.uploads.size)
        assertEquals("library", byName.getValue("shot.jpg").intake)
        assertEquals("review", byName.getValue("screen.png").intake)
        assertEquals("review", byName.getValue("scan.jpg").intake)
        assertEquals("review", byName.getValue("dl.jpg").intake)
        assertEquals("library", byName.getValue("rec.mp4").intake)
        assertTrue(fx.server.uploads.none { it.fileName == "same.jpg" })

        val held = rows.getValue("dl.jpg")
        fx.server.reject(held.checksum!!)
        fx.run(RunTrigger.INTERVAL)
        assertEquals(ItemState.SKIPPED, fx.rows().first { it.displayName == "dl.jpg" }.state)
        assertEquals(ItemState.HELD, fx.rows().first { it.displayName == "screen.png" }.state)
        assertEquals(5, fx.server.uploads.size)
    }

    @Test
    fun turningOtherPhotosOffStillReviewsScreenshots() {
        fx.store.settings = fx.store.settings.copy(includeOtherPhotos = false)
        fx.add("screen.png", bytes = "screen".toByteArray(), folder = "DCIM/Screenshots/")
        fx.add("dl.jpg", bytes = "download".toByteArray(), folder = "Download/")
        fx.run(RunTrigger.MANUAL)
        val rows = fx.rows()
        assertEquals(listOf("screen.png"), rows.map { it.displayName })
        assertEquals(ItemState.HELD, rows.single().state)
    }

    @Test
    fun enablingOtherPhotosOnAnOlderInstallUploadsWithoutWaitingForACharger() {
        val raw = JSONObject(fx.store.peekSettingsJson().toString())
        raw.remove("includeOtherPhotos")
        context.getSharedPreferences(SettingsStore.FILE, Context.MODE_PRIVATE)
            .edit()
            .putString(SettingsStore.KEY_SETTINGS, raw.toString())
            .commit()
        fx.store.firstBackupComplete = true
        fx.conditions.charging = false
        fx.add("old.jpg", bytes = "old".toByteArray(), folder = "Download/", dateAdded = 10, captureTime = 10_000)
        val report = fx.run(RunTrigger.INTERVAL)
        assertEquals(RunOutcome.COMPLETED, report.outcome)
        assertEquals(listOf("old.jpg"), fx.server.uploads.map { it.fileName })
        assertEquals(true, fx.store.firstBackupComplete)
        assertTrue(fx.store.peekSettingsJson()!!.getBoolean("includeOtherPhotos"))
        assertEquals(ItemState.HELD, fx.rows().single().state)
    }

    @Test
    fun secondScanIsIncremental() {
        fx.add("a.jpg")
        fx.run(RunTrigger.MANUAL)
        val generation = fx.library.generation
        fx.library.generation = generation!! + 1
        fx.add("b.jpg", bytes = "bee".toByteArray())
        fx.library.sinceGenerations.clear()
        fx.run(RunTrigger.ON_NEW_MEDIA)
        assertEquals(generation, fx.library.sinceGenerations.first())
        assertTrue(fx.library.sinceGenerations.all { it != null })
        assertEquals(2, fx.server.uploads.size)
    }

    @Test
    fun notConfiguredAndNoPermissionStopImmediately() {
        fx.store.deviceToken = null
        assertEquals(RunOutcome.NOT_CONFIGURED, fx.run(RunTrigger.MANUAL).outcome)
        fx.store.deviceToken = "device-token"
        fx.library.readAccess = false
        assertEquals(RunOutcome.NO_PERMISSION, fx.run(RunTrigger.MANUAL).outcome)
        assertEquals(0, fx.server.healths)
    }

    @Test
    fun runRecordCountsRequests() {
        fx.add("a.jpg")
        fx.run(RunTrigger.MANUAL)
        val run = runBlocking { fx.db.runs().latest() }!!
        assertEquals(1 + 1 + 1, run.requests)
        assertEquals("completed", run.outcome)
        assertEquals("manual", run.trigger)
    }

    private fun sha1(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-1").digest(bytes).joinToString("") { "%02x".format(it) }
}
