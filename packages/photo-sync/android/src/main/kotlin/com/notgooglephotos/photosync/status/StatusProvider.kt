package com.notgooglephotos.photosync.status

import com.notgooglephotos.photosync.engine.Clock
import com.notgooglephotos.photosync.engine.DeviceConditions
import com.notgooglephotos.photosync.engine.RunOutcome
import com.notgooglephotos.photosync.engine.SyncEngine
import com.notgooglephotos.photosync.engine.SyncPhase
import com.notgooglephotos.photosync.media.MediaLibrary
import com.notgooglephotos.photosync.queue.ItemState
import com.notgooglephotos.photosync.queue.MediaKind
import com.notgooglephotos.photosync.queue.SyncDatabase
import com.notgooglephotos.photosync.settings.SettingsStore
import org.json.JSONObject

/** Builds the `SyncStatus` object the web UI reads. */
class StatusProvider(
    private val db: SyncDatabase,
    private val store: SettingsStore,
    private val library: MediaLibrary,
    private val conditions: DeviceConditions,
    private val engine: SyncEngine,
    private val clock: Clock,
) {
    suspend fun snapshot(): JSONObject {
        val settings = store.settings
        val state = engine.state.value
        val counts = db.media().countsByState().associate { it.state to it.count }
        val backedUp = counts[ItemState.BACKED_UP] ?: 0
        val pending = counts[ItemState.PENDING] ?: 0
        val uploading = counts[ItemState.UPLOADING] ?: 0
        val failed = counts[ItemState.FAILED] ?: 0
        val today = todayNotBackedUp()
        val backlog = if (store.backlogCutoffMs != null) db.media().backlogRemaining() else 0
        val last = db.runs().latest()
        val now = clock.now()
        val retryAt = store.uploadsPausedUntil?.takeIf { it > now }
        val current = state.current?.takeIf { state.phase != SyncPhase.IDLE }

        return JSONObject()
            .put("platform", "android")
            .put("available", true)
            .put("configured", store.isConfigured)
            .put("enabled", settings.enabled)
            .put("phase", state.phase.js)
            .put("waitingFor", waitingFor(settings, state.phase, pending, uploading, failed, backlog, last?.outcome) ?: JSONObject.NULL)
            .put(
                "counts",
                JSONObject()
                    .put("backedUp", backedUp)
                    .put("pending", pending)
                    .put("uploading", uploading)
                    .put("failed", failed)
                    .put("total", backedUp + pending + uploading + failed),
            )
            .put("todayNotBackedUp", today)
            .put(
                "current",
                current?.let {
                    JSONObject()
                        .put("fileName", it.fileName)
                        .put("bytesSent", it.bytesSent)
                        .put("bytesTotal", it.bytesTotal)
                        .put("index", it.index)
                        .put("of", it.of)
                } ?: JSONObject.NULL,
            )
            .put(
                "lastRun",
                last?.let {
                    JSONObject()
                        .put("trigger", it.trigger)
                        .put("startedAt", it.startedAt)
                        .put("finishedAt", it.finishedAt ?: JSONObject.NULL)
                        .put("outcome", it.outcome ?: JSONObject.NULL)
                        .put("uploaded", it.uploaded)
                        .put("failed", it.failed)
                        .put("message", it.message ?: JSONObject.NULL)
                } ?: JSONObject.NULL,
            )
            .put("lastSuccessfulBackupAt", store.lastSuccessAt ?: JSONObject.NULL)
            .put("lastServerContactAt", store.lastReachableAt ?: JSONObject.NULL)
            .put("firstBackup", JSONObject().put("complete", store.firstBackupComplete).put("remaining", backlog))
            .put("nextRetryAt", retryAt ?: JSONObject.NULL)
    }

    private suspend fun todayNotBackedUp(): Int {
        val start = clock.startOf(clock.today())
        return db.media().notBackedUpBetween(start, clock.startOf(clock.today().plusDays(1))).sumOf { it.count }
    }

    private suspend fun waitingFor(
        settings: com.notgooglephotos.photosync.model.SyncSettings,
        phase: SyncPhase,
        pending: Int,
        uploading: Int,
        failed: Int,
        backlog: Int,
        lastOutcome: String?,
    ): String? {
        if (!store.isConfigured) return "setup"
        if (!settings.enabled) return "disabled"
        if (store.needsPairing) return "pairing"
        if (!library.hasReadAccess()) return "permission"
        if (phase != SyncPhase.IDLE) return null
        val paused = store.uploadsPausedUntil?.let { it > clock.now() } == true
        if (paused && pending + uploading + failed > 0) return "backoff"
        if (!store.firstBackupComplete && backlog > 0) return "firstBackup"
        val network = conditions.network()
        if (pending > 0 && settings.wifiOnly && !network.unmetered) return "wifi"
        if (pending > 0 && !network.connected) return "network"
        if (pending > 0 && settings.includeVideos && settings.videosOnlyWhileCharging && !conditions.isCharging()) {
            val breakdown = db.media().pendingBreakdown()
            val photos = breakdown.filter { it.kind == MediaKind.IMAGE }.sumOf { it.count }
            val videos = breakdown.filter { it.kind == MediaKind.VIDEO && !it.backlog }.sumOf { it.count }
            if (photos == 0 && videos > 0) return "charging"
        }
        val outcome = RunOutcome.fromJs(lastOutcome)
        if ((pending > 0 || backlog > 0) &&
            (outcome == RunOutcome.SERVER_UNREACHABLE || outcome == RunOutcome.UPLOAD_FAILED || outcome == RunOutcome.WAITING_FOR_CHARGING)
        ) {
            return if (outcome == RunOutcome.WAITING_FOR_CHARGING) "charging" else "server"
        }
        if (outcome == RunOutcome.WAITING_FOR_WIFI && pending + backlog > 0) return "wifi"
        if (outcome == RunOutcome.WAITING_FOR_NETWORK && pending + backlog > 0) return "network"
        return null
    }
}
