package com.notgooglephotos.photosync.work

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.notgooglephotos.photosync.PhotoSyncRuntime

/** The end-of-day check (A5). Re-arms itself for the same time tomorrow. */
class ReminderWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val runtime = PhotoSyncRuntime.get(applicationContext)
        runtime.reminder.check()
        if (!isStopped) runtime.scheduler.rearmReminder()
        return Result.success()
    }
}
