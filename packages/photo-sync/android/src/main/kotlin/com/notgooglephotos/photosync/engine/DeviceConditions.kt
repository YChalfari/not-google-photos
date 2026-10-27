package com.notgooglephotos.photosync.engine

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
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

    /**
     * Power is connected. [BatteryManager.isCharging] stays false on some phones while the sticky
     * battery status already says charging, which made the first backup restart forever. A full
     * battery that is still plugged in counts too.
     */
    override fun isCharging(): Boolean {
        val battery = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED)) ?: return false
        val status = battery.getIntExtra(BatteryManager.EXTRA_STATUS, BatteryManager.BATTERY_STATUS_UNKNOWN)
        if (status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL) return true
        return battery.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) != 0
    }
}
