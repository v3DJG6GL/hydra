package io.github.v3djg6gl.hydra.tv

import android.os.Handler
import android.os.Looper
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/**
 * Scheme resolution for URLs typed without http/https: try https first,
 * then fall back to http (WAN deployments are TLS, LAN relays are plain
 * http). URLs that already carry a scheme pass through untouched. The
 * callback always lands on the main thread.
 */
object UrlProbe {
    fun resolve(url: String, cb: (String) -> Unit) {
        val main = Handler(Looper.getMainLooper())
        if (url.isBlank() || url.startsWith("http://") || url.startsWith("https://")) {
            main.post { cb(url) }
            return
        }
        thread {
            val https = "https://$url"
            val http = "http://$url"
            val resolved = when {
                reachable(https) -> https
                reachable(http) -> http
                else -> guess(url) // server down right now — pick the likely scheme
            }
            main.post { cb(resolved) }
        }
    }

    /** Any HTTP status counts as reachable — only transport failures disqualify. */
    private fun reachable(u: String): Boolean = try {
        val conn = URL(u).openConnection() as HttpURLConnection
        conn.connectTimeout = 4000
        conn.readTimeout = 4000
        conn.instanceFollowRedirects = false
        conn.requestMethod = "GET"
        conn.responseCode
        conn.disconnect()
        true
    } catch (e: Exception) { false }

    /** IP literals / explicit ports smell like LAN → http; names → https. */
    private fun guess(hostish: String): String {
        val host = hostish.substringBefore('/')
        val lanish = host.contains(':') || host.matches(Regex("[0-9.]+"))
        return if (lanish) "http://$hostish" else "https://$hostish"
    }
}
