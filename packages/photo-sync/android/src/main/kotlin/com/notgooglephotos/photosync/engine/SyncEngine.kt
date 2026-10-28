package com.notgooglephotos.photosync.engine

import com.notgooglephotos.photosync.media.Hasher
import com.notgooglephotos.photosync.media.MediaGoneException
import com.notgooglephotos.photosync.media.MediaIndexer
import com.notgooglephotos.photosync.media.MediaLibrary
import com.notgooglephotos.photosync.media.ScanSummary
import com.notgooglephotos.photosync.model.SyncSettings
import com.notgooglephotos.photosync.net.ApiResult
import com.notgooglephotos.photosync.net.AssetUpload
import com.notgooglephotos.photosync.net.ServerResolver
import com.notgooglephotos.photosync.net.SyncApiClient
import com.notgooglephotos.photosync.net.UploadResult
import com.notgooglephotos.photosync.queue.MediaItemEntity
import com.notgooglephotos.photosync.queue.MediaKind
import com.notgooglephotos.photosync.queue.SyncDatabase
import com.notgooglephotos.photosync.queue.SyncRunEntity
import com.notgooglephotos.photosync.settings.SettingsStore
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withContext
import java.io.IOException
import java.util.concurrent.atomic.AtomicInteger
import kotlin.coroutines.cancellation.CancellationException

/**
 * The sync algorithm every native implementation follows (A1):
 * check the server is reachable, scan for new items, hash, check with the server, upload the
 * missing ones newest first, record the result.
 *
 * Runs never retry on their own. An unreachable server ends the run and leaves a wake-up for the
 * next natural moment (joining Wi-Fi, plugging in); a failure mid-upload pauses uploads for 30
 * minutes, doubling up to 6 hours.
 */
