package com.notgooglephotos.photosync.net

import com.notgooglephotos.photosync.engine.NetworkState
import com.notgooglephotos.photosync.model.SyncSettings
import java.util.concurrent.atomic.AtomicInteger

/**
 * The reachability check every run starts with: one health request per known address, home
 * first when on Wi-Fi (remote first otherwise). If the home address stops answering on Wi-Fi and
 * the server id is known, a short local-network browse looks for the server at a new address.
 */
class ServerResolver(
    private val factory: SyncApiFactory,
    private val discovery: ServerDiscovery?,
) {
    sealed interface Result {
        data class Reachable(
            val client: SyncApiClient,
            val address: String,
            val serverId: String?,
            /** Set when the server was found at a new home address, which should replace the stored one. */
            val movedHome: String? = null,
        ) : Result

        data class Unreachable(val message: String) : Result
    }

    suspend fun resolve(settings: SyncSettings, token: String?, network: NetworkState, counter: AtomicInteger): Result {
        val problems = mutableListOf<String>()

        suspend fun probe(address: String, label: String): Result.Reachable? {
            val client = factory.create(address, token, counter)
            return when (val health = client.health()) {
                is HealthResult.Ok ->
                    if (settings.serverId != null && health.serverId != null && health.serverId != settings.serverId) {
                        problems += "$label answers as a different server"
                        null
                    } else {
                        Result.Reachable(client, address, health.serverId)
                    }
                is HealthResult.Unhealthy -> null.also { problems += "$label answered HTTP ${health.code}" }
                is HealthResult.Unreachable -> null.also { problems += "$label: ${health.reason}" }
            }
        }

        val home = settings.homeUrl
        val remote = settings.remoteUrl
        if (network.local) {
            home?.let { probe(it, HOME)?.let { found -> return found } }
            rediscover(settings) { probe(it, FOUND) }?.let { return it }
            remote?.let { probe(it, REMOTE)?.let { found -> return found } }
        } else {
            remote?.let { probe(it, REMOTE)?.let { found -> return found } }
            home?.let { probe(it, HOME)?.let { found -> return found } }
        }
        return Result.Unreachable(problems.joinToString("; ").ifEmpty { "No server address is set" })
    }

    private suspend fun rediscover(settings: SyncSettings, probe: suspend (String) -> Result.Reachable?): Result.Reachable? {
        val serverId = settings.serverId ?: return null
        val finder = discovery ?: return null
        val found = finder.discover(DISCOVERY_TIMEOUT_MS) { it.serverId == serverId }
            .firstOrNull { it.serverId == serverId && it.url != settings.homeUrl } ?: return null
        return probe(found.url)?.copy(movedHome = found.url)
    }

    private companion object {
        const val DISCOVERY_TIMEOUT_MS = 4_000L
        const val HOME = "Home address"
        const val REMOTE = "Away-from-home address"
        const val FOUND = "Server found on the network"
    }
}
