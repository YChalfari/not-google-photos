package com.notgooglephotos.photosync.work

import android.content.Context
import android.provider.MediaStore
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.PeriodicWorkRequest
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.workDataOf
import com.notgooglephotos.photosync.engine.Clock
import com.notgooglephotos.photosync.engine.FollowUps
import com.notgooglephotos.photosync.engine.RunTrigger
import com.notgooglephotos.photosync.model.SyncSettings
import com.notgooglephotos.photosync.model.SyncTrigger
import com.notgooglephotos.photosync.settings.SettingsStore
import java.time.Duration
import java.time.LocalTime

/**
 * Owns every WorkManager schedule (A4). Each kind of wake-up has one unique work name, so there
 * is never more than one of each pending:
 *
 * - new media: a content-URI trigger on MediaStore; the update delay is the debounce and the max
 *   delay caps long bursts. Re-armed after each run.
 * - interval: periodic work (15 minutes at the shortest).
 * - times of day: one-off work for the next listed time, re-armed after each run.
 * - reconcile: the daily safety net (a full rescan).
 * - first backup: unmetered Wi-Fi, and charging unless the phone is allowed to back up on battery.
 * - when on Wi-Fi / online / charging, and the backoff retry: the "next natural moment" wake-ups.
 * - reminder: the end-of-day check.
 */
