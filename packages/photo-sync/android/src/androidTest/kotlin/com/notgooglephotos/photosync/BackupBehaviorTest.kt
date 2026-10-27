package com.notgooglephotos.photosync

import android.Manifest
import android.app.NotificationManager
import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.provider.MediaStore
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import androidx.work.WorkInfo
import androidx.work.WorkManager
import com.notgooglephotos.photosync.engine.RunOutcome
import com.notgooglephotos.photosync.engine.RunTrigger
import com.notgooglephotos.photosync.model.SyncSettings
import com.notgooglephotos.photosync.model.SyncTrigger
import com.notgooglephotos.photosync.notify.Notifier
import com.notgooglephotos.photosync.work.SyncScheduler
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.RuleChain
import org.junit.rules.Timeout
import org.junit.runner.RunWith
import java.util.concurrent.TimeUnit

/**
 * The A8 checks that need a device: a burst of new photos becomes one debounced run, and a stopped
 * server never turns into a retry storm or a second evening reminder.
 */
@RunWith(AndroidJUnit4::class)
class BackupBehaviorTest {
    private val context: Context = InstrumentationRegistry.getInstrumentation().targetContext
    private val created = mutableListOf<Uri>()
    private var server: FakeSyncServer? = null

    @get:Rule val rules: RuleChain = RuleChain
        .outerRule(Timeout(3, TimeUnit.MINUTES))
        .around(
            GrantPermissionRule.grant(
                Manifest.permission.READ_MEDIA_IMAGES,
                Manifest.permission.READ_MEDIA_VIDEO,
                Manifest.permission.ACCESS_MEDIA_LOCATION,
                Manifest.permission.POST_NOTIFICATIONS,
            ),
        )

    @Before fun setUp() {
        val runtime = PhotoSyncRuntime.get(context)
        runtime.db.clearAllTables()
        context.getSharedPreferences(com.notgooglephotos.photosync.settings.SettingsStore.FILE, Context.MODE_PRIVATE).edit().clear().commit()
        WorkManager.getInstance(context).cancelAllWork().result.get()
        deleteTestPhotos()
    }

    @After fun tearDown() {
        server?.shutdown()
        created.forEach { context.contentResolver.delete(it, null, null) }
        deleteTestPhotos()
        WorkManager.getInstance(context).cancelAllWork()
    }

    @Test
    fun aBurstOfPhotosBecomesOneRun() {
        val server = FakeSyncServer().also { it.start(); this.server = it }
        val runtime = PhotoSyncRuntime.get(context)
        runtime.store.settings = SyncSettings(
            homeUrl = server.baseUrl(),
            wifiOnly = false,
            includeVideos = false,
            videosOnlyWhileCharging = false,
            folders = listOf(FOLDER),
            reminderTime = null,
        )
        runtime.store.deviceToken = "device-token"
        runtime.store.firstBackupComplete = true
        runtime.store.backlogCutoffMs = System.currentTimeMillis()
        runtime.store.triggers = listOf(SyncTrigger.OnNewMedia(debounceSec = 2, maxDelayMin = 1))
        runtime.scheduler.apply()

        repeat(4) { index ->
            created += insert("ngp-burst-$index.jpg", "burst-$index".toByteArray())
            Thread.sleep(120)
        }
        val deadline = System.currentTimeMillis() + 50_000
        while (server.uploads.size < 4 && System.currentTimeMillis() < deadline) Thread.sleep(250)
        assertEquals("A burst should upload each new photo", 4, server.uploads.size)
        assertTrue("A burst should be one run, not one run per photo (health checks: ${server.healths})", server.healths <= 2)
        assertTrue(server.checks <= 2)
    }

    @Test
    fun stoppedServerDoesNotRetryAndRemindsOnce() {
        val runtime = PhotoSyncRuntime.get(context)
        runtime.store.settings = SyncSettings(
            homeUrl = "http://127.0.0.1:9",
            wifiOnly = false,
            includeVideos = true,
            folders = listOf(FOLDER),
            reminderTime = java.time.LocalTime.of(21, 0),
            unreachableNudgeDays = 3,
        )
        runtime.store.deviceToken = "device-token"
        runtime.store.firstBackupComplete = true
        runtime.store.backlogCutoffMs = System.currentTimeMillis() - 86_400_000
        runtime.store.configuredAt = System.currentTimeMillis()
        created += insert("ngp-today.jpg", "today".toByteArray())

        val first = runBlocking { runtime.engine.run(RunTrigger.MANUAL) }
        assertEquals(RunOutcome.SERVER_UNREACHABLE, first.outcome)
        assertEquals(1, first.requests)
        val second = runBlocking { runtime.engine.run(RunTrigger.MANUAL) }
        assertEquals(1, second.requests)
        val backoff = WorkManager.getInstance(context).getWorkInfosForUniqueWork(SyncScheduler.BACKOFF).get()
        assertTrue(backoff.none { it.state == WorkInfo.State.ENQUEUED || it.state == WorkInfo.State.RUNNING })

        val reminder = runBlocking { runtime.reminder.check() }
        assertEquals(com.notgooglephotos.photosync.notify.EndOfDayReminder.Result.SHOWN, reminder)
        val manager = context.getSystemService(NotificationManager::class.java)
        assertEquals(1, manager.activeNotifications.count { it.id == Notifier.ID_REMINDER })
        assertEquals(
            com.notgooglephotos.photosync.notify.EndOfDayReminder.Result.ALREADY_SHOWN,
            runBlocking { runtime.reminder.check() },
        )
        assertEquals(1, manager.activeNotifications.count { it.id == Notifier.ID_REMINDER })
    }

    private fun insert(name: String, bytes: ByteArray): Uri {
        val collection = MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, name)
            put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg")
            put(MediaStore.Images.Media.RELATIVE_PATH, FOLDER)
            put(MediaStore.Images.Media.DATE_TAKEN, System.currentTimeMillis())
            put(MediaStore.Images.Media.IS_PENDING, 1)
        }
        val uri = context.contentResolver.insert(collection, values) ?: error("MediaStore rejected $name")
        context.contentResolver.openOutputStream(uri)!!.use { it.write(bytes) }
        context.contentResolver.update(uri, ContentValues().apply { put(MediaStore.Images.Media.IS_PENDING, 0) }, null, null)
        return uri
    }

    private fun deleteTestPhotos() {
        val collection = MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        context.contentResolver.delete(collection, "${MediaStore.MediaColumns.RELATIVE_PATH} LIKE ?", arrayOf("$FOLDER%"))
    }

    companion object {
        private const val FOLDER = "Pictures/NGPTest/"
    }
}
