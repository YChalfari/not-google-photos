package com.notgooglephotos.photosync.work

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.work.Configuration
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.WorkManagerTestInitHelper
import androidx.work.workDataOf
import com.notgooglephotos.photosync.EngineFixture
import com.notgooglephotos.photosync.PhotoSyncRuntime
import com.notgooglephotos.photosync.engine.BackupCoordinator
import com.notgooglephotos.photosync.engine.RunTrigger
import com.notgooglephotos.photosync.model.SyncTrigger
import com.notgooglephotos.photosync.notify.AndroidMemoryAlarm
import com.notgooglephotos.photosync.notify.EndOfDayReminder
import com.notgooglephotos.photosync.notify.MemoryNotifications
import com.notgooglephotos.photosync.notify.Notifier
import com.notgooglephotos.photosync.permitCleartext
import com.notgooglephotos.photosync.status.StatusProvider
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import java.io.File

@RunWith(AndroidJUnit4::class)
@Config(sdk = [34])
class SyncSchedulerTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private lateinit var fx: EngineFixture
    private lateinit var scheduler: SyncScheduler

    @Before fun setUp() {
        permitCleartext()
        val config = Configuration.Builder().setExecutor(SynchronousExecutor()).setTaskExecutor(SynchronousExecutor()).build()
        try {
            WorkManagerTestInitHelper.initializeTestWorkManager(context, config)
        } catch (_: IllegalStateException) {
            // Another test method in this process already installed the test driver.
        }
        fx = EngineFixture(context)
        scheduler = SyncScheduler(context, fx.store, fx.clock)
    }

    @After fun tearDown() {
        PhotoSyncRuntime.setForTest(null)
        fx.close()
    }

    @Test
    fun schedulesTheTriggersItWasGivenAndKeepsUnchangedOnes() {
        scheduler.apply()
        assertTrue(pending(SyncScheduler.NEW_MEDIA).isEmpty())

        fx.start()
        fx.store.firstBackupComplete = false
        fx.store.triggers = listOf(SyncTrigger.OnNewMedia(60, 10), SyncTrigger.Interval(60), SyncTrigger.TimesOfDay(listOf(java.time.LocalTime.of(6, 30))))
        scheduler.apply()
        val first = id(SyncScheduler.NEW_MEDIA)
        assertTrue(pending(SyncScheduler.INTERVAL).isNotEmpty())
        assertTrue(pending(SyncScheduler.TIMES_OF_DAY).isNotEmpty())
        assertTrue(pending(SyncScheduler.RECONCILE).isNotEmpty())
        assertTrue(pending(SyncScheduler.REMINDER).isNotEmpty())
        assertTrue(pending(SyncScheduler.FIRST_BACKUP).isNotEmpty())
        val network = pending(SyncScheduler.NEW_MEDIA).single().constraints.requiredNetworkType
        assertEquals(androidx.work.NetworkType.UNMETERED, network)

        scheduler.apply()
        assertEquals(first, id(SyncScheduler.NEW_MEDIA))

        fx.store.triggers = listOf(SyncTrigger.OnNewMedia(5, 2))
        scheduler.apply()
        assertNotEquals(first, id(SyncScheduler.NEW_MEDIA))

        fx.store.firstBackupComplete = true
        fx.store.settings = fx.store.settings.copy(enabled = false)
        scheduler.apply()
        assertTrue(pending(SyncScheduler.INTERVAL).isEmpty())
        assertTrue(pending(SyncScheduler.FIRST_BACKUP).isEmpty())
    }

    @Test
    fun oneWakeUpPerKindAndAFailedRunIsNotRetried() {
        fx.start()
        fx.store.firstBackupComplete = true
        installRuntime()
        scheduler.whenOnline(true)
        scheduler.whenOnline(true)
        assertEquals(1, pending(SyncScheduler.WHEN_WIFI).size)

        val url = fx.server.baseUrl()
        fx.server.shutdown()
        fx.store.settings = fx.store.settings.copy(homeUrl = url, wifiOnly = false)
        val request = OneTimeWorkRequestBuilder<SyncWorker>()
            .setInputData(workDataOf(SyncWorker.KEY_TRIGGER to RunTrigger.MANUAL.js))
            .build()
        val manager = WorkManager.getInstance(context)
        manager.enqueue(request).result.get()
        WorkManagerTestInitHelper.getTestDriver(context)!!.setAllConstraintsMet(request.id)
        val deadline = System.currentTimeMillis() + 20_000
        var info = manager.getWorkInfoById(request.id).get()
        while (info?.state == WorkInfo.State.ENQUEUED || info?.state == WorkInfo.State.RUNNING || info?.state == WorkInfo.State.BLOCKED) {
            if (System.currentTimeMillis() > deadline) break
            Thread.sleep(40)
            info = manager.getWorkInfoById(request.id).get()
        }
        assertEquals(WorkInfo.State.SUCCEEDED, info!!.state)
        val run = runBlocking { fx.db.runs().latest() }!!
        assertEquals("serverUnreachable", run.outcome)
        assertEquals(1, run.requests)
        assertTrue(pending(SyncScheduler.BACKOFF).isEmpty())
    }

    private fun installRuntime() {
        val notifier = Notifier(context)
        val memories = MemoryNotifications(fx.db, fx.store, notifier, AndroidMemoryAlarm(context), File(context.cacheDir, "covers"), fx.clock)
        PhotoSyncRuntime.setForTest(
            PhotoSyncRuntime(
                db = fx.db,
                store = fx.store,
                library = fx.library,
                conditions = fx.conditions,
                clock = fx.clock,
                engine = fx.engine,
                scheduler = scheduler,
                notifier = notifier,
                memories = memories,
                reminder = EndOfDayReminder(fx.engine, fx.db, fx.store, fx.conditions, notifier, fx.clock),
                discovery = fx.discovery,
                coordinator = BackupCoordinator(fx.db, fx.store, scheduler, fx.resolver, fx.conditions, fx.clock),
                status = StatusProvider(fx.db, fx.store, fx.library, fx.conditions, fx.engine, fx.clock),
            ),
        )
    }

    private fun pending(name: String): List<WorkInfo> = WorkManager.getInstance(context).getWorkInfosForUniqueWork(name).get()
        .filter { it.state == WorkInfo.State.ENQUEUED || it.state == WorkInfo.State.BLOCKED }

    private fun id(name: String): String = pending(name).single().id.toString()
}
