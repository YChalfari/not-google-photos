package com.notgooglephotos.photosync.notify

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.notgooglephotos.photosync.EngineFixture
import com.notgooglephotos.photosync.permitCleartext
import com.notgooglephotos.photosync.engine.RunOutcome
import com.notgooglephotos.photosync.net.SyncApiFactory
import com.notgooglephotos.photosync.queue.MediaKind
import com.notgooglephotos.photosync.queue.MemoryEntity
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import java.io.File
import java.time.LocalDate
import java.time.LocalTime

class RecordingAlerts : UserAlerts {
    val reminders = mutableListOf<String>()
    val nudges = mutableListOf<Int>()
    val memories = mutableListOf<String>()
    override fun showReminder(photos: Int, videos: Int, cause: ReminderCause, unreachableDays: Int?) {
        reminders += "$photos/$videos/${cause.name}"
    }
    override fun showNudge(photos: Int, videos: Int, days: Int) { nudges += days }
    override fun cancelReminder() = Unit
    override fun showMemory(memory: MemoryEntity) { memories += memory.id }
}

class FakeAlarm : MemoryAlarm {
    var at: Long? = null
    override fun set(atMs: Long) { at = atMs }
    override fun cancel() { at = null }
}

@RunWith(AndroidJUnit4::class)
@Config(sdk = [34])
class ReminderAndMemoryTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private lateinit var fx: EngineFixture
    private val alerts = RecordingAlerts()

    @Before fun setUp() {
        permitCleartext()
        fx = EngineFixture(context)
        fx.start()
    }

    @After fun tearDown() = fx.close()

    @Test
    fun reminderTriesOnceThenStaysQuiet() = runBlocking {
        val reminder = EndOfDayReminder(fx.engine, fx.db, fx.store, fx.conditions, alerts, fx.clock)
        fx.add("today.jpg", captureTime = fx.clock.nowMs)
        val url = fx.server.baseUrl()
        fx.server.shutdown()
        fx.store.settings = fx.store.settings.copy(homeUrl = url)
        assertEquals(EndOfDayReminder.Result.SHOWN, reminder.check())
        assertEquals(listOf("1/0/SERVER"), alerts.reminders)
        assertEquals(EndOfDayReminder.Result.ALREADY_SHOWN, reminder.check())
        assertEquals(1, alerts.reminders.size)
    }

    @Test
    fun reminderIsSilentWhenTheRetryBacksEverythingUp() = runBlocking {
        val reminder = EndOfDayReminder(fx.engine, fx.db, fx.store, fx.conditions, alerts, fx.clock)
        fx.add("today.jpg", captureTime = fx.clock.nowMs)
        assertEquals(EndOfDayReminder.Result.BACKED_UP_ON_RETRY, reminder.check())
        assertTrue(alerts.reminders.isEmpty())
        assertEquals(fx.clock.today().toString(), fx.store.lastReminderDay)
        assertEquals(EndOfDayReminder.Result.ALREADY_SHOWN, reminder.check())
    }

    @Test
    fun nudgeAfterSeveralUnreachableDays() = runBlocking {
        val reminder = EndOfDayReminder(fx.engine, fx.db, fx.store, fx.conditions, alerts, fx.clock)
        fx.add("old.jpg", captureTime = fx.clock.nowMs - 10L * 86_400_000, dateAdded = fx.clock.nowMs / 1000 - 10 * 86_400)
        fx.store.lastReachableAt = fx.clock.nowMs - 4L * 86_400_000
        fx.store.lastUnreachableAt = fx.clock.nowMs
        val url = fx.server.baseUrl()
        fx.server.shutdown()
        fx.store.settings = fx.store.settings.copy(homeUrl = url)
        assertEquals(EndOfDayReminder.Result.NUDGED, reminder.check())
        assertEquals(1, alerts.nudges.size)
        assertTrue(alerts.reminders.isEmpty())
    }

    @Test
    fun videosOnlyCauseMentionsCharging() = runBlocking {
        fx.store.settings = fx.store.settings.copy(requireCharging = true)
        fx.conditions.charging = false
        fx.add("clip.mp4", bytes = "v".toByteArray(), kind = MediaKind.VIDEO, captureTime = fx.clock.nowMs)
        val reminder = EndOfDayReminder(fx.engine, fx.db, fx.store, fx.conditions, alerts, fx.clock)
        assertEquals(EndOfDayReminder.Result.SHOWN, reminder.check())
        assertTrue(alerts.reminders.single().endsWith("CHARGING"))
    }

    @Test
    fun memoriesAreScheduledAtTheChosenTimeAndShownOnce() = runBlocking {
        fx.clock.nowMs = LocalDate.of(2026, 10, 26).atTime(8, 0).atZone(fx.clock.zone()).toInstant().toEpochMilli()
        val alarm = FakeAlarm()
        val memories = MemoryNotifications(fx.db, fx.store, alerts, alarm, File(context.cacheDir, "covers"), fx.clock)
        fx.store.memoryNotificationTime = LocalTime.of(9, 0)
        fx.server.memoriesBody = """
            {"memories":[
              {"id":"today","title":"On this day","date":"2026-10-26","coverUrl":"/covers/today"},
              {"id":"next","title":"Next year","date":"2027-10-26"}
            ]}
        """.trimIndent()
        val client = SyncApiFactory("t").create(fx.server.baseUrl(), "device-token")
        memories.refresh(client)
        val todayAtNine = LocalDate.of(2026, 10, 26).atTime(9, 0).atZone(fx.clock.zone()).toInstant().toEpochMilli()
        assertEquals(todayAtNine, alarm.at)
        assertTrue(File(context.cacheDir, "covers").list()?.isNotEmpty() == true)
        fx.clock.nowMs = todayAtNine
        memories.deliverDue()
        assertEquals(listOf("today"), alerts.memories)
        assertEquals(
            LocalDate.of(2027, 10, 26).atTime(9, 0).atZone(fx.clock.zone()).toInstant().toEpochMilli(),
            alarm.at,
        )
        memories.deliverDue()
        assertEquals(1, alerts.memories.size)
        memories.setTime(null)
        assertNull(alarm.at)
    }
}
