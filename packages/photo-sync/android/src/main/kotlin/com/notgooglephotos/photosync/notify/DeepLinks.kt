package com.notgooglephotos.photosync.notify

import android.net.Uri

/**
 * Notification taps open the app with `ngphotos://app/<web route>`. The app shell receives it as
 * an ACTION_VIEW intent (Capacitor's `appUrlOpen`) and routes the web UI to the path.
 */
object DeepLinks {
    const val SCHEME = "ngphotos"
    const val HOST = "app"
    const val BACKUP = "/backup"

    fun memory(id: String): String = "/memories/${Uri.encode(id)}"

    fun url(path: String): String = "$SCHEME://$HOST$path"
}
