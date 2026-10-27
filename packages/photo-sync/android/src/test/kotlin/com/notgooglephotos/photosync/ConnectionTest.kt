package com.notgooglephotos.photosync

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.notgooglephotos.photosync.engine.BackupCoordinator
import com.notgooglephotos.photosync.net.DiscoveredServer
import com.notgooglephotos.photosync.work.SyncScheduler
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

@RunWith(AndroidJUnit4::class)
@Config(sdk = [34])
class ConnectionTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private lateinit var fx: EngineFixture

    @Before fun setUp() {
        permitCleartext()
        fx = EngineFixture(context)
        fx.start()
    }

    @After fun tearDown() = fx.close()

    private fun coordinator() = BackupCoordinator(
        fx.db,
        fx.store,
        SyncScheduler(context, fx.store, fx.clock),
        fx.resolver,
        fx.conditions,
        fx.clock,
    )

    @Test
    fun returnsTheAddressThatAnswersAndTheDeviceToken() = runBlocking {
        val connection = coordinator().connection()
        assertEquals(fx.server.baseUrl(), connection?.baseUrl)
        assertEquals("device-token", connection?.token)
        assertEquals("srv-1", connection?.serverId)
        assertEquals("srv-1", fx.store.settings.serverId)
    }

    @Test
    fun returnsNullWhenThePhoneIsNotPaired() = runBlocking {
        fx.store.deviceToken = null
        assertNull(coordinator().connection())
    }

    @Test
    fun keepsTheStoredAddressWhenNothingAnswers() = runBlocking {
        fx.store.settings = fx.store.settings.copy(homeUrl = "http://127.0.0.1:1", serverId = "srv-1")
        val connection = coordinator().connection()
        assertEquals("http://127.0.0.1:1", connection?.baseUrl)
        assertEquals("device-token", connection?.token)
        assertEquals("srv-1", connection?.serverId)
    }

    @Test
    fun storesAHomeAddressFoundOnTheNetwork() = runBlocking {
        val found = fx.server.baseUrl()
        fx.store.settings = fx.store.settings.copy(homeUrl = "http://127.0.0.1:1", serverId = "srv-1")
        fx.discovery.servers = listOf(
            DiscoveredServer("Home", "srv-1", found, "127.0.0.1", fx.server.port()),
        )
        val connection = coordinator().connection()
        assertEquals(found, connection?.baseUrl)
        assertEquals("device-token", connection?.token)
        assertEquals(found, fx.store.settings.homeUrl)
    }
}
