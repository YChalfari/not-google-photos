package com.notgooglephotos.photosync.engine

import java.time.LocalDate
import java.time.ZoneId

interface Clock {
    fun now(): Long

    fun zone(): ZoneId

    fun today(): LocalDate = java.time.Instant.ofEpochMilli(now()).atZone(zone()).toLocalDate()

    /** Epoch ms of local midnight that starts [date]. */
    fun startOf(date: LocalDate): Long = date.atStartOfDay(zone()).toInstant().toEpochMilli()
}

object WallClock : Clock {
    override fun now(): Long = System.currentTimeMillis()

    override fun zone(): ZoneId = ZoneId.systemDefault()
}
