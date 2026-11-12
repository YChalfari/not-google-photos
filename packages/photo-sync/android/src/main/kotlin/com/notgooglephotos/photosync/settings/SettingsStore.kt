package com.notgooglephotos.photosync.settings

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit
import com.notgooglephotos.photosync.model.SyncSettings
import com.notgooglephotos.photosync.model.SyncTrigger
import com.notgooglephotos.photosync.model.TimeOfDay
import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalTime

/** Settings, schedule, and the engine's small bits of durable state. */
class SettingsStore(context: Context, private val cipher: TokenCipher) {
    private val prefs: SharedPreferences = context.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    var settings: SyncSettings
        get() = prefs.getString(KEY_SETTINGS, null)?.let { SyncSettings.fromJson(JSONObject(it)) } ?: SyncSettings()
        set(value) = prefs.edit { putString(KEY_SETTINGS, value.toJson().toString()) }

    /** Raw stored settings, so a missing key can be told from the default. Null before the first save. */
    fun peekSettingsJson(): JSONObject? =
        prefs.getString(KEY_SETTINGS, null)?.let { JSONObject(it) }

    /** Read-modify-write, so the engine and the plugin can't overwrite each other's changes. */
    @Synchronized
    fun updateSettings(transform: (SyncSettings) -> SyncSettings): SyncSettings {
        val next = transform(settings)
        settings = next
        return next
    }

    var triggers: List<SyncTrigger>
        get() = prefs.getString(KEY_TRIGGERS, null)?.let { SyncTrigger.listFromJson(JSONArray(it)) } ?: SyncTrigger.DEFAULTS
        set(value) = prefs.edit { putString(KEY_TRIGGERS, SyncTrigger.listToJson(value).toString()) }

    var deviceToken: String?
        get() = prefs.getString(KEY_TOKEN, null)?.let(cipher::decrypt)
        set(value) = prefs.edit {
            if (value.isNullOrBlank()) remove(KEY_TOKEN) else putString(KEY_TOKEN, cipher.encrypt(value))
        }

    val isConfigured: Boolean get() = settings.hasServer && prefs.contains(KEY_TOKEN)

    /** Memory notification time; null when memory notifications are off. */
    var memoryNotificationTime: LocalTime?
        get() = prefs.getString(KEY_MEMORY_TIME, null)?.let(TimeOfDay::parse)
        set(value) = prefs.edit {
            if (value == null) remove(KEY_MEMORY_TIME) else putString(KEY_MEMORY_TIME, TimeOfDay.format(value))
        }

    /**
     * Older builds waited for a charger unless the user opted out. Waiting is now only when
     * "only back up while charging" is checked, so an existing install stops waiting once.
     * Returns true when a saved choice was changed and the schedule should be applied again.
     */
    @Synchronized
    fun stopWaitingForChargerUnlessChosen(): Boolean {
        if (prefs.getBoolean(KEY_CHARGING_MIGRATED, false)) return false
        val hadSettings = peekSettingsJson() != null
        val waiting = hadSettings && settings.requireCharging
        if (waiting) updateSettings { it.copy(requireCharging = false) }
        prefs.edit { putBoolean(KEY_CHARGING_MIGRATED, true) }
        return waiting
    }

    /** Tests set this so they can choose requireCharging without the one-time migration clearing it. */
    fun keepSavedChargingChoice() {
        prefs.edit { putBoolean(KEY_CHARGING_MIGRATED, true) }
    }

    /** Items added to MediaStore before this time belong to the first full backup. */
    var backlogCutoffMs: Long? by longOrNull("backlogCutoffMs")
    var firstBackupComplete: Boolean by boolean("firstBackupComplete")
    var needsPairing: Boolean by boolean("needsPairing")
    var configuredAt: Long? by longOrNull("configuredAt")
    var lastReachableAt: Long? by longOrNull("lastReachableAt")
    var lastUnreachableAt: Long? by longOrNull("lastUnreachableAt")
    var lastSuccessAt: Long? by longOrNull("lastSuccessAt")
    var uploadsPausedUntil: Long? by longOrNull("uploadsPausedUntil")
    var consecutiveUploadFailures: Int by int("consecutiveUploadFailures")
    var lastReminderDay: String? by stringOrNull("lastReminderDay")
    var lastNudgeDay: String? by stringOrNull("lastNudgeDay")
    var memoriesRefreshedAt: Long? by longOrNull("memoriesRefreshedAt")

    /** Last WorkManager spec per unique work name, to tell "unchanged, keep it" from "changed, replace it". */
    fun workSpec(name: String): String? = prefs.getString("$KEY_WORK_SPEC$name", null)

    fun setWorkSpec(name: String, spec: String?) = prefs.edit {
        if (spec == null) remove("$KEY_WORK_SPEC$name") else putString("$KEY_WORK_SPEC$name", spec)
    }

    private fun longOrNull(key: String) = object : Pref<Long?> {
        override fun get(): Long? = if (prefs.contains(key)) prefs.getLong(key, 0) else null
        override fun set(value: Long?) = prefs.edit { if (value == null) remove(key) else putLong(key, value) }
    }

    private fun stringOrNull(key: String) = object : Pref<String?> {
        override fun get(): String? = prefs.getString(key, null)
        override fun set(value: String?) = prefs.edit { if (value == null) remove(key) else putString(key, value) }
    }

    private fun boolean(key: String) = object : Pref<Boolean> {
        override fun get(): Boolean = prefs.getBoolean(key, false)
        override fun set(value: Boolean) = prefs.edit { putBoolean(key, value) }
    }

    private fun int(key: String) = object : Pref<Int> {
        override fun get(): Int = prefs.getInt(key, 0)
        override fun set(value: Int) = prefs.edit { putInt(key, value) }
    }

    private interface Pref<T> {
        fun get(): T
        fun set(value: T)
        operator fun getValue(owner: Any?, property: kotlin.reflect.KProperty<*>): T = get()
        operator fun setValue(owner: Any?, property: kotlin.reflect.KProperty<*>, value: T) = set(value)
    }

    companion object {
        const val FILE = "ngp_photosync"
        internal const val KEY_SETTINGS = "settings"
        private const val KEY_CHARGING_MIGRATED = "chargingOptInMigrated"
        private const val KEY_TRIGGERS = "triggers"
        private const val KEY_TOKEN = "deviceToken"
        private const val KEY_MEMORY_TIME = "memoryNotificationTime"
        private const val KEY_WORK_SPEC = "workSpec:"
    }
}
