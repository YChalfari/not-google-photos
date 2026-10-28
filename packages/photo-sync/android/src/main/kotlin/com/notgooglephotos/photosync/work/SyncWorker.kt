package com.notgooglephotos.photosync.work

import android.content.Context
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters
import com.notgooglephotos.photosync.PhotoSyncRuntime
import com.notgooglephotos.photosync.engine.RunOptions
import com.notgooglephotos.photosync.engine.RunTrigger
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlin.coroutines.cancellation.CancellationException

/** Runs the engine once for whichever trigger enqueued it. It never asks WorkManager to retry. */
class SyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val runtime = PhotoSyncRuntime.get(applicationContext)
        val trigger = RunTrigger.fromJs(inputData.getString(KEY_TRIGGER)) ?: RunTrigger.MANUAL
        val firstBackup = trigger == RunTrigger.FIRST_BACKUP
        coroutineScope {
            val progress = if (firstBackup) launch { showProgress(runtime) } else null
            try {
                val report = runtime.engine.run(trigger, RunOptions(waitIfBusy = firstBackup || trigger == RunTrigger.MANUAL))
                Log.i(TAG, "${trigger.js} -> ${report.outcome?.js ?: "busy"} uploaded=${report.uploaded} failed=${report.failed} requests=${report.requests} ${report.message.orEmpty()}")
            } finally {
                progress?.cancel()
                if (firstBackup) runtime.notifier.clearBackupProgress()
            }
        }
        if (!isStopped) runtime.scheduler.rearm(trigger)
        return Result.success()
    }

    /** Expedited work runs as a foreground service before Android 12, which needs this notification. */
    override suspend fun getForegroundInfo(): ForegroundInfo {
        val runtime = PhotoSyncRuntime.get(applicationContext)
        return runtime.notifier.backupForegroundInfo(runtime.engine.state.value)
    }

    private suspend fun showProgress(runtime: PhotoSyncRuntime) = coroutineScope {
        val foreground = try {
            setForeground(runtime.notifier.backupForegroundInfo(runtime.engine.state.value))
            true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // Android 12+ refuses foreground services started from the background unless the app is
            // exempt from battery optimization. The backup still runs, in WorkManager's normal time slices.
            false
        }
        var shown: Any? = null
        while (isActive) {
            val state = runtime.engine.state.value
            val current = state.current
            val key = Triple(state.phase, current?.index, current?.let { it.bytesSent * 20 / maxOf(1L, it.bytesTotal) })
            if (key != shown) {
                runtime.notifier.showBackupProgress(state, foreground)
                shown = key
            }
            delay(PROGRESS_INTERVAL_MS)
        }
    }

    companion object {
        const val KEY_TRIGGER = "trigger"
        private const val TAG = "PhotoSync"
        private const val PROGRESS_INTERVAL_MS = 1_000L
    }
}
