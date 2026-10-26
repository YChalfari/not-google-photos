package com.notgooglephotos.photosync.engine

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager

data class NetworkState(
    val connected: Boolean,
    /** Not metered (Wi-Fi or Ethernet in practice). This is what "Wi-Fi only" checks. */
    val unmetered: Boolean,
    /** On Wi-Fi or Ethernet, where the home address can answer. */
    val local: Boolean,
) {
    companion object {
        val OFFLINE = NetworkState(connected = false, unmetered = false, local = false)
    }
}

/** What the phone is doing right now. Tests swap in a fake. */
interface DeviceConditions {
    fun network(): NetworkState

    fun isCharging(): Boolean
}

class AndroidDeviceConditions(private val context: Context) : DeviceConditions {
    override fun network(): NetworkState {
        val connectivity = context.getSystemService(ConnectivityManager::class.java) ?: return NetworkState.OFFLINE
        val caps = connectivity.activeNetwork?.let(connectivity::getNetworkCapabilities) ?: return NetworkState.OFFLINE
        return NetworkState(
            connected = true,
            unmetered = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED),
            local = caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET),
        )
    }

    override fun isCharging(): Boolean = context.getSystemService(BatteryManager::class.java)?.isCharging == true
}
