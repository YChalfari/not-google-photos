package com.notgooglephotos.photosync.engine

import com.notgooglephotos.photosync.model.SyncSettings
import com.notgooglephotos.photosync.model.SyncTrigger
import com.notgooglephotos.photosync.net.ApiResult
import com.notgooglephotos.photosync.net.PairResult
import com.notgooglephotos.photosync.net.ServerResolver
import com.notgooglephotos.photosync.queue.SyncDatabase
import com.notgooglephotos.photosync.settings.SettingsStore
import com.notgooglephotos.photosync.work.SyncScheduler
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.atomic.AtomicInteger

/** Saves settings, pairs this phone, and decides when a run should follow. */
class BackupCoordinator(
    private val db: SyncDatabase,
    private val store: SettingsStore,
    private val scheduler: SyncScheduler,
    private val resolver: ServerResolver,
    private val conditions: DeviceConditions,
    private val clock: Clock,
) {
    data class Applied(val sync: Boolean, val fullScan: Boolean)

    data class DeviceConnection(val baseUrl: String, val token: String, val serverId: String?)

    /** Merges [patch] (a `SyncSettings` object, plus `deviceToken`) and re-arms schedules. */
    suspend fun apply(patch: JSONObject): Applied {
        val hadToken = !store.deviceToken.isNullOrBlank()
        val hadServer = store.settings.hasServer
        if (patch.has("deviceToken")) {
            val token = patch.optString("deviceToken", "").trim()
            store.deviceToken = token.ifEmpty { null }
        }
        var serverChanged = false
        var grew = false
        store.updateSettings { previous ->
            val next = previous.merge(patch)
            serverChanged = next.homeUrl != previous.homeUrl ||
                next.remoteUrl != previous.remoteUrl ||
                (next.serverId != null && previous.serverId != null && next.serverId != previous.serverId)
            grew = SyncSettings.grew(previous, next)
            next
        }
        if (serverChanged) {
            db.media().resetForNewServer()
            db.memories().deleteOlderThan(Long.MAX_VALUE)
            store.firstBackupComplete = false
            store.backlogCutoffMs = null
            store.uploadsPausedUntil = null
            store.consecutiveUploadFailures = 0
            store.lastSuccessAt = null
            store.lastReachableAt = null
            store.lastUnreachableAt = null
            store.memoriesRefreshedAt = null
            if (store.deviceToken.isNullOrBlank()) store.needsPairing = true
        }
        if (!store.deviceToken.isNullOrBlank()) store.needsPairing = false
        var fullScan = grew || serverChanged
        if (store.isConfigured) {
            if (store.configuredAt == null) store.configuredAt = clock.now()
            if (store.backlogCutoffMs == null || grew) {
                store.backlogCutoffMs = clock.now()
                if (grew) store.firstBackupComplete = false
                fullScan = true
            }
        }
        scheduler.apply()
        val firstConnection = store.isConfigured && (!hadToken || !hadServer)
        val sync = store.isConfigured && !store.needsPairing && store.settings.enabled && (firstConnection || grew || serverChanged)
        return Applied(sync, fullScan)
    }

    /** Redeems a pairing code against whichever address answers, then stores the device token. */
    suspend fun pair(code: String, deviceName: String): PairResult {
        val trimmed = code.trim()
        require(trimmed.isNotEmpty()) { "Enter the code from your server" }
        val settings = store.settings
        require(settings.hasServer) { "Set the server address first" }
        val network = conditions.network()
        if (!network.connected) throw IOException("The phone is offline")
        val found = when (val result = resolver.resolve(settings, token = null, network, AtomicInteger())) {
            is ServerResolver.Result.Unreachable -> throw IOException(result.message.ifBlank { "The server didn't answer" })
            is ServerResolver.Result.Reachable -> result
        }
        val paired = when (val result = found.client.pair(trimmed, deviceName)) {
            is ApiResult.Ok -> result.value
            ApiResult.Unauthorized -> throw IllegalArgumentException("That pairing code isn't valid anymore. Create a new one on the server.")
            is ApiResult.HttpError -> throw IllegalArgumentException(result.message)
            is ApiResult.NetworkError -> throw IOException(result.message)
        }
        val patch = JSONObject().put("deviceToken", paired.deviceToken)
        (paired.serverId ?: found.serverId)?.let { patch.put("serverId", it) }
        found.movedHome?.let { patch.put("homeUrl", it) }
        apply(patch)
        return paired
    }

    /**
     * The address and token the bundled UI should use. Null when this phone has no token or no
     * server address. A paired phone whose server is down still gets its stored address.
     */
    suspend fun connection(): DeviceConnection? {
        val token = store.deviceToken?.takeIf { it.isNotBlank() } ?: return null
        val settings = store.settings
        if (!settings.hasServer) return null
        val network = conditions.network()
        return when (val found = resolver.resolve(settings, token, network, AtomicInteger())) {
            is ServerResolver.Result.Reachable -> {
                if (found.movedHome != null || (found.serverId != null && settings.serverId == null)) {
                    store.updateSettings { current ->
                        current.copy(
                            homeUrl = found.movedHome ?: current.homeUrl,
                            serverId = current.serverId ?: found.serverId,
                        )
                    }
                }
                DeviceConnection(
                    baseUrl = found.address.trimEnd('/'),
                    token = token,
                    serverId = found.serverId ?: store.settings.serverId,
                )
            }
            is ServerResolver.Result.Unreachable -> {
                val fallback = if (network.local) {
                    settings.homeUrl ?: settings.remoteUrl
                } else {
                    settings.remoteUrl ?: settings.homeUrl
                }
                fallback?.let { DeviceConnection(it.trimEnd('/'), token, settings.serverId) }
            }
        }
    }

    fun setSchedule(triggers: List<SyncTrigger>) {
        store.triggers = triggers
        scheduler.apply()
    }

    private fun freeUp() = FreeUp(db, store, conditions, resolver, clock)

    /** Backed-up files the server still has. Rejects when that check cannot be made. */
    suspend fun freeable(filter: FreeUpFilter): FreeableSummary = freeUp().summarize(filter)

    /** The files to delete, after the same server check. Does not delete anything itself. */
    suspend fun prepareDeletion(filter: FreeUpFilter): DeletionPlan = freeUp().prepare(filter)

    suspend fun markDeletedFromPhone(ids: List<Long>) {
        db.media().markNotPresent(ids)
    }

    fun syncNow() = scheduler.runNow()

    suspend fun retryFailed() {
        db.media().resetFailed()
        store.uploadsPausedUntil = null
        store.consecutiveUploadFailures = 0
        scheduler.cancelBackoffRetry()
        scheduler.runNow()
    }
}
