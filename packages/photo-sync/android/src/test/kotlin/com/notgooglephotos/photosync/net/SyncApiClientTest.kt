package com.notgooglephotos.photosync.net

import com.notgooglephotos.photosync.FakeSyncServer
import com.notgooglephotos.photosync.permitCleartext
import com.notgooglephotos.photosync.media.OpenedMedia
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.ByteArrayInputStream
import java.time.LocalDate
import java.time.ZoneOffset

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SyncApiClientTest {
    private val server = FakeSyncServer()
    private val factory = SyncApiFactory("NGP-test")

    @Before fun setUp() {
        permitCleartext()
        server.start()
    }

    @After fun tearDown() = server.shutdown()

    @Test
    fun healthCheckUploadMemoriesAndPair() = runBlocking {
        val client = factory.create(server.baseUrl(), "device-token")
        val health = client.health()
        assertTrue(health is HealthResult.Ok)
        assertEquals("srv-1", (health as HealthResult.Ok).serverId)

        val bytes = "hello-photo".toByteArray()
        val checksum = java.security.MessageDigest.getInstance("SHA-1").digest(bytes).joinToString("") { "%02x".format(it) }
        val missing = client.checkAssets(listOf(checksum))
        assertTrue(missing is ApiResult.Ok)
        assertEquals(setOf(checksum), (missing as ApiResult.Ok).value.missing)

        var progress = 0L
        val uploaded = client.uploadAsset(
            AssetUpload(
                checksum = checksum,
                fileName = "IMG.jpg",
                mimeType = "image/jpeg",
                size = bytes.size.toLong(),
                capturedAtMs = 1_700_000_000_000,
                modifiedAtSec = 1_700_000_000,
                zone = ZoneOffset.UTC,
                deviceAssetId = "external_primary:7",
                folder = "DCIM/Camera/",
                favorite = true,
                versionOf = "asset-old",
                open = { OpenedMedia(ByteArrayInputStream(bytes), bytes.size.toLong(), false) },
                onProgress = { sent, _ -> progress = sent },
            ),
        )
        assertTrue(uploaded is UploadResult.Stored)
        assertEquals(bytes.size.toLong(), progress)
        val stored = server.uploads.single()
        assertEquals("IMG.jpg", stored.fileName)
        assertEquals("asset-old", stored.versionOf)
        assertEquals("true", stored.favorite)
        assertEquals(checksum, stored.checksum)

        val known = client.checkAssets(listOf(checksum)) as ApiResult.Ok
        assertTrue(checksum !in known.value.missing)
        assertEquals(server.assetId(checksum), known.value.existing[checksum])

        server.memoriesBody = """{"memories":[{"id":"m1","title":"Trip","date":"2026-10-26","coverUrl":"/covers/m1"}]}"""
        val memories = (client.upcomingMemories() as ApiResult.Ok).value
        assertEquals(LocalDate.of(2026, 10, 26), memories.single().date)
        assertEquals("Trip", memories.single().title)

        val paired = factory.create(server.baseUrl(), null).pair("one-time", "Pixel")
        assertTrue(paired is ApiResult.Ok)
        assertEquals("paired-token", (paired as ApiResult.Ok).value.deviceToken)
        assertEquals("Ada", paired.value.userName)
    }

    @Test
    fun growingFileIsReportedAsLocalChange() = runBlocking {
        val client = factory.create(server.baseUrl(), "t")
        val bytes = "abc".toByteArray()
        val result = client.uploadAsset(
            AssetUpload(
                checksum = "abc",
                fileName = "a.jpg",
                mimeType = "image/jpeg",
                size = 3,
                capturedAtMs = 0,
                modifiedAtSec = 0,
                zone = ZoneOffset.UTC,
                deviceAssetId = "v:1",
                folder = "DCIM/",
                favorite = false,
                versionOf = null,
                open = { OpenedMedia(ByteArrayInputStream(bytes + 9.toByte()), 3, false) },
                onProgress = { _, _ -> },
            ),
        )
        assertTrue(result is UploadResult.LocalChanged)
        assertEquals(0, server.uploads.size)
    }

    @Test
    fun unauthorizedAndResultShapes() = runBlocking {
        server.unauthorized = true
        val client = factory.create(server.baseUrl(), "stale")
        assertTrue(client.checkAssets(listOf("aa")) is ApiResult.Unauthorized)
        val parsed = SyncApiClient.parseCheck(listOf("a", "b"), """{"results":[{"checksum":"A","exists":true,"assetId":"1"}]}""")
        assertEquals(setOf("b"), parsed.missing)
        assertEquals("1", parsed.existing["a"])
        val contract = SyncApiClient.parseCheck(listOf("a", "b"), """{"missing":["b"],"present":[{"checksum":"A","assetId":"asset-1"}]}""")
        assertEquals(setOf("b"), contract.missing)
        assertEquals("asset-1", contract.existing["a"])
        val memories = SyncApiClient.parseMemories("""[{"id":"m","date":"2020-01-02"}]""")
        assertEquals("On this day", memories.single().title)
    }

    @Test
    fun deadPortIsUnreachable() = runBlocking {
        val client = factory.create("http://127.0.0.1:9", null)
        val health = client.health()
        assertTrue(health is HealthResult.Unreachable)
        assertEquals(1, client.requestCount)
    }
}
