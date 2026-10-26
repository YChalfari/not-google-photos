package com.notgooglephotos.photosync.notify

import com.notgooglephotos.photosync.queue.MemoryEntity

/** The notifications the engine can raise. [Notifier] posts them; tests record them. */
interface UserAlerts {
    fun showReminder(photos: Int, videos: Int, cause: ReminderCause, unreachableDays: Int?)

    fun showNudge(photos: Int, videos: Int, days: Int)

    fun cancelReminder()

    fun showMemory(memory: MemoryEntity)
}
