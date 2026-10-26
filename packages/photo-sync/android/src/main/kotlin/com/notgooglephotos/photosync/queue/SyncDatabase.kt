package com.notgooglephotos.photosync.queue

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.Update
import androidx.room.Upsert

@Dao
interface RunDao {
    @Insert
    suspend fun insert(run: SyncRunEntity): Long

    @Update
    suspend fun update(run: SyncRunEntity)

    @Query("SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1")
    suspend fun latest(): SyncRunEntity?

    @Query("SELECT * FROM sync_runs ORDER BY id")
    suspend fun all(): List<SyncRunEntity>

    @Query("DELETE FROM sync_runs WHERE id <= (SELECT MAX(id) FROM sync_runs) - :keep")
    suspend fun prune(keep: Int)
}

@Dao
interface ScanStateDao {
    @Query("SELECT * FROM scan_state WHERE volume = :volume")
    suspend fun get(volume: String): ScanStateEntity?

    @Upsert
    suspend fun put(state: ScanStateEntity)

    @Query("DELETE FROM scan_state")
    suspend fun clear()
}

@Dao
interface MemoryDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun putAll(memories: List<MemoryEntity>)

    @Query("SELECT * FROM memories ORDER BY notify_at")
    suspend fun all(): List<MemoryEntity>

    @Query("SELECT * FROM memories WHERE id IN (:ids)")
    suspend fun byIds(ids: List<String>): List<MemoryEntity>

    @Query("DELETE FROM memories WHERE notified = 0")
    suspend fun deleteUnnotified()

    @Query("SELECT * FROM memories WHERE notified = 0 AND notify_at >= :notBefore ORDER BY notify_at LIMIT 1")
    suspend fun nextToNotify(notBefore: Long): MemoryEntity?

    @Query("SELECT * FROM memories WHERE notified = 0 AND notify_at >= :notBefore AND notify_at <= :until ORDER BY notify_at")
    suspend fun due(notBefore: Long, until: Long): List<MemoryEntity>

    @Query("UPDATE memories SET notified = 1 WHERE id = :id")
    suspend fun markNotified(id: String)

    @Query("DELETE FROM memories WHERE notified = 0 AND id NOT IN (:keepIds)")
    suspend fun deleteUnnotifiedExcept(keepIds: List<String>)

    @Query("DELETE FROM memories WHERE notify_at < :before")
    suspend fun deleteOlderThan(before: Long)

    @Query("UPDATE memories SET notify_at = :notifyAt WHERE id = :id")
    suspend fun setNotifyAt(id: String, notifyAt: Long)
}

@Database(
    entities = [MediaItemEntity::class, SyncRunEntity::class, ScanStateEntity::class, MemoryEntity::class],
    version = 1,
    exportSchema = true,
)
abstract class SyncDatabase : RoomDatabase() {
    abstract fun media(): MediaDao
    abstract fun runs(): RunDao
    abstract fun scanState(): ScanStateDao
    abstract fun memories(): MemoryDao

    companion object {
        const val NAME = "ngp-photosync.db"

        fun open(context: Context): SyncDatabase =
            Room.databaseBuilder(context.applicationContext, SyncDatabase::class.java, NAME).build()

        fun inMemory(context: Context): SyncDatabase =
            Room.inMemoryDatabaseBuilder(context.applicationContext, SyncDatabase::class.java).allowMainThreadQueries().build()
    }
}
