package com.notgooglephotos.photosync.media

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.MediaStore

/**
 * Capacitor can only receive a result from an activity it started. MediaStore's delete request is
 * an intent sender, so this transparent activity launches that request and forwards the result.
 */
class MediaDeleteActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (savedInstanceState != null) return
        val uris = intent.getStringArrayListExtra(EXTRA_URIS).orEmpty().map(Uri::parse)
        if (uris.isEmpty() || Build.VERSION.SDK_INT < 30) {
            finishWithError("This Android version can't delete these photos")
            return
        }
        try {
            val pending = MediaStore.createDeleteRequest(contentResolver, uris)
            @Suppress("DEPRECATION")
            startIntentSenderForResult(pending.intentSender, REQUEST_DELETE, null, 0, 0, 0)
        } catch (e: Exception) {
            finishWithError(e.message ?: "Couldn't ask Android to delete these photos")
        }
    }

    @Deprecated("Activity result API is not available without a ComponentActivity host.")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode != REQUEST_DELETE) return
        setResult(resultCode)
        finish()
    }

    private fun finishWithError(message: String) {
        setResult(RESULT_CANCELED, Intent().putExtra(EXTRA_ERROR, message))
        finish()
    }

    companion object {
        const val EXTRA_URIS = "uris"
        const val EXTRA_ERROR = "error"
        private const val REQUEST_DELETE = 1
    }
}
