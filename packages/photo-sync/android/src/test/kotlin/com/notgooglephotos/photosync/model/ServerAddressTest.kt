package com.notgooglephotos.photosync.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class ServerAddressTest {
    @Test
    fun homeAcceptsPrivateHostsAndRejectsPublicHttp() {
        assertEquals("http://192.168.1.20:8787", ServerAddress.validateHome("http://192.168.1.20:8787/"))
        assertEquals("http://10.1.2.3", ServerAddress.validateHome("http://10.1.2.3"))
        assertEquals("http://127.0.0.1:9", ServerAddress.validateHome("http://127.0.0.1:9"))
        assertEquals("http://100.64.1.2", ServerAddress.validateHome("http://100.64.1.2"))
        assertEquals("http://nas.local", ServerAddress.validateHome("http://nas.local"))
        assertEquals("http://photos", ServerAddress.validateHome("http://photos"))
        assertEquals("https://photos.example.com", ServerAddress.validateHome("https://photos.example.com"))
        assertThrows(IllegalArgumentException::class.java) { ServerAddress.validateHome("http://photos.example.com") }
        assertThrows(IllegalArgumentException::class.java) { ServerAddress.validateHome("http://8.8.8.8") }
    }

    @Test
    fun remoteMustBeHttps() {
        assertEquals("https://photos.example.com/library", ServerAddress.validateRemote("https://photos.example.com/library"))
        assertThrows(IllegalArgumentException::class.java) { ServerAddress.validateRemote("http://192.168.1.20:8787") }
    }

    @Test
    fun rejectsQueryAndResolvesBase() {
        assertThrows(IllegalArgumentException::class.java) { ServerAddress.validateHome("http://192.168.1.20:8787?x=1") }
        val base = ServerAddress.baseUrl("http://192.168.1.20:8787/photos")
        assertEquals("http://192.168.1.20:8787/photos/api/health", base.resolve("api/health").toString())
    }

    @Test
    fun privateAddressRanges() {
        assertTrue(ServerAddress.isPrivateHost("169.254.1.1"))
        assertTrue(ServerAddress.isPrivateHost("172.16.0.1"))
        assertTrue(ServerAddress.isPrivateHost("::1"))
        assertTrue(ServerAddress.isPrivateHost("fd00::1"))
        assertTrue(ServerAddress.isPrivateHost("fe80::1"))
        assertFalse(ServerAddress.isPrivateHost("1.1.1.1"))
        assertFalse(ServerAddress.isPrivateHost("2001:4860:4860::8888"))
    }
}
