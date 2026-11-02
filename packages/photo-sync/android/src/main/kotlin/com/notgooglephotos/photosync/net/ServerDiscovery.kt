package com.notgooglephotos.photosync.net

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import com.notgooglephotos.photosync.model.ServerAddress
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject
import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress
import kotlin.coroutines.resume

data class DiscoveredServer(val name: String, val serverId: String?, val url: String, val host: String, val port: Int) {
    fun toJson(): JSONObject = JSONObject()
        .put("name", name)
        .put("serverId", serverId ?: JSONObject.NULL)
        .put("url", url)
        .put("host", host)
        .put("port", port)
}

/** Finds Not Google Photos servers announced on the local network. */
interface ServerDiscovery {
    /** Browses for up to [timeoutMs], stopping early once [enough] accepts a found server. */
    suspend fun discover(timeoutMs: Long, enough: (DiscoveredServer) -> Boolean = { false }): List<DiscoveredServer>
}

/**
 * DNS-SD browsing through Android's NsdManager. The Mac's announcer advertises
 * `_ngp._tcp` with TXT key `id` (server id). `scheme` and `path` are optional.
 */
class NsdServerDiscovery(context: Context) : ServerDiscovery {
    private val nsd: NsdManager? = context.getSystemService(NsdManager::class.java)

    override suspend fun discover(timeoutMs: Long, enough: (DiscoveredServer) -> Boolean): List<DiscoveredServer> {
        val manager = nsd ?: return emptyList()
        val found = Channel<NsdServiceInfo>(Channel.UNLIMITED)
        val servers = LinkedHashMap<String, DiscoveredServer>()
        val listener = object : NsdManager.DiscoveryListener {
            override fun onServiceFound(serviceInfo: NsdServiceInfo) {
                found.trySend(serviceInfo)
            }

            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                found.close()
            }

            override fun onDiscoveryStarted(serviceType: String) = Unit
            override fun onDiscoveryStopped(serviceType: String) = Unit
            override fun onServiceLost(serviceInfo: NsdServiceInfo) = Unit
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) = Unit
        }
        manager.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener)
        try {
            withTimeoutOrNull(timeoutMs) {
                for (info in found) {
                    val server = resolve(manager, info)?.let(::toServer) ?: continue
                    servers[server.url] = server
                    if (enough(server)) break
                }
            }
        } finally {
            runCatching { manager.stopServiceDiscovery(listener) }
            found.close()
        }
        return servers.values.toList()
    }

    @Suppress("DEPRECATION")
    private suspend fun resolve(manager: NsdManager, info: NsdServiceInfo): NsdServiceInfo? = suspendCancellableCoroutine { continuation ->
        val listener = object : NsdManager.ResolveListener {
            override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                if (continuation.isActive) continuation.resume(null)
            }

            override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
                if (continuation.isActive) continuation.resume(serviceInfo)
            }
        }
        manager.resolveService(info, listener)
        if (Build.VERSION.SDK_INT >= 34) {
            continuation.invokeOnCancellation { runCatching { manager.stopServiceResolution(listener) } }
        }
    }

    private fun toServer(info: NsdServiceInfo): DiscoveredServer? {
        val address = hostAddress(info) ?: return null
        val literal = address.hostAddress?.substringBefore('%') ?: return null
        val attributes = info.attributes
        fun attribute(key: String) = attributes[key]?.toString(Charsets.UTF_8)?.trim()?.ifEmpty { null }
        val scheme = attribute("scheme")?.lowercase()?.takeIf { it == "http" || it == "https" } ?: "http"
        val host = if (address is Inet6Address) "[$literal]" else literal
        val path = attribute("path")?.trim('/')?.takeIf { it.isNotEmpty() }?.let { "/$it" } ?: ""
        val url = runCatching { ServerAddress.validateHome("$scheme://$host:${info.port}$path") }.getOrNull() ?: return null
        return DiscoveredServer(name = info.serviceName, serverId = attribute("id"), url = url, host = literal, port = info.port)
    }

    private fun hostAddress(info: NsdServiceInfo): InetAddress? =
        if (Build.VERSION.SDK_INT >= 34) {
            info.hostAddresses.sortedBy { if (it is Inet4Address) 0 else 1 }.firstOrNull()
        } else {
            @Suppress("DEPRECATION")
            info.host
        }

    companion object {
        const val SERVICE_TYPE = "_ngp._tcp"
    }
}
