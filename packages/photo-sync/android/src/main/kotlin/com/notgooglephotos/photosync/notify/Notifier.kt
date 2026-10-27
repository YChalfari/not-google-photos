package com.notgooglephotos.photosync.notify

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.work.ForegroundInfo
import com.notgooglephotos.photosync.R
import com.notgooglephotos.photosync.engine.EngineState
import com.notgooglephotos.photosync.engine.SyncPhase
import com.notgooglephotos.photosync.queue.MemoryEntity

/** Why today's items are still waiting, which picks the reminder's second sentence. */
enum class ReminderCause { SERVER, WIFI, OFFLINE, CHARGING, FIRST_BACKUP, PAIRING, PERMISSION, OTHER }

class Notifier(private val context: Context) : UserAlerts {
    private val manager = NotificationManagerCompat.from(context)

    fun ensureChannels() {
        val system = context.getSystemService(NotificationManager::class.java) ?: return
        system.createNotificationChannels(
            listOf(
                channel(CHANNEL_PROGRESS, R.string.ngp_channel_progress, R.string.ngp_channel_progress_description, NotificationManager.IMPORTANCE_LOW),
                channel(CHANNEL_REMINDERS, R.string.ngp_channel_reminders, R.string.ngp_channel_reminders_description, NotificationManager.IMPORTANCE_LOW),
                channel(CHANNEL_MEMORIES, R.string.ngp_channel_memories, R.string.ngp_channel_memories_description, NotificationManager.IMPORTANCE_DEFAULT),
            ),
        )
    }

