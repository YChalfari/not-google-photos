package com.notgooglephotos.photosync.notify

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.notgooglephotos.photosync.PhotoSyncRuntime
import com.notgooglephotos.photosync.engine.AfterSync
import com.notgooglephotos.photosync.engine.Clock
import com.notgooglephotos.photosync.net.ApiResult
import com.notgooglephotos.photosync.net.SyncApiClient
import com.notgooglephotos.photosync.queue.MemoryEntity
import com.notgooglephotos.photosync.queue.SyncDatabase
import com.notgooglephotos.photosync.settings.SettingsStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZonedDateTime

/** One pending alarm for the next memory notification. */
interface MemoryAlarm {
    fun set(atMs: Long)

    fun cancel()
}

/** Inexact but Doze-friendly; it doesn't need the exact-alarm permission. */
class AndroidMemoryAlarm(private val context: Context) : MemoryAlarm {
    override fun set(atMs: Long) {
        context.getSystemService(AlarmManager::class.java)?.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMs, pendingIntent())
    }

    override fun cancel() {
        context.getSystemService(AlarmManager::class.java)?.cancel(pendingIntent())
    }

    private fun pendingIntent(): PendingIntent = PendingIntent.getBroadcast(
        context,
        REQUEST_CODE,
        Intent(context, MemoryAlarmReceiver::class.java),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private companion object {
        const val REQUEST_CODE = 4301
    }
}

/**
 * Memory notifications scheduled on the phone (B10): after a sync reaches the server, the
 * upcoming memories are fetched (at most every few hours) and an alarm fires at the chosen time
 * on each memory's date. Works without any push service.
 */
class MemoryNotifications(
    private val db: SyncDatabase,
    private val store: SettingsStore,
    private val notifier: UserAlerts,
    private val alarm: MemoryAlarm,
    private val coverDir: File,
    private val clock: Clock,
) : AfterSync {
    override suspend fun onSynced(client: SyncApiClient) {
        if (store.memoryNotificationTime == null) return
        val last = store.memoriesRefreshedAt
        if (last != null && clock.now() - last < REFRESH_EVERY_MS) return
        refresh(client)
    }

    suspend fun refresh(client: SyncApiClient) {
        val time = store.memoryNotificationTime ?: return
        val upcoming = when (val result = client.upcomingMemories()) {
            is ApiResult.Ok -> result.value
            else -> return
        }
        store.memoriesRefreshedAt = clock.now()
        val today = clock.today()
        val current = upcoming.filter { !it.date.isBefore(today) }
        val known = if (current.isEmpty()) emptyMap() else db.memories().byIds(current.map { it.id }).associateBy { it.id }
        val rows = current.map { memory ->
            val previous = known[memory.id]
            MemoryEntity(
                id = memory.id,
                title = memory.title,
                subtitle = memory.subtitle,
                date = memory.date.toString(),
                coverPath = previous?.coverPath?.takeIf { File(it).exists() } ?: memory.coverUrl?.let { saveCover(client, memory.id, it) },
                notifyAt = notifyAt(memory.date, time),
                notified = previous?.notified ?: false,
            )
        }
        if (rows.isEmpty()) db.memories().deleteUnnotified() else db.memories().deleteUnnotifiedExcept(rows.map { it.id })
        db.memories().putAll(rows)
        db.memories().deleteOlderThan(clock.startOf(today.minusDays(KEEP_DAYS)))
        removeUnusedCovers()
        armNext()
    }

    /** Shows every memory that is due today and arms the alarm for the next one. */
    suspend fun deliverDue() {
        val due = db.memories().due(notBefore = clock.startOf(clock.today()), until = clock.now() + DUE_SLACK_MS)
        for (memory in due) {
            notifier.showMemory(memory)
            db.memories().markNotified(memory.id)
        }
        armNext()
    }

    /** Changes the notification time (null turns memory notifications off). */
    suspend fun setTime(time: LocalTime?) {
        store.memoryNotificationTime = time
        if (time == null) {
            db.memories().deleteUnnotified()
            alarm.cancel()
            return
        }
        for (memory in db.memories().all()) {
            if (!memory.notified) db.memories().setNotifyAt(memory.id, notifyAt(LocalDate.parse(memory.date), time))
        }
        store.memoriesRefreshedAt = null
        armNext()
    }

    /** After a reboot or a clock change: recompute notification times and re-arm the alarm. */
    suspend fun reschedule() {
        val time = store.memoryNotificationTime
        if (time == null) alarm.cancel() else setTime(time)
    }

    private suspend fun armNext() {
        if (store.memoryNotificationTime == null) {
            alarm.cancel()
            return
        }
        val next = db.memories().nextToNotify(clock.startOf(clock.today()))
        if (next == null) alarm.cancel() else alarm.set(maxOf(next.notifyAt, clock.now()))
    }

    private fun notifyAt(date: LocalDate, time: LocalTime): Long = ZonedDateTime.of(date, time, clock.zone()).toInstant().toEpochMilli()

    private suspend fun saveCover(client: SyncApiClient, id: String, url: String): String? {
        val bytes = client.downloadCover(url) ?: return null
        return withContext(Dispatchers.IO) {
            runCatching {
                coverDir.mkdirs()
                File(coverDir, coverName(id)).apply { writeBytes(bytes) }.absolutePath
            }.getOrNull()
        }
    }

    private suspend fun removeUnusedCovers() {
        val used = db.memories().all().mapNotNull { it.coverPath }.toSet()
        withContext(Dispatchers.IO) {
            coverDir.listFiles()?.filter { it.absolutePath !in used }?.forEach { it.delete() }
        }
    }

    private fun coverName(id: String) = id.replace(Regex("[^A-Za-z0-9._-]"), "_").take(80) + ".img"

    companion object {
        const val REFRESH_EVERY_MS = 3 * 60 * 60_000L
        private const val DUE_SLACK_MS = 60_000L
        private const val KEEP_DAYS = 7L
    }
}

class MemoryAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val pending = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try {
                PhotoSyncRuntime.get(context).memories.deliverDue()
            } finally {
                pending.finish()
            }
        }
    }
}
