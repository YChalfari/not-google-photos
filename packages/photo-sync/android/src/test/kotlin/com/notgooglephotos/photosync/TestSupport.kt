package com.notgooglephotos.photosync

import android.security.NetworkSecurityPolicy

/** Fails fast when the Robolectric cleartext shadow in robolectric.properties did not load. */
fun permitCleartext() {
    check(NetworkSecurityPolicy.getInstance().isCleartextTrafficPermitted("127.0.0.1")) {
        "cleartext blocked; PermissiveNetworkSecurityPolicy was not installed"
    }
}