class SyncEngine(
    private val db: SyncDatabase,
    private val store: SettingsStore,
    private val library: MediaLibrary,
    private val conditions: DeviceConditions,
    private val resolver: ServerResolver,
    private val followUps: FollowUps,
    private val clock: Clock,
    private val afterSync: AfterSync? = null,
) {
    private val mutex = Mutex()
    private val indexer = MediaIndexer(library, db, clock)
    private val hasher = Hasher(library)
    private val mutableState = MutableStateFlow(EngineState())

    val state: StateFlow<EngineState> = mutableState.asStateFlow()

    val isRunning: Boolean get() = mutex.isLocked

    suspend fun run(trigger: RunTrigger, options: RunOptions = RunOptions()): RunReport {
        if (options.waitIfBusy) mutex.lock() else if (!mutex.tryLock()) return RunReport(trigger, outcome = null)
        try {
            mutableState.update { it.copy(trigger = trigger) }
            return Run(trigger, options).execute()
        } finally {
            mutableState.update { EngineState(revision = it.revision + 1) }
            mutex.unlock()
        }
    }

    /**
     * Brings the queue up to date without touching the network, so counts are current (the evening
     * reminder and the Backup screen use this). Skipped while a run is working, since it scans anyway.
     */
    suspend fun indexOnly(): ScanSummary? {
        if (!store.isConfigured || !library.hasReadAccess() || !mutex.tryLock()) return null
        try {
            mutableState.update { it.copy(phase = SyncPhase.SCANNING) }
            val summary = indexer.scan(store.settings, full = false, backlogCutoffMs = store.backlogCutoffMs)
            if (!store.firstBackupComplete && db.media().backlogRemaining() == 0) store.firstBackupComplete = true
            return summary
        } finally {
            mutableState.update { EngineState(revision = it.revision + 1) }
            mutex.unlock()
        }
    }

    private fun bump() = mutableState.update { it.copy(revision = it.revision + 1) }

    private fun phase(phase: SyncPhase) = mutableState.update { it.copy(phase = phase, revision = it.revision + 1) }

    private inner class Run(private val trigger: RunTrigger, private val options: RunOptions) {
        private val requests = AtomicInteger()
        private var uploaded = 0
        private var alreadyOnServer = 0
        private var failed = 0
        private var bytes = 0L
        private var message: String? = null

        suspend fun execute(): RunReport {
            val startedAt = clock.now()
            val runId = db.runs().insert(SyncRunEntity(trigger = trigger.js, startedAt = startedAt))
            bump()
            var outcome = RunOutcome.ERROR
            try {
                outcome = steps()
            } catch (e: CancellationException) {
                outcome = RunOutcome.INTERRUPTED
                message = "Stopped by the system; it continues on the next run"
                if (trigger == RunTrigger.FIRST_BACKUP && !store.firstBackupComplete) followUps.ensureFirstBackup()
                throw e
            } catch (e: Exception) {
                outcome = RunOutcome.ERROR
                message = e.message ?: e.javaClass.simpleName
            } finally {
                withContext(NonCancellable) {
                    db.media().resetInterruptedUploads()
                    db.runs().update(
                        SyncRunEntity(
                            id = runId,
                            trigger = trigger.js,
                            startedAt = startedAt,
                            finishedAt = clock.now(),
                            outcome = outcome.js,
                            uploaded = uploaded,
                            failed = failed,
                            bytes = bytes,
                            requests = requests.get(),
                            message = message,
                        ),
                    )
                    db.runs().prune(KEEP_RUNS)
                }
            }
            return RunReport(trigger, outcome, uploaded, alreadyOnServer, failed, bytes, requests.get(), message)
        }

        private suspend fun steps(): RunOutcome {
            val settings = store.settings
            if (!store.isConfigured) return RunOutcome.NOT_CONFIGURED
            if (store.needsPairing) return RunOutcome.NEEDS_PAIRING
            val token = store.deviceToken ?: return needsPairing("The stored device token can't be read on this phone")
            if (!settings.enabled && !trigger.isUserInitiated) return RunOutcome.DISABLED
            if (!library.hasReadAccess()) return RunOutcome.NO_PERMISSION

            val pausedUntil = store.uploadsPausedUntil?.takeIf { it > clock.now() }
            if (pausedUntil != null && !trigger.skipsUploadPause) {
                followUps.retryAfterBackoff(pausedUntil)
                message = "Uploads are paused after a failure"
                return RunOutcome.BACKING_OFF
            }

            val network = conditions.network()
            val wifiRequired = settings.wifiOnly || trigger == RunTrigger.FIRST_BACKUP
            if (!network.connected) {
                followUps.whenOnline(unmetered = wifiRequired)
                return RunOutcome.WAITING_FOR_NETWORK
            }
            if (wifiRequired && !network.unmetered) {
                followUps.whenOnline(unmetered = true)
                return RunOutcome.WAITING_FOR_WIFI
            }
            if (trigger == RunTrigger.FIRST_BACKUP && settings.requireCharging && !conditions.isCharging()) {
                followUps.ensureFirstBackup()
                message = "The first full backup runs while the phone is charging"
                return RunOutcome.WAITING_FOR_CHARGING
            }

            phase(SyncPhase.CHECKING_SERVER)
            val client = when (val found = resolver.resolve(settings, token, network, requests)) {
                is ServerResolver.Result.Unreachable -> {
                    store.lastUnreachableAt = clock.now()
                    message = found.message
                    if (!network.unmetered) followUps.whenOnline(unmetered = true)
                    if (!conditions.isCharging()) followUps.whenCharging()
                    return RunOutcome.SERVER_UNREACHABLE
                }
                is ServerResolver.Result.Reachable -> {
                    store.lastReachableAt = clock.now()
                    remember(found)
                    found.client
                }
            }

            // Later passes pick up photos taken while this run was uploading.
            // Back up now, and the charging first-backup job, may upload older photos.
            // Every other run only asks the server which of those it already has.
            val uploadBacklog = trigger == RunTrigger.FIRST_BACKUP || trigger == RunTrigger.MANUAL || store.firstBackupComplete
            var fullScan = trigger == RunTrigger.RECONCILE || options.fullScan
            for (pass in 1..MAX_PASSES) {
                phase(SyncPhase.SCANNING)
                val scan = indexer.scan(store.settings, fullScan, store.backlogCutoffMs)
                if (pass > 1 && scan.added + scan.changed == 0) break
                fullScan = false
                if (!uploadBacklog) recognizeBacklog(client, settings)?.let { return it }
                uploadPending(client, settings, uploadBacklog)?.let { return it }
            }

            if (!store.firstBackupComplete && store.backlogCutoffMs != null) {
                if (db.media().backlogRemaining() == 0) store.firstBackupComplete = true else followUps.ensureFirstBackup()
            }
            videosWaitingForPower(settings)
            store.lastSuccessAt = clock.now()
            afterSync?.onSynced(client)
            return if (uploaded + alreadyOnServer + failed == 0) RunOutcome.NOTHING_TO_DO else RunOutcome.COMPLETED
        }

        private fun remember(found: ServerResolver.Result.Reachable) {
            if (found.movedHome == null && (found.serverId == null || store.settings.serverId != null)) return
            store.updateSettings { current ->
                current.copy(
                    homeUrl = found.movedHome ?: current.homeUrl,
                    serverId = current.serverId ?: found.serverId,
                )
            }
        }

        /**
         * Older photos stay out of a normal upload, but the server is asked about them anyway.
         * A match is marked backed up. A miss stays pending for Back up now or the charging first backup.
         */
        private suspend fun recognizeBacklog(client: SyncApiClient, settings: SyncSettings): RunOutcome? {
            val includeVideos = settings.includeVideos
            var beforeCapture = Long.MAX_VALUE
            var beforeId = Long.MAX_VALUE
            while (true) {
                val page = db.media().pendingBacklog(includeVideos, beforeCapture, beforeId, SyncApiClient.CHECK_BATCH)
                if (page.isEmpty()) return null
                beforeCapture = page.last().captureTime
                beforeId = page.last().id
                markAlreadyOnServer(client, page)?.let { return it }
            }
        }

        /** Hash, check, and upload one page at a time. Returns an outcome when the run has to stop early. */
        private suspend fun uploadPending(client: SyncApiClient, settings: SyncSettings, includeBacklog: Boolean): RunOutcome? {
            val includeVideos = settings.includeVideos && videosAllowedNow(settings)
            val queued = db.media().eligiblePending(includeVideos, includeBacklog)
            if (queued == 0) return null
            var position = 0
            var beforeCapture = Long.MAX_VALUE
            var beforeId = Long.MAX_VALUE
            while (true) {
                val page = db.media().pendingCandidates(includeVideos, includeBacklog, beforeCapture, beforeId, SyncApiClient.CHECK_BATCH)
                if (page.isEmpty()) return null
                beforeCapture = page.last().captureTime
                beforeId = page.last().id

                val checked = hashAndCheck(client, page)
                checked.stop?.let { return it }
                val ready = checked.ready ?: continue
                position += ready.already
                phase(SyncPhase.UPLOADING)
                for ((checksum, rows) in ready.byChecksum) {
                    if (checksum !in ready.missing) continue
                    val item = rows.first()
                    if (item.kind == MediaKind.VIDEO && !videosAllowedNow(settings)) continue
                    position += 1
                    uploadOne(client, item, rows, position, queued)?.let { return it }
                    bump()
                }
            }
        }

        /** Hashes [page], marks rows the server already has, and leaves the rest pending. */
        private suspend fun markAlreadyOnServer(client: SyncApiClient, page: List<MediaItemEntity>): RunOutcome? {
            val checked = hashAndCheck(client, page)
            return checked.stop
        }

        private suspend fun hashAndCheck(client: SyncApiClient, page: List<MediaItemEntity>): CheckedPage {
            phase(SyncPhase.HASHING)
            val hashed = page.mapNotNull { ensureChecksum(it) }
            if (hashed.isEmpty()) return CheckedPage(null, null)
            phase(SyncPhase.CHECKING)
            val byChecksum = hashed.groupBy { it.checksum!! }
            val check = when (val result = client.checkAssets(byChecksum.keys.toList())) {
                is ApiResult.Ok -> result.value
                ApiResult.Unauthorized -> return CheckedPage(null, needsPairing("The server no longer accepts this phone. Pair it again."))
                is ApiResult.HttpError -> return CheckedPage(null, pauseUploads(result.message))
                is ApiResult.NetworkError -> return CheckedPage(null, pauseUploads(result.message))
            }
            var marked = 0
            for ((checksum, rows) in byChecksum) {
                if (checksum in check.missing) continue
                db.media().markBackedUp(rows.map { it.id }, check.existing[checksum], clock.now())
                alreadyOnServer += rows.size
                marked += rows.size
            }
            if (marked > 0) bump()
            return CheckedPage(ReadyPage(byChecksum, check.missing, marked), null)
        }

        private fun videosAllowedNow(settings: SyncSettings) =
            conditions.isCharging() || !settings.requireCharging || !settings.videosOnlyWhileCharging

        /** Videos that are ready except for the charging condition get a one-off wake-up for when power is connected. */
        private suspend fun videosWaitingForPower(settings: SyncSettings) {
            if (!settings.includeVideos || !settings.requireCharging || !settings.videosOnlyWhileCharging || conditions.isCharging()) return
            val waiting = db.media().pendingBreakdown().any { it.kind == MediaKind.VIDEO && !it.backlog && it.count > 0 }
            if (waiting) followUps.whenCharging()
        }

        /** Returns the item with a valid checksum, or null when it can't go in this run. */
        private suspend fun ensureChecksum(item: MediaItemEntity): MediaItemEntity? {
            currentCoroutineContext().ensureActive()
            val upgradeLocation = item.locationRedacted && library.hasLocationAccess()
            if (item.checksum != null && item.hashedSize == item.size && item.hashedModified == item.dateModified && !upgradeLocation) {
                return item
            }
            val hash = try {
                hasher.sha1(item.uri)
            } catch (e: MediaGoneException) {
                db.media().delete(item.id)
                return null
            } catch (e: IOException) {
                recordLocalFailure(item, "Couldn't read the file: ${e.message}")
                return null
            }
            db.media().setChecksum(item.id, hash.sha1, item.size, item.dateModified, hash.locationRedacted)
            if (item.versionOf != null && hash.sha1 == item.checksum) {
                // Only the timestamp moved; the backed-up original is still current.
                db.media().restoreUnchanged(item.id)
                alreadyOnServer++
                return null
            }
            return item.copy(checksum = hash.sha1, hashedSize = item.size, hashedModified = item.dateModified, locationRedacted = hash.locationRedacted)
        }

        private suspend fun uploadOne(
            client: SyncApiClient,
            item: MediaItemEntity,
            sameContent: List<MediaItemEntity>,
            index: Int,
            of: Int,
        ): RunOutcome? {
            db.media().markUploading(item.id)
            mutableState.update { it.copy(current = CurrentUpload(item.displayName, 0, item.size, index, maxOf(index, of))) }
            val result = client.uploadAsset(
                AssetUpload(
                    checksum = item.checksum!!,
                    fileName = item.displayName,
                    mimeType = item.mimeType ?: DEFAULT_MIME_TYPE,
                    size = item.size,
                    capturedAtMs = item.captureTime,
                    modifiedAtSec = item.dateModified,
                    zone = clock.zone(),
                    deviceAssetId = item.deviceAssetId,
                    folder = item.relativePath,
                    favorite = item.favorite,
                    versionOf = item.versionOf,
                    open = { library.openOriginal(item.uri) },
                    onProgress = { sent, total ->
                        mutableState.update { state ->
                            state.copy(current = state.current?.copy(bytesSent = sent, bytesTotal = if (total > 0) total else item.size))
                        }
                    },
                ),
            )
            mutableState.update { it.copy(current = null) }
            val attempts = item.attempts + 1
            when (result) {
                is UploadResult.Stored -> {
                    db.media().markBackedUp(sameContent.map { it.id }, result.assetId, clock.now())
                    uploaded++
                    alreadyOnServer += sameContent.size - 1
                    bytes += item.size
                    if (store.consecutiveUploadFailures != 0 || store.uploadsPausedUntil != null) {
                        store.consecutiveUploadFailures = 0
                        store.uploadsPausedUntil = null
                        followUps.cancelBackoffRetry()
                    }
                }
                is UploadResult.Rejected -> {
                    sameContent.forEach { db.media().markFailed(it.id, attempts, result.message) }
                    failed += sameContent.size
                }
                UploadResult.Unauthorized -> {
                    db.media().deferRetry(item.id, item.attempts, null)
                    return needsPairing("The server no longer accepts this phone. Pair it again.")
                }
                is UploadResult.ServerTrouble -> {
                    if (attempts >= MAX_ATTEMPTS) {
                        db.media().markFailed(item.id, attempts, result.message)
                        failed++
                    } else {
                        db.media().deferRetry(item.id, attempts, result.message)
                    }
                    return pauseUploads(result.message)
                }
                is UploadResult.LocalChanged -> recordLocalFailure(item, result.message)
                UploadResult.Gone -> db.media().delete(item.id)
            }
            return null
        }

        private suspend fun recordLocalFailure(item: MediaItemEntity, error: String) {
            val attempts = item.attempts + 1
            if (attempts >= MAX_ATTEMPTS) {
                db.media().markFailed(item.id, attempts, error)
                failed++
            } else {
                db.media().invalidateChecksum(item.id, attempts, error)
            }
        }

        private fun pauseUploads(reason: String): RunOutcome {
            val failures = store.consecutiveUploadFailures + 1
            val until = clock.now() + Backoff.delayMs(failures)
            store.consecutiveUploadFailures = failures
            store.uploadsPausedUntil = until
            followUps.retryAfterBackoff(until)
            message = reason
            return RunOutcome.UPLOAD_FAILED
        }

        private fun needsPairing(reason: String): RunOutcome {
            store.needsPairing = true
            message = reason
            return RunOutcome.NEEDS_PAIRING
        }
    }

    private class ReadyPage(
        val byChecksum: Map<String, List<MediaItemEntity>>,
        val missing: Set<String>,
        val already: Int,
    )

    private class CheckedPage(val ready: ReadyPage?, val stop: RunOutcome?)

    companion object {
        const val MAX_ATTEMPTS = 10
        const val MAX_PASSES = 3
        const val KEEP_RUNS = 200
        private const val DEFAULT_MIME_TYPE = "application/octet-stream"
    }
}
