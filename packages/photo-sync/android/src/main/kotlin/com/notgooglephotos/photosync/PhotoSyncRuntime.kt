package com.notgooglephotos.photosync

import android.content.Context
import android.os.Build
import com.notgooglephotos.photosync.engine.AndroidDeviceConditions
import com.notgooglephotos.photosync.engine.BackupCoordinator
import com.notgooglephotos.photosync.engine.Clock
import com.notgooglephotos.photosync.engine.DeviceConditions
import com.notgooglephotos.photosync.engine.SyncEngine
import com.notgooglephotos.photosync.engine.WallClock
import com.notgooglephotos.photosync.media.MediaLibrary
import com.notgooglephotos.photosync.media.MediaStoreLibrary
import com.notgooglephotos.photosync.net.NsdServerDiscovery
import com.notgooglephotos.photosync.net.ServerDiscovery
import com.notgooglephotos.photosync.net.ServerResolver
import com.notgooglephotos.photosync.net.SyncApiFactory
import com.notgooglephotos.photosync.notify.AndroidMemoryAlarm
import com.notgooglephotos.photosync.notify.EndOfDayReminder
import com.notgooglephotos.photosync.notify.MemoryNotifications
import com.notgooglephotos.photosync.notify.Notifier
import com.notgooglephotos.photosync.queue.SyncDatabase
import com.notgooglephotos.photosync.settings.KeystoreTokenCipher
import com.notgooglephotos.photosync.settings.SettingsStore
import com.notgooglephotos.photosync.status.StatusProvider
import com.notgooglephotos.photosync.work.SyncScheduler
import java.io.File

/** The process-wide graph: one database, one engine, one set of schedules. */
class PhotoSyncRuntime(
    val db: SyncDatabase,
    val store: SettingsStore,
    val library: MediaLibrary,
    val conditions: DeviceConditions,
    val clock: Clock,
    val engine: SyncEngine,
    val scheduler: SyncScheduler,
    val notifier: Notifier,
    val memories: MemoryNotifications,
    val reminder: EndOfDayReminder,
    val discovery: ServerDiscovery,
    val coordinator: BackupCoordinator,
    val status: StatusProvider,
) {
    companion object {
        @Volatile private var instance: PhotoSyncRuntime? = null

        /** Unit tests install a runtime whose workers share their fakes. */
        @Volatile var testing: PhotoSyncRuntime? = null

        fun get(context: Context): PhotoSyncRuntime {
            testing?.let { return it }
            instance?.let { return it }
            return synchronized(this) {
                testing ?: instance ?: create(context.applicationContext).also { instance = it }
            }
        }

        fun setForTest(runtime: PhotoSyncRuntime?) {
            testing = runtime
        }

        private fun create(context: Context): PhotoSyncRuntime {
            val clock = WallClock
            val store = SettingsStore(context, KeystoreTokenCipher())
            val db = SyncDatabase.open(context)
            val library = MediaStoreLibrary(context)
            val conditions = AndroidDeviceConditions(context)
            val notifier = Notifier(context)
            val scheduler = SyncScheduler(context, store, clock)
            val discovery = NsdServerDiscovery(context)
            val resolver = ServerResolver(SyncApiFactory(userAgent(context)), discovery)
            val memories = MemoryNotifications(
                db,
                store,
                notifier,
                AndroidMemoryAlarm(context),
                File(context.filesDir, "memory-covers"),
                clock,
            )
            val engine = SyncEngine(db, store, library, conditions, resolver, scheduler, clock, memories)
            return PhotoSyncRuntime(
                db = db,
                store = store,
                library = library,
                conditions = conditions,
                clock = clock,
                engine = engine,
                scheduler = scheduler,
                notifier = notifier,
                memories = memories,
                reminder = EndOfDayReminder(engine, db, store, conditions, notifier, clock),
                discovery = discovery,
                coordinator = BackupCoordinator(db, store, scheduler, resolver, conditions, clock),
                status = StatusProvider(db, store, library, conditions, engine, clock),
            )
        }

        private fun userAgent(context: Context): String {
            val version = runCatching {
                context.packageManager.getPackageInfo(context.packageName, 0).versionName
            }.getOrNull() ?: "0"
            return "NotGooglePhotos/$version (Android ${Build.VERSION.RELEASE})"
        }
    }
}