class SyncScheduler(
    private val context: Context,
    private val store: SettingsStore,
    private val clock: Clock,
) : FollowUps {
    private val workManager: WorkManager get() = WorkManager.getInstance(context)

    /**
     * Re-arms every schedule from the stored settings and triggers. Schedules whose spec didn't
     * change keep their timers; [recomputeTimes] reschedules time-of-day work after a clock or
     * time zone change.
     */
    @Synchronized
    fun apply(recomputeTimes: Boolean = false) {
        val settings = store.settings
        val active = isActive(settings)
        val network = networkFor(settings)
        val triggers = if (active) store.triggers else emptyList()

        val onNewMedia = triggers.filterIsInstance<SyncTrigger.OnNewMedia>().firstOrNull()
        if (onNewMedia == null) {
            cancel(NEW_MEDIA)
        } else {
            oneTime(NEW_MEDIA, "${onNewMedia.debounceSec}s/${onNewMedia.maxDelayMin}m/$network", newMediaRequest(onNewMedia, network))
        }

        val interval = triggers.filterIsInstance<SyncTrigger.Interval>().firstOrNull()
        if (interval == null) cancel(INTERVAL) else periodic(INTERVAL, "${interval.everyMin}m/$network", intervalRequest(interval.everyMin, network))

        val timesOfDay = triggers.filterIsInstance<SyncTrigger.TimesOfDay>().firstOrNull()
        if (timesOfDay == null) {
            cancel(TIMES_OF_DAY)
        } else {
            oneTime(TIMES_OF_DAY, "${timesOfDay.times}/$network", timesOfDayRequest(timesOfDay.times, network), replace = recomputeTimes)
        }

        if (active) {
            periodic(RECONCILE, "daily/$network", reconcileRequest(network))
            if (!store.firstBackupComplete) ensureFirstBackup()
        } else {
            listOf(RECONCILE, FIRST_BACKUP, WHEN_WIFI, WHEN_ONLINE, WHEN_CHARGING, BACKOFF).forEach(::cancel)
        }

        // The reminder also covers "pair this phone again", so it stays on while pairing is needed.
        val reminderTime = settings.reminderTime.takeIf { store.isConfigured && settings.enabled }
        if (reminderTime == null) cancel(REMINDER) else oneTime(REMINDER, "$reminderTime", reminderRequest(reminderTime), replace = recomputeTimes)
    }

    /** "Back up now": expedited, no constraints, so the engine reports right away why it can't run. */
    fun runNow(trigger: RunTrigger = RunTrigger.MANUAL) {
        val request = syncRequest(trigger) { setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST) }
        workManager.enqueueUniqueWork(MANUAL, ExistingWorkPolicy.KEEP, request)
    }

    /** Called by the worker after a normal finish: the one-shot triggers arm their next round. */
    fun rearm(trigger: RunTrigger) {
        val settings = store.settings
        if (!isActive(settings)) return
        val network = networkFor(settings)
        when (trigger) {
            RunTrigger.ON_NEW_MEDIA -> store.triggers.filterIsInstance<SyncTrigger.OnNewMedia>().firstOrNull()?.let {
                workManager.enqueueUniqueWork(NEW_MEDIA, ExistingWorkPolicy.APPEND_OR_REPLACE, newMediaRequest(it, network))
            }
            RunTrigger.TIMES_OF_DAY -> store.triggers.filterIsInstance<SyncTrigger.TimesOfDay>().firstOrNull()?.let {
                workManager.enqueueUniqueWork(TIMES_OF_DAY, ExistingWorkPolicy.APPEND_OR_REPLACE, timesOfDayRequest(it.times, network))
            }
            else -> Unit
        }
    }

    fun rearmReminder() {
        val settings = store.settings
        val time = settings.reminderTime ?: return
        if (!store.isConfigured || !settings.enabled) return
        workManager.enqueueUniqueWork(REMINDER, ExistingWorkPolicy.APPEND_OR_REPLACE, reminderRequest(time))
    }

    fun cancelAll() {
        ALL.forEach(::cancel)
    }

    override fun whenOnline(unmetered: Boolean) {
        val name = if (unmetered) WHEN_WIFI else WHEN_ONLINE
        val trigger = if (unmetered) RunTrigger.WIFI else RunTrigger.NETWORK
        val type = if (unmetered) NetworkType.UNMETERED else NetworkType.CONNECTED
        wake(name, syncRequest(trigger) { setConstraints(constraints(type)) })
    }

    override fun whenCharging() {
        val request = syncRequest(RunTrigger.CHARGING) {
            setConstraints(Constraints.Builder().setRequiredNetworkType(networkFor(store.settings)).setRequiresCharging(true).build())
        }
        wake(WHEN_CHARGING, request)
    }

    override fun ensureFirstBackup() {
        val charging = store.settings.requireCharging
        val spec = if (charging) "unmetered+charging" else "unmetered"
        val request = syncRequest(RunTrigger.FIRST_BACKUP) {
            val constraints = Constraints.Builder().setRequiredNetworkType(NetworkType.UNMETERED)
            if (charging) constraints.setRequiresCharging(true)
            setConstraints(constraints.build())
        }
        // Replacing this work from inside its own worker would cancel the run that is re-arming it.
        if (isRunning(FIRST_BACKUP)) {
            wake(FIRST_BACKUP, request)
            store.setWorkSpec(FIRST_BACKUP, spec)
        } else {
            oneTime(FIRST_BACKUP, spec, request)
        }
    }

    /**
     * One pending wake-up per name. KEEP while one is already waiting; if the wake-up's own worker
     * is the caller, APPEND_OR_REPLACE chains exactly one continuation instead of dropping it.
     */
    private fun wake(name: String, request: OneTimeWorkRequest) {
        val policy = if (isRunning(name)) ExistingWorkPolicy.APPEND_OR_REPLACE else ExistingWorkPolicy.KEEP
        workManager.enqueueUniqueWork(name, policy, request)
    }

    override fun retryAfterBackoff(atMs: Long) {
        val request = syncRequest(RunTrigger.BACKOFF) {
            setInitialDelay(Duration.ofMillis((atMs - clock.now()).coerceAtLeast(0)))
            setConstraints(constraints(networkFor(store.settings)))
        }
        // Replacing the backoff work from inside it would cancel the run that is asking.
        val policy = if (isRunning(BACKOFF)) ExistingWorkPolicy.APPEND_OR_REPLACE else ExistingWorkPolicy.REPLACE
        workManager.enqueueUniqueWork(BACKOFF, policy, request)
    }

    override fun cancelBackoffRetry() {
        if (!isRunning(BACKOFF)) cancel(BACKOFF)
    }

    private fun isActive(settings: SyncSettings) = store.isConfigured && settings.enabled && !store.needsPairing

    private fun isRunning(name: String): Boolean = runCatching {
        workManager.getWorkInfosForUniqueWork(name).get().any { it.state == WorkInfo.State.RUNNING }
    }.getOrDefault(false)

    private fun oneTime(name: String, spec: String, request: OneTimeWorkRequest, replace: Boolean = false) {
        val policy = if (!replace && store.workSpec(name) == spec) ExistingWorkPolicy.KEEP else ExistingWorkPolicy.REPLACE
        workManager.enqueueUniqueWork(name, policy, request)
        store.setWorkSpec(name, spec)
    }

    private fun periodic(name: String, spec: String, request: PeriodicWorkRequest) {
        val policy = if (store.workSpec(name) == spec) ExistingPeriodicWorkPolicy.KEEP else ExistingPeriodicWorkPolicy.UPDATE
        workManager.enqueueUniquePeriodicWork(name, policy, request)
        store.setWorkSpec(name, spec)
    }

    private fun cancel(name: String) {
        workManager.cancelUniqueWork(name)
        store.setWorkSpec(name, null)
    }

    private fun newMediaRequest(trigger: SyncTrigger.OnNewMedia, network: NetworkType) = syncRequest(RunTrigger.ON_NEW_MEDIA) {
        setConstraints(
            Constraints.Builder()
                .setRequiredNetworkType(network)
                .setRequiresBatteryNotLow(true)
                .addContentUriTrigger(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, true)
                .addContentUriTrigger(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, true)
                .setTriggerContentUpdateDelay(Duration.ofSeconds(trigger.debounceSec))
                .setTriggerContentMaxDelay(Duration.ofMinutes(trigger.maxDelayMin))
                .build(),
        )
    }

    private fun intervalRequest(everyMin: Long, network: NetworkType): PeriodicWorkRequest =
        PeriodicWorkRequestBuilder<SyncWorker>(Duration.ofMinutes(everyMin))
            .setConstraints(constraints(network))
            .setInputData(workDataOf(SyncWorker.KEY_TRIGGER to RunTrigger.INTERVAL.js))
            .addTag(TAG)
            .build()

    private fun timesOfDayRequest(times: List<LocalTime>, network: NetworkType) = syncRequest(RunTrigger.TIMES_OF_DAY) {
        setInitialDelay(Duration.ofMillis(Schedules.delayUntilNext(clock.now(), times, clock.zone())))
        setConstraints(constraints(network))
    }

    private fun reconcileRequest(network: NetworkType): PeriodicWorkRequest =
        PeriodicWorkRequestBuilder<SyncWorker>(Duration.ofDays(1))
            .setInitialDelay(Duration.ofMillis(Schedules.delayUntilNext(clock.now(), listOf(RECONCILE_TIME), clock.zone())))
            .setConstraints(constraints(network))
            .setInputData(workDataOf(SyncWorker.KEY_TRIGGER to RunTrigger.RECONCILE.js))
            .addTag(TAG)
            .build()

    private fun reminderRequest(time: LocalTime): OneTimeWorkRequest =
        OneTimeWorkRequestBuilder<ReminderWorker>()
            .setInitialDelay(Duration.ofMillis(Schedules.delayUntilNext(clock.now(), listOf(time), clock.zone())))
            .addTag(TAG)
            .build()

    private fun syncRequest(trigger: RunTrigger, configure: OneTimeWorkRequest.Builder.() -> Unit = {}): OneTimeWorkRequest =
        OneTimeWorkRequestBuilder<SyncWorker>()
            .setInputData(workDataOf(SyncWorker.KEY_TRIGGER to trigger.js))
            .addTag(TAG)
            .apply(configure)
            .build()

    private fun constraints(network: NetworkType): Constraints =
        Constraints.Builder().setRequiredNetworkType(network).setRequiresBatteryNotLow(true).build()

    private fun networkFor(settings: SyncSettings): NetworkType = if (settings.wifiOnly) NetworkType.UNMETERED else NetworkType.CONNECTED

    companion object {
        const val TAG = "ngp.photosync"
        const val NEW_MEDIA = "ngp.photosync.newMedia"
        const val INTERVAL = "ngp.photosync.interval"
        const val TIMES_OF_DAY = "ngp.photosync.timesOfDay"
        const val RECONCILE = "ngp.photosync.reconcile"
        const val FIRST_BACKUP = "ngp.photosync.firstBackup"
        const val MANUAL = "ngp.photosync.manual"
        const val WHEN_WIFI = "ngp.photosync.whenWifi"
        const val WHEN_ONLINE = "ngp.photosync.whenOnline"
        const val WHEN_CHARGING = "ngp.photosync.whenCharging"
        const val BACKOFF = "ngp.photosync.backoff"
        const val REMINDER = "ngp.photosync.reminder"

        val ALL = listOf(NEW_MEDIA, INTERVAL, TIMES_OF_DAY, RECONCILE, FIRST_BACKUP, MANUAL, WHEN_WIFI, WHEN_ONLINE, WHEN_CHARGING, BACKOFF, REMINDER)

        private val RECONCILE_TIME: LocalTime = LocalTime.of(3, 0)
    }
}
