package com.notgooglephotos.photosync.model

import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalTime
import java.time.format.DateTimeFormatter

/** Automatic triggers, mirroring the `SyncTrigger` union in definitions.ts. */
sealed class SyncTrigger {
    abstract fun toJson(): JSONObject

    /** WorkManager content-URI trigger: [debounceSec] is the update delay, [maxDelayMin] the max delay. */
    data class OnNewMedia(val debounceSec: Long, val maxDelayMin: Long) : SyncTrigger() {
        init {
            require(debounceSec in 1..3_600) { "debounceSec must be between 1 and 3600" }
            require(maxDelayMin in 1..1_440) { "maxDelayMin must be between 1 and 1440" }
            require(maxDelayMin * 60 >= debounceSec) { "maxDelayMin must be at least debounceSec" }
        }

        override fun toJson(): JSONObject =
            JSONObject().put("kind", KIND_ON_NEW_MEDIA).put("debounceSec", debounceSec).put("maxDelayMin", maxDelayMin)
    }

    /** Periodic work. Android won't run periodic work more often than every 15 minutes. */
    data class Interval(val everyMin: Long) : SyncTrigger() {
        init {
            require(everyMin in MIN_INTERVAL_MIN..10_080) { "everyMin must be between $MIN_INTERVAL_MIN and 10080" }
        }

        override fun toJson(): JSONObject = JSONObject().put("kind", KIND_INTERVAL).put("everyMin", everyMin)
    }

    data class TimesOfDay(val times: List<LocalTime>) : SyncTrigger() {
        init {
            require(times.isNotEmpty()) { "timesOfDay needs at least one time" }
        }

        override fun toJson(): JSONObject =
            JSONObject().put("kind", KIND_TIMES_OF_DAY).put("times", JSONArray(times.map(TimeOfDay::format)))
    }

    companion object {
        const val KIND_ON_NEW_MEDIA = "onNewMedia"
        const val KIND_INTERVAL = "interval"
        const val KIND_TIMES_OF_DAY = "timesOfDay"
        const val MIN_INTERVAL_MIN = 15L

        val DEFAULTS: List<SyncTrigger> = listOf(OnNewMedia(debounceSec = 60, maxDelayMin = 10), Interval(everyMin = 60))

        fun fromJson(json: JSONObject): SyncTrigger = when (val kind = json.getString("kind")) {
            KIND_ON_NEW_MEDIA -> OnNewMedia(json.getLong("debounceSec"), json.getLong("maxDelayMin"))
            // Android's floor is 15 minutes; asking for less gets the floor instead of an error.
            KIND_INTERVAL -> Interval(json.getLong("everyMin").coerceAtLeast(MIN_INTERVAL_MIN))
            KIND_TIMES_OF_DAY -> TimesOfDay(json.getJSONArray("times").strings().map(TimeOfDay::parse).distinct().sorted())
            else -> throw IllegalArgumentException("Unknown trigger kind '$kind'")
        }

        /** Parses a trigger list, keeping only the last trigger of each kind. */
        fun listFromJson(array: JSONArray): List<SyncTrigger> =
            (0 until array.length()).map { fromJson(array.getJSONObject(it)) }.associateBy { it::class }.values.toList()

        fun listToJson(triggers: List<SyncTrigger>): JSONArray = JSONArray(triggers.map { it.toJson() })
    }
}

object TimeOfDay {
    private val FORMAT: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm")
    private val PATTERN = Regex("^([01]?\\d|2[0-3]):([0-5]\\d)$")

    fun parse(value: String): LocalTime {
        val match = PATTERN.matchEntire(value.trim()) ?: throw IllegalArgumentException("Times use 24-hour HH:mm, got '$value'")
        return LocalTime.of(match.groupValues[1].toInt(), match.groupValues[2].toInt())
    }

    fun format(time: LocalTime): String = time.format(FORMAT)
}
