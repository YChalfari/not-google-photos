package com.notgooglephotos.photosync.notify

import com.notgooglephotos.photosync.engine.Clock
import com.notgooglephotos.photosync.engine.DeviceConditions
import com.notgooglephotos.photosync.engine.RunOutcome
import com.notgooglephotos.photosync.engine.RunTrigger
import com.notgooglephotos.photosync.engine.SyncEngine
import com.notgooglephotos.photosync.queue.MediaKind
import com.notgooglephotos.photosync.queue.SyncDatabase
import com.notgooglephotos.photosync.settings.SettingsStore
import java.time.LocalDate
import java.time.temporal.ChronoUnit

/**
 * The end-of-day reminder (A5). At the reminder time the phone counts today's photos and videos
 * that aren't backed up. If there are some, it tries one sync; if that also leaves some behind,
 * it shows one quiet notification with a "Try now" button. At most once a day, and nothing when
 * everything is backed up. When the server hasn't answered for several days, an occasional
 * nudge covers the older items too.
 */
class EndOfDayReminder(
    private val engine: SyncEngine,
    private val db: SyncDatabase,
    private val store: SettingsStore,
    private val conditions: DeviceConditions,
    private val notifier: UserAlerts,
    private val clock: Clock,
) {
    enum class Result { SKIPPED, ALREADY_SHOWN, BUSY, ALL_BACKED_UP, BACKED_UP_ON_RETRY, SHOWN, NUDGED }

    suspend fun check(): Result {
        val settings = store.settings
        if (!store.isConfigured || !settings.enabled || settings.reminderTime == null) return Result.SKIPPED
        val today = clock.today()
        if (store.lastReminderDay == today.toString()) return Result.ALREADY_SHOWN
        // A run that is working right now is the backup happening; no need to nag.
        if (engine.isRunning) return Result.BUSY

        engine.indexOnly()
        val before = notBackedUp(today)
        val nudgeDue = nudgeDue(today, settings.unreachableNudgeDays)
        if (before.total == 0 && !nudgeDue) {
            store.lastReminderDay = today.toString()
            return Result.ALL_BACKED_UP
        }

        val report = engine.run(RunTrigger.REMINDER)
        val outcome = report.outcome ?: return Result.BUSY
        val after = notBackedUp(today)
        if (after.total > 0) {
            notifier.showReminder(after.photos, after.videos, cause(outcome, after), unreachableDays(today))
            store.lastReminderDay = today.toString()
            return Result.SHOWN
        }
        if (nudgeDue && outcome == RunOutcome.SERVER_UNREACHABLE) {
            val waiting = pending()
            if (waiting.total > 0) {
                notifier.showNudge(waiting.photos, waiting.videos, unreachableDays(today) ?: settings.unreachableNudgeDays)
                store.lastNudgeDay = today.toString()
                store.lastReminderDay = today.toString()
                return Result.NUDGED
            }
        }
        store.lastReminderDay = today.toString()
        return if (before.total > 0) Result.BACKED_UP_ON_RETRY else Result.ALL_BACKED_UP
    }

    private data class Counts(val photos: Int, val videos: Int) {
        val total get() = photos + videos
    }

    private suspend fun notBackedUp(today: LocalDate): Counts {
        val rows = db.media().notBackedUpBetween(clock.startOf(today), clock.startOf(today.plusDays(1)))
        return Counts(
            photos = rows.filter { it.kind == MediaKind.IMAGE }.sumOf { it.count },
            videos = rows.filter { it.kind == MediaKind.VIDEO }.sumOf { it.count },
        )
    }

    private suspend fun pending(): Counts {
        val rows = db.media().pendingBreakdown()
        return Counts(
            photos = rows.filter { it.kind == MediaKind.IMAGE }.sumOf { it.count },
            videos = rows.filter { it.kind == MediaKind.VIDEO }.sumOf { it.count },
        )
    }

    private fun cause(outcome: RunOutcome, counts: Counts): ReminderCause = when (outcome) {
        RunOutcome.SERVER_UNREACHABLE, RunOutcome.UPLOAD_FAILED, RunOutcome.BACKING_OFF -> ReminderCause.SERVER
        RunOutcome.WAITING_FOR_WIFI -> ReminderCause.WIFI
        RunOutcome.WAITING_FOR_NETWORK -> ReminderCause.OFFLINE
        RunOutcome.WAITING_FOR_CHARGING -> ReminderCause.CHARGING
        RunOutcome.NEEDS_PAIRING -> ReminderCause.PAIRING
        RunOutcome.NO_PERMISSION -> ReminderCause.PERMISSION
        else -> when {
            counts.photos == 0 && store.settings.requireCharging && store.settings.videosOnlyWhileCharging && !conditions.isCharging() -> ReminderCause.CHARGING
            !store.firstBackupComplete -> ReminderCause.FIRST_BACKUP
            else -> ReminderCause.OTHER
        }
    }

    /** Whole days since the server last answered, while it is currently not answering. */
    private fun unreachableDays(today: LocalDate): Int? {
        val lastUnreachable = store.lastUnreachableAt ?: return null
        val lastReachable = store.lastReachableAt ?: store.configuredAt ?: return null
        if (lastUnreachable < lastReachable) return null
        val since = java.time.Instant.ofEpochMilli(lastReachable).atZone(clock.zone()).toLocalDate()
        return ChronoUnit.DAYS.between(since, today).toInt().takeIf { it >= 1 }
    }

    private fun nudgeDue(today: LocalDate, nudgeDays: Int): Boolean {
        if (nudgeDays <= 0) return false
        val days = unreachableDays(today) ?: return false
        if (days < nudgeDays) return false
        val lastNudge = store.lastNudgeDay?.let { runCatching { LocalDate.parse(it) }.getOrNull() } ?: return true
        return ChronoUnit.DAYS.between(lastNudge, today) >= nudgeDays
    }
}
