package com.notgooglephotos.photosync.engine

import com.notgooglephotos.photosync.net.SyncApiClient

/** What started a run. The [js] names match `RunTrigger` in definitions.ts. */
enum class RunTrigger(val js: String) {
    ON_NEW_MEDIA("onNewMedia"),
    INTERVAL("interval"),
    TIMES_OF_DAY("timesOfDay"),
    MANUAL("manual"),
    RECONCILE("reconcile"),
    FIRST_BACKUP("firstBackup"),
    WIFI("wifi"),
    NETWORK("network"),
    CHARGING("charging"),
    BACKOFF("backoff"),
    REMINDER("reminder"),
    SETTINGS("settings"),
    ;

    /** Runs the person asked for, which happen even when automatic backup is off. */
    val isUserInitiated: Boolean get() = this == MANUAL || this == SETTINGS

    /** Runs that go ahead during an upload pause: asked for directly, or the one scheduled for the pause's end. */
    val skipsUploadPause: Boolean get() = isUserInitiated || this == REMINDER || this == BACKOFF

    companion object {
        fun fromJs(value: String?): RunTrigger? = entries.firstOrNull { it.js == value }
    }
}

/** How a run ended. The [js] names match `RunOutcome` in definitions.ts. */
enum class RunOutcome(val js: String) {
    COMPLETED("completed"),
    NOTHING_TO_DO("nothingToDo"),
    NOT_CONFIGURED("notConfigured"),
    DISABLED("disabled"),
    NO_PERMISSION("noPermission"),
    WAITING_FOR_NETWORK("waitingForNetwork"),
    WAITING_FOR_WIFI("waitingForWifi"),
    WAITING_FOR_CHARGING("waitingForCharging"),
    SERVER_UNREACHABLE("serverUnreachable"),
    NEEDS_PAIRING("needsPairing"),
    UPLOAD_FAILED("uploadFailed"),
    BACKING_OFF("backingOff"),
    INTERRUPTED("interrupted"),
    ERROR("error"),
    ;

    companion object {
        fun fromJs(value: String?): RunOutcome? = entries.firstOrNull { it.js == value }
    }
}

enum class SyncPhase(val js: String) {
    IDLE("idle"),
    CHECKING_SERVER("checkingServer"),
    SCANNING("scanning"),
    HASHING("hashing"),
    CHECKING("checking"),
    UPLOADING("uploading"),
}

data class CurrentUpload(val fileName: String, val bytesSent: Long, val bytesTotal: Long, val index: Int, val of: Int)

data class EngineState(
    val phase: SyncPhase = SyncPhase.IDLE,
    val trigger: RunTrigger? = null,
    val current: CurrentUpload? = null,
    /** Bumped whenever queue rows or run records change, so observers know to recount. */
    val revision: Long = 0,
)

data class RunOptions(
    /** Wait for a run in progress instead of skipping (the long first-backup run does this). */
    val waitIfBusy: Boolean = false,
    val fullScan: Boolean = false,
)

data class RunReport(
    val trigger: RunTrigger,
    /** Null when the run was skipped because another run was already working. */
    val outcome: RunOutcome?,
    val uploaded: Int = 0,
    val alreadyOnServer: Int = 0,
    val failed: Int = 0,
    val bytes: Long = 0,
    val requests: Int = 0,
    val message: String? = null,
)

/** Mid-upload failures pause uploads for 30 minutes, doubling up to 6 hours. */
object Backoff {
    const val FIRST_MS = 30 * 60_000L
    const val MAX_MS = 6 * 60 * 60_000L

    fun delayMs(consecutiveFailures: Int): Long {
        val doublings = (consecutiveFailures.coerceAtLeast(1) - 1).coerceAtMost(10)
        return minOf(FIRST_MS shl doublings, MAX_MS)
    }
}

/**
 * The "next natural moment" hooks. A run that can't finish asks to be woken by one of these
 * instead of retrying. Implementations keep at most one pending wake-up per kind, and a wake-up
 * never re-arms itself while it is the run in progress, which is what rules out retry loops.
 */
interface FollowUps {
    /** Run once the phone is online ([unmetered]: on Wi-Fi). */
    fun whenOnline(unmetered: Boolean)

    fun whenCharging()

    /** Keep the first full backup queued (Wi-Fi and charging, foreground). */
    fun ensureFirstBackup()

    fun retryAfterBackoff(atMs: Long)

    fun cancelBackoffRetry()

    object None : FollowUps {
        override fun whenOnline(unmetered: Boolean) = Unit
        override fun whenCharging() = Unit
        override fun ensureFirstBackup() = Unit
        override fun retryAfterBackoff(atMs: Long) = Unit
        override fun cancelBackoffRetry() = Unit
    }
}

/** Work that piggybacks on a successful run, such as refreshing upcoming memories. */
fun interface AfterSync {
    suspend fun onSynced(client: SyncApiClient)
}
