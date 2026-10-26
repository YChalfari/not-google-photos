package com.notgooglephotos.photosync.model

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.net.InetAddress

/**
 * Address rules: the home address may use plain HTTP, but only for hosts on a private network
 * (Android's cleartext allowance is app-wide, so this check is what keeps HTTP off the internet).
 * The away-from-home address must use HTTPS.
 */
object ServerAddress {
    private val LOCAL_SUFFIXES = listOf(".local", ".lan", ".home", ".home.arpa", ".internal", ".localdomain")

    fun validateHome(raw: String): String {
        val url = parse(raw)
        require(url.scheme == "https" || isPrivateHost(url.host)) {
            "Plain HTTP is only allowed for servers on your home network; use HTTPS for ${url.host}"
        }
        return canonical(url)
    }

    fun validateRemote(raw: String): String {
        val url = parse(raw)
        require(url.scheme == "https") { "The away-from-home address must use HTTPS" }
        return canonical(url)
    }

    /** Base URL with a trailing slash, so endpoint paths resolve relative to any path prefix. */
    fun baseUrl(address: String): HttpUrl {
        val url = parse(address)
        return if (url.encodedPath.endsWith("/")) url else url.newBuilder().addPathSegment("").build()
    }

    fun isPrivateHost(host: String): Boolean {
        val lower = host.lowercase().trimEnd('.')
        if (lower == "localhost" || LOCAL_SUFFIXES.any { lower.endsWith(it) }) return true
        if (!lower.contains('.') && !lower.contains(':')) return true
        if (!looksLikeIpLiteral(lower)) return false
        val bytes = runCatching { InetAddress.getByName(lower).address }.getOrNull() ?: return false
        return if (bytes.size == 4) isPrivateV4(bytes) else isPrivateV6(bytes)
    }

    private fun parse(raw: String): HttpUrl {
        val trimmed = raw.trim()
        val url = trimmed.toHttpUrlOrNull() ?: throw IllegalArgumentException("'$trimmed' isn't a valid http(s) URL")
        require(url.querySize == 0 && url.fragment == null) { "Server addresses can't have a query or fragment" }
        return url
    }

    private fun canonical(url: HttpUrl): String = url.toString().trimEnd('/')

    private fun looksLikeIpLiteral(host: String) = host.contains(':') || host.all { it.isDigit() || it == '.' }

    private fun isPrivateV4(b: ByteArray): Boolean {
        val a = b[0].toInt() and 0xff
        val second = b[1].toInt() and 0xff
        return a == 10 ||
            a == 127 ||
            (a == 172 && second in 16..31) ||
            (a == 192 && second == 168) ||
            (a == 169 && second == 254) ||
            // 100.64.0.0/10: carrier-grade NAT range that Tailscale uses for its WireGuard tunnel.
            (a == 100 && second in 64..127)
    }

    private fun isPrivateV6(b: ByteArray): Boolean {
        val first = b[0].toInt() and 0xff
        val second = b[1].toInt() and 0xff
        val loopback = b.take(15).all { it.toInt() == 0 } && b[15].toInt() == 1
        return loopback || (first and 0xfe) == 0xfc || (first == 0xfe && (second and 0xc0) == 0x80)
    }
}
