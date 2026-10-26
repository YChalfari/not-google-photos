package com.notgooglephotos.photosync.engine

import com.notgooglephotos.photosync.work.Schedules
import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.LocalTime
import java.time.ZoneId

class BackoffAndScheduleTest {
    @Test
    fun backoffDoublesFromThirtyMinutesToSixHours() {
        assertEquals(30 * 60_000L, Backoff.delayMs(1))
        assertEquals(60 * 60_000L, Backoff.delayMs(2))
        assertEquals(4 * 60 * 60_000L, Backoff.delayMs(4))
        assertEquals(Backoff.MAX_MS, Backoff.delayMs(5))
        assertEquals(Backoff.MAX_MS, Backoff.delayMs(12))
    }

    @Test
    fun nextTimeIsTheSoonestOneStrictlyAfterNow() {
        val zone = ZoneId.of("UTC")
        val now = java.time.LocalDateTime.of(2026, 10, 26, 20, 15).atZone(zone).toInstant().toEpochMilli()
        val next = Schedules.nextOccurrence(now, listOf(LocalTime.of(9, 0), LocalTime.of(21, 0)), zone)
        assertEquals(21, next.hour)
        assertEquals(0, next.minute)
        assertEquals(26, next.dayOfMonth)
        val after = Schedules.nextOccurrence(next.toInstant().toEpochMilli(), listOf(LocalTime.of(21, 0)), zone)
        assertEquals(27, after.dayOfMonth)
    }

    @Test
    fun springForwardSkipsAMissingHour() {
        val zone = ZoneId.of("America/New_York")
        // 2026-03-08 is the US spring-forward day; 02:30 does not exist.
        val now = java.time.LocalDateTime.of(2026, 3, 8, 1, 0).atZone(zone).toInstant().toEpochMilli()
        val next = Schedules.nextOccurrence(now, listOf(LocalTime.of(2, 30)), zone)
        assertEquals(3, next.hour)
        assertEquals(30, next.minute)
    }
}
