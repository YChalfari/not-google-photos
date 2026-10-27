package com.notgooglephotos.photosync

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import androidx.activity.result.ActivityResult
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import com.notgooglephotos.photosync.engine.RunOptions
import com.notgooglephotos.photosync.engine.RunTrigger
import com.notgooglephotos.photosync.engine.SyncPhase
import com.notgooglephotos.photosync.model.SyncSettings
import com.notgooglephotos.photosync.model.SyncTrigger
import com.notgooglephotos.photosync.model.TimeOfDay
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

private const val PERMISSION_IMAGES = "images"
private const val PERMISSION_VIDEO = "video"
private const val PERMISSION_SELECTED = "selected"
private const val PERMISSION_STORAGE = "storage"
private const val PERMISSION_LOCATION = "location"
private const val PERMISSION_NOTIFICATIONS = "notifications"

@CapacitorPlugin(
    name = "PhotoSync",
    permissions = [
        Permission(strings = [Manifest.permission.READ_MEDIA_IMAGES], alias = PERMISSION_IMAGES),
        Permission(strings = [Manifest.permission.READ_MEDIA_VIDEO], alias = PERMISSION_VIDEO),
        Permission(strings = [Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED], alias = PERMISSION_SELECTED),
        Permission(strings = [Manifest.permission.READ_EXTERNAL_STORAGE], alias = PERMISSION_STORAGE),
        Permission(strings = [Manifest.permission.ACCESS_MEDIA_LOCATION], alias = PERMISSION_LOCATION),
        Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = PERMISSION_NOTIFICATIONS),
    ],
)
class PhotoSyncPlugin : Plugin() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private lateinit var runtime: PhotoSyncRuntime

    override fun load() {
        runtime = PhotoSyncRuntime.get(context)
        runtime.notifier.ensureChannels()
        scope.launch(Dispatchers.Default) {
            var lastKey = ""
            var lastProgressAt = 0L
            runtime.engine.state.collect { state ->
                val json = try {
                    withContext(Dispatchers.IO) { runtime.status.snapshot() }
                } catch (e: Exception) {
                    Log.w(TAG, "Status update failed", e)
                    return@collect
                }
                val key = listOf(
                    json.opt("phase"),
                    json.opt("waitingFor"),
                    json.opt("counts"),
                    json.opt("lastRun"),
                    json.opt("nextRetryAt"),
                    json.opt("todayNotBackedUp"),
                    json.opt("firstBackup"),
                ).joinToString()
                val payload = JSObject(json.toString())
                if (key != lastKey) {
                    lastKey = key
                    withContext(Dispatchers.Main) { notifyListeners("statusChanged", payload) }
                }
                if (state.phase != SyncPhase.IDLE) {
                    val now = android.os.SystemClock.elapsedRealtime()
                    if (now - lastProgressAt >= PROGRESS_MIN_GAP_MS) {
                        lastProgressAt = now
                        withContext(Dispatchers.Main) { notifyListeners("progress", JSObject(json.toString())) }
                    }
                }
            }
        }
    }

    override fun handleOnDestroy() {
        scope.cancel()
    }

    @PluginMethod
    override fun checkPermissions(call: PluginCall) {
        call.resolve(permissionStatus())
    }

    @PluginMethod
    override fun requestPermissions(call: PluginCall) {
        val aliases = permissionAliases()
        if (aliases.isEmpty() || aliases.all { getPermissionState(it) == PermissionState.GRANTED }) {
            call.resolve(permissionStatus())
            return
        }
        requestPermissionForAliases(aliases, call, "permissionsCallback")
    }

    @PermissionCallback
    private fun permissionsCallback(call: PluginCall) {
        val start = runtime.store.isConfigured && runtime.store.settings.enabled && !runtime.store.needsPairing
        if (start && runtime.library.hasReadAccess()) launchSync(fullScan = false)
        call.resolve(permissionStatus())
    }

    @PluginMethod
    fun configure(call: PluginCall) {
        val raw = call.data.toString()
        scope.launch(Dispatchers.IO) {
            try {
                val applied = runtime.coordinator.apply(JSONObject(raw))
                if (applied.sync && runtime.library.hasReadAccess()) launchSync(applied.fullScan)
                call.resolve()
            } catch (e: IllegalArgumentException) {
                call.reject(e.message)
            } catch (e: Exception) {
                call.reject(e.message ?: "Couldn't save the backup settings")
            }
        }
    }

    @PluginMethod
    fun setSchedule(call: PluginCall) {
        try {
            val triggers = SyncTrigger.listFromJson(call.data.getJSONArray("triggers"))
            runtime.coordinator.setSchedule(triggers)
            call.resolve()
        } catch (e: Exception) {
            call.reject(e.message ?: "Couldn't save the schedule")
        }
    }

    @PluginMethod
    fun syncNow(call: PluginCall) {
        runtime.coordinator.syncNow()
        call.resolve()
    }

    @PluginMethod
    fun getStatus(call: PluginCall) {
        scope.launch(Dispatchers.IO) {
            try {
                call.resolve(JSObject(runtime.status.snapshot().toString()))
            } catch (e: Exception) {
                call.reject(e.message ?: "Couldn't read the backup status")
            }
        }
    }

    @PluginMethod
    fun getSettings(call: PluginCall) {
        call.resolve(settingsJson())
    }

    @PluginMethod
    fun listFolders(call: PluginCall) {
        scope.launch(Dispatchers.IO) {
            try {
                val selected = runtime.store.settings.folders
                val folders = JSArray()
                for (folder in runtime.library.listFolders()) {
                    val id = runCatching { SyncSettings.normalizeFolder(folder.relativePath) }.getOrNull() ?: continue
                    folders.put(
                        JSObject()
                            .put("id", id)
                            .put("name", folder.name.ifBlank { id.trim('/') })
                            .put("count", folder.count)
                            .put("selected", SyncSettings.isSelected(id, selected)),
                    )
                }
                call.resolve(JSObject().put("folders", folders))
            } catch (e: Exception) {
                call.reject(e.message ?: "Couldn't list folders")
            }
        }
    }

    @PluginMethod
    fun retryFailed(call: PluginCall) {
        scope.launch(Dispatchers.IO) {
            runtime.coordinator.retryFailed()
            call.resolve()
        }
    }

    @PluginMethod
    fun getFreeableSummary(call: PluginCall) {
        call.reject(NOT_YET)
    }

    @PluginMethod
    fun freeUpSpace(call: PluginCall) {
        call.reject(NOT_YET)
    }

    @PluginMethod
    fun scheduleMemoryNotifications(call: PluginCall) {
        val enabled = call.getBoolean("enabled", true) ?: true
        val time = if (enabled) {
            try {
                TimeOfDay.parse(call.getString("time") ?: "09:00")
            } catch (e: IllegalArgumentException) {
                call.reject(e.message)
                return
            }
        } else {
            null
        }
        scope.launch(Dispatchers.IO) {
            runtime.memories.setTime(time)
            call.resolve()
        }
    }

    @PluginMethod
    fun requestBatteryOptimizationExemption(call: PluginCall) {
        if (batteryExempt()) {
            call.resolve(JSObject().put("exempt", true))
            return
        }
        if (activity == null) {
            call.reject("Open the app to allow unrestricted battery use")
            return
        }
        val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).setData(Uri.parse("package:${context.packageName}"))
        try {
            startActivityForResult(call, intent, "batteryOptimizationResult")
        } catch (e: Exception) {
            call.reject("Allow unrestricted battery use for Not Google Photos in system settings")
        }
    }

    @ActivityCallback
    private fun batteryOptimizationResult(call: PluginCall, result: ActivityResult) {
        call.resolve(JSObject().put("exempt", batteryExempt()))
    }

    @PluginMethod
    fun discoverServers(call: PluginCall) {
        val timeout = (call.getInt("timeoutMs", 4_000) ?: 4_000).coerceIn(500, 15_000).toLong()
        scope.launch(Dispatchers.IO) {
            try {
                val found = JSArray()
                runtime.discovery.discover(timeout).forEach { found.put(JSObject(it.toJson().toString())) }
                call.resolve(JSObject().put("servers", found))
            } catch (e: Exception) {
                call.reject(e.message ?: "Couldn't look for servers")
            }
        }
    }

    @PluginMethod
    fun scanQrCode(call: PluginCall) {
        val host = activity
        if (host == null) {
            call.reject("Open the app to scan the pairing code")
            return
        }
        val options = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).enableAutoZoom().build()
        GmsBarcodeScanning.getClient(host, options).startScan()
            .addOnSuccessListener { barcode ->
                val value = barcode.rawValue
                if (value.isNullOrBlank()) call.reject("That QR code is empty") else call.resolve(JSObject().put("value", value))
            }
            .addOnCanceledListener { call.reject("Scan cancelled") }
            .addOnFailureListener { call.reject(it.message ?: "Couldn't scan the code") }
    }

    @PluginMethod
    fun pair(call: PluginCall) {
        val code = call.getString("code")?.trim().orEmpty()
        val deviceName = call.getString("deviceName")?.takeIf { it.isNotBlank() } ?: deviceName()
        val patch = JSONObject()
        val data = call.data
        for (key in listOf("homeUrl", "remoteUrl", "serverId")) {
            if (data.has(key)) patch.put(key, data.get(key))
        }
        scope.launch(Dispatchers.IO) {
            try {
                if (patch.length() > 0) runtime.coordinator.apply(patch)
                val paired = runtime.coordinator.pair(code, deviceName)
                if (runtime.library.hasReadAccess()) launchSync(fullScan = true)
                call.resolve(
                    JSObject()
                        .put("serverId", paired.serverId ?: JSONObject.NULL)
                        .put("deviceId", paired.deviceId ?: JSONObject.NULL)
                        .put("userName", paired.userName ?: JSONObject.NULL),
                )
            } catch (e: Exception) {
                call.reject(e.message ?: "Couldn't pair this phone")
            }
        }
    }

    private fun launchSync(fullScan: Boolean) {
        scope.launch(Dispatchers.IO) {
            runtime.engine.run(RunTrigger.SETTINGS, RunOptions(fullScan = fullScan))
        }
    }

    private fun permissionAliases(): Array<String> = buildList {
        if (Build.VERSION.SDK_INT >= 33) {
            add(PERMISSION_IMAGES)
            add(PERMISSION_VIDEO)
            if (Build.VERSION.SDK_INT >= 34) add(PERMISSION_SELECTED)
            add(PERMISSION_NOTIFICATIONS)
        } else {
            add(PERMISSION_STORAGE)
        }
        add(PERMISSION_LOCATION)
    }.toTypedArray()

    private fun permissionStatus(): JSObject {
        val media = when {
            Build.VERSION.SDK_INT >= 33 &&
                (getPermissionState(PERMISSION_IMAGES) == PermissionState.GRANTED || getPermissionState(PERMISSION_VIDEO) == PermissionState.GRANTED) -> "granted"
            Build.VERSION.SDK_INT >= 34 && getPermissionState(PERMISSION_SELECTED) == PermissionState.GRANTED -> "limited"
            Build.VERSION.SDK_INT < 33 && getPermissionState(PERMISSION_STORAGE) == PermissionState.GRANTED -> "granted"
            else -> combine(if (Build.VERSION.SDK_INT >= 33) listOf(PERMISSION_IMAGES, PERMISSION_VIDEO) else listOf(PERMISSION_STORAGE))
        }
        val notifications = if (Build.VERSION.SDK_INT >= 33) jsonState(getPermissionState(PERMISSION_NOTIFICATIONS)) else "granted"
        return JSObject()
            .put("media", media)
            .put("mediaLocation", jsonState(getPermissionState(PERMISSION_LOCATION)))
            .put("notifications", notifications)
            .put("batteryOptimizationExempt", batteryExempt())
    }

    private fun combine(aliases: List<String>): String {
        val states = aliases.map { getPermissionState(it) }
        return when {
            states.any { it == PermissionState.PROMPT_WITH_RATIONALE } -> "prompt-with-rationale"
            states.any { it == PermissionState.PROMPT } -> "prompt"
            else -> "denied"
        }
    }

    private fun jsonState(state: PermissionState): String = when (state) {
        PermissionState.GRANTED -> "granted"
        PermissionState.DENIED -> "denied"
        PermissionState.PROMPT_WITH_RATIONALE -> "prompt-with-rationale"
        else -> "prompt"
    }

    private fun batteryExempt(): Boolean {
        val power = context.getSystemService(PowerManager::class.java) ?: return true
        return power.isIgnoringBatteryOptimizations(context.packageName)
    }

    private fun settingsJson(): JSObject {
        val settings = runtime.store.settings
        val stored = JSONObject()
            .put("enabled", settings.enabled)
            .put("homeUrl", settings.homeUrl ?: JSONObject.NULL)
            .put("remoteUrl", settings.remoteUrl ?: JSONObject.NULL)
            .put("serverId", settings.serverId ?: JSONObject.NULL)
            .put("paired", runtime.store.deviceToken != null)
            .put("folders", JSONArray(settings.folders))
            .put("includeVideos", settings.includeVideos)
            .put("wifiOnly", settings.wifiOnly)
            .put("videosOnlyWhileCharging", settings.videosOnlyWhileCharging)
            .put("reminderTime", settings.reminderTime?.let(TimeOfDay::format) ?: JSONObject.NULL)
            .put("unreachableNudgeDays", settings.unreachableNudgeDays)
        val triggers = JSONArray()
        runtime.store.triggers.forEach { triggers.put(it.toJson()) }
        return JSObject()
            .put("settings", JSObject(stored.toString()))
            .put("triggers", JSArray(triggers.toString()))
            .put("memoryNotificationTime", runtime.store.memoryNotificationTime?.let(TimeOfDay::format) ?: JSONObject.NULL)
    }

    private fun deviceName(): String = listOf(Build.MANUFACTURER, Build.MODEL)
        .filter { !it.isNullOrBlank() && !it.equals("unknown", ignoreCase = true) }
        .distinct()
        .joinToString(" ")
        .ifBlank { "Android phone" }

    companion object {
        private const val TAG = "PhotoSync"
        private const val NOT_YET = "Free up space isn't available yet"
        private const val PROGRESS_MIN_GAP_MS = 400L
    }
}
