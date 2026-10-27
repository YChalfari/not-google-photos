package com.notgooglephotos.photosync.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.notgooglephotos.photosync.PhotoSyncRuntime
import com.notgooglephotos.photosync.engine.RunTrigger

/** "Try now" on the reminder: a manual run, which also skips any upload pause. */
class NotificationActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_TRY_NOW) return
        val runtime = PhotoSyncRuntime.get(context)
        runtime.notifier.cancelReminder()
        runtime.scheduler.runNow(RunTrigger.MANUAL)
    }

    companion object {
        const val ACTION_TRY_NOW = "com.notgooglephotos.photosync.action.TRY_NOW"
    }
}
