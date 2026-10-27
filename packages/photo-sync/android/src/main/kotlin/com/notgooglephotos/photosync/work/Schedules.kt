package com.notgooglephotos.photosync.work

import java.time.Instant
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZonedDateTime

object Schedules {
    /** The first of [times] strictly after [nowMs], in [zone]. Daylight-saving gaps resolve forward. */
    fun nextOccurrence(nowMs: Long, times: List<LocalTime>, zone: ZoneId): ZonedDateTime {
        require(times.isNotEmpty()) { "No times" }
        val now = Instant.ofEpochMilli(nowMs).atZone(zone)
        return (0L..1L).asSequence()
            .flatMap { days -> times.asSequence().map { ZonedDateTime.of(now.toLocalDate().plusDays(days), it, zone) } }
            .filter { it.isAfter(now) }
            .min()
    }

    fun delayUntilNext(nowMs: Long, times: List<LocalTime>, zone: ZoneId): Long =
        nextOccurrence(nowMs, times, zone).toInstant().toEpochMilli() - nowMs
}
