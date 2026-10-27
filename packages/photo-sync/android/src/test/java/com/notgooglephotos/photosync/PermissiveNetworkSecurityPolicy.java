package com.notgooglephotos.photosync;

import android.security.NetworkSecurityPolicy;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;

/**
 * Robolectric 4.9+ removed {@code ShadowNetworkSecurityPolicy}. OkHttp still asks
 * {@link NetworkSecurityPolicy} before it will open a plain-HTTP mock server, so unit tests
 * install this shadow from {@code robolectric.properties}.
 */
@Implements(NetworkSecurityPolicy.class)
public class PermissiveNetworkSecurityPolicy {
    @Implementation
    protected boolean isCleartextTrafficPermitted() {
        return true;
    }

    @Implementation
    protected boolean isCleartextTrafficPermitted(String hostname) {
        return true;
    }
}