    fun canPost(): Boolean {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            return false
        }
        return manager.areNotificationsEnabled()
    }

    fun backupForegroundInfo(state: EngineState?): ForegroundInfo {
        ensureChannels()
        val notification = progressNotification(state, foreground = true)
        return if (Build.VERSION.SDK_INT >= 29) {
            ForegroundInfo(ID_PROGRESS, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            ForegroundInfo(ID_PROGRESS, notification)
        }
    }

    fun showBackupProgress(state: EngineState, foreground: Boolean) = post(ID_PROGRESS, progressNotification(state, foreground))

    fun clearBackupProgress() = manager.cancel(ID_PROGRESS)

    override fun showReminder(photos: Int, videos: Int, cause: ReminderCause, unreachableDays: Int?) {
        val total = photos + videos
        val items = describe(photos, videos)
        val first = context.resources.getQuantityString(R.plurals.ngp_reminder_today, total, items)
        val second = when (cause) {
            ReminderCause.SERVER ->
                if (unreachableDays != null && unreachableDays >= 1) {
                    context.resources.getQuantityString(R.plurals.ngp_cause_server_days, unreachableDays, unreachableDays)
                } else {
                    context.getString(R.string.ngp_cause_server)
                }
            ReminderCause.WIFI -> context.getString(R.string.ngp_cause_wifi)
            ReminderCause.OFFLINE -> context.getString(R.string.ngp_cause_offline)
            ReminderCause.CHARGING -> context.getString(R.string.ngp_cause_charging)
            ReminderCause.FIRST_BACKUP -> context.getString(R.string.ngp_cause_first_backup)
            ReminderCause.PAIRING -> context.getString(R.string.ngp_cause_pairing)
            ReminderCause.PERMISSION -> context.getString(R.string.ngp_cause_permission)
            ReminderCause.OTHER -> context.getString(R.string.ngp_cause_other)
        }
        val text = "$first $second"
        post(ID_REMINDER, alert(context.getString(R.string.ngp_reminder_title), text, withTryNow = cause != ReminderCause.PERMISSION && cause != ReminderCause.PAIRING))
    }

    override fun showNudge(photos: Int, videos: Int, days: Int) {
        val title = context.resources.getQuantityString(R.plurals.ngp_nudge_title, days, days)
        val text = context.resources.getQuantityString(R.plurals.ngp_nudge_text, photos + videos, describe(photos, videos))
        post(ID_REMINDER, alert(title, text, withTryNow = true))
    }

    override fun cancelReminder() = manager.cancel(ID_REMINDER)

    override fun showMemory(memory: MemoryEntity) {
        val cover = memory.coverPath?.let(::decodeCover)
        val builder = NotificationCompat.Builder(context, CHANNEL_MEMORIES)
            .setSmallIcon(R.drawable.ngp_ic_notification)
            .setContentTitle(memory.title)
            .setContentText(memory.subtitle ?: context.getString(R.string.ngp_memory_text))
            .setContentIntent(openApp(DeepLinks.memory(memory.id)))
            .setCategory(NotificationCompat.CATEGORY_RECOMMENDATION)
            .setAutoCancel(true)
        if (cover != null) {
            builder.setLargeIcon(cover).setStyle(NotificationCompat.BigPictureStyle().bigPicture(cover).bigLargeIcon(null as Bitmap?))
        }
        post(ID_MEMORY_BASE + (memory.id.hashCode() and 0x0fff), builder.build())
    }

    /** Opens the app at a web route through the `ngphotos://app` deep link. */
    fun openApp(path: String): PendingIntent {
        val uri = Uri.parse(DeepLinks.url(path))
        val intent = (context.packageManager.getLaunchIntentForPackage(context.packageName) ?: Intent().setPackage(context.packageName))
            .setAction(Intent.ACTION_VIEW)
            .setData(uri)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        return PendingIntent.getActivity(context, path.hashCode(), intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun alert(title: String, text: String, withTryNow: Boolean): Notification {
        val builder = NotificationCompat.Builder(context, CHANNEL_REMINDERS)
            .setSmallIcon(R.drawable.ngp_ic_notification)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(openApp(DeepLinks.BACKUP))
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setOnlyAlertOnce(true)
            .setAutoCancel(true)
        if (withTryNow) {
            val tryNow = PendingIntent.getBroadcast(
                context,
                REQUEST_TRY_NOW,
                Intent(context, NotificationActionReceiver::class.java).setAction(NotificationActionReceiver.ACTION_TRY_NOW),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            builder.addAction(0, context.getString(R.string.ngp_action_try_now), tryNow)
        }
        return builder.build()
    }

    private fun progressNotification(state: EngineState?, foreground: Boolean): Notification {
        val current = state?.current
        val text = when {
            current != null -> context.getString(R.string.ngp_progress_file, current.index, current.of, current.fileName)
            state?.phase == SyncPhase.CHECKING_SERVER -> context.getString(R.string.ngp_progress_checking)
            state?.phase == SyncPhase.SCANNING -> context.getString(R.string.ngp_progress_scanning)
            else -> context.getString(R.string.ngp_progress_preparing)
        }
        val builder = NotificationCompat.Builder(context, CHANNEL_PROGRESS)
            .setSmallIcon(R.drawable.ngp_ic_notification)
            .setContentTitle(context.getString(R.string.ngp_progress_title))
            .setContentText(text)
            .setContentIntent(openApp(DeepLinks.BACKUP))
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
        if (current != null) builder.setProgress(current.of, current.index - 1, false) else builder.setProgress(0, 0, true)
        // Without a foreground service nothing removes a stale notification if the process dies.
        if (!foreground) builder.setTimeoutAfter(STALE_PROGRESS_MS)
        return builder.build()
    }

    private fun describe(photos: Int, videos: Int): String {
        val photoText = context.resources.getQuantityString(R.plurals.ngp_photos, photos, photos)
        val videoText = context.resources.getQuantityString(R.plurals.ngp_videos, videos, videos)
        return when {
            videos == 0 -> photoText
            photos == 0 -> videoText
            else -> context.getString(R.string.ngp_and, photoText, videoText)
        }
    }

    private fun decodeCover(path: String): Bitmap? = runCatching {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(path, bounds)
        var sample = 1
        while (bounds.outWidth / (sample * 2) >= COVER_MAX_PX || bounds.outHeight / (sample * 2) >= COVER_MAX_PX) sample *= 2
        BitmapFactory.decodeFile(path, BitmapFactory.Options().apply { inSampleSize = sample })
    }.getOrNull()

    private fun post(id: Int, notification: Notification) {
        if (!canPost()) return
        ensureChannels()
        try {
            manager.notify(id, notification)
        } catch (e: SecurityException) {
            // The notification permission was revoked between the check and the post.
        }
    }

    private fun channel(id: String, name: Int, description: Int, importance: Int) =
        NotificationChannel(id, context.getString(name), importance).apply {
            this.description = context.getString(description)
            setShowBadge(id == CHANNEL_MEMORIES)
        }

    companion object {
        const val CHANNEL_PROGRESS = "ngp_backup_progress"
        const val CHANNEL_REMINDERS = "ngp_backup_reminders"
        const val CHANNEL_MEMORIES = "ngp_memories"
        const val ID_PROGRESS = 4101
        const val ID_REMINDER = 4102
        const val ID_MEMORY_BASE = 5000
        private const val REQUEST_TRY_NOW = 4201
        private const val COVER_MAX_PX = 1024
        private const val STALE_PROGRESS_MS = 15 * 60_000L
    }
}
