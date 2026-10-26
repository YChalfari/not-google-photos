package com.notgooglephotos.photosync.work

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.notgooglephotos.photosync.PhotoSyncRuntime
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * WorkManager restores its own work after a reboot; this re-arms what it can't: the memory
 * alarm, and time-of-day schedules after the clock or time zone changes.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val timeChanged = intent.action == Intent.ACTION_TIMEZONE_CHANGED || intent.action == Intent.ACTION_TIME_CHANGED
        val pending = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val runtime = PhotoSyncRuntime.get(context)
                runtime.scheduler.apply(recomputeTimes = timeChanged)
                runtime.memories.reschedule()
            } finally {
                pending.finish()
            }
        }
    }
}
