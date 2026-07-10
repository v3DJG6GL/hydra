package io.github.v3djg6gl.hydra.tv

import android.content.Context
import android.content.SharedPreferences

/** Thin SharedPreferences wrapper — the app's entire persistent state. */
class Prefs(context: Context) {
    private val sp: SharedPreferences =
        context.getSharedPreferences("hydra-tv", Context.MODE_PRIVATE)

    /** Full kiosk URL, origin + path + query (e.g. https://…/?display=1). */
    var serverUrl: String
        get() = sp.getString("serverUrl", "") ?: ""
        set(v) { sp.edit().putString("serverUrl", normalizeUrl(v)).apply() }

    var displayName: String
        get() = sp.getString("displayName", "hydra display") ?: "hydra display"
        set(v) { sp.edit().putString("displayName", v.trim().ifEmpty { "hydra display" }).apply() }

    var autostart: Boolean
        get() = sp.getBoolean("autostart", true)
        set(v) { sp.edit().putBoolean("autostart", v).apply() }

    /** Native audio capture allowed at all (capture itself starts on request). */
    var audioEnabled: Boolean
        get() = sp.getBoolean("audioEnabled", false)
        set(v) { sp.edit().putBoolean("audioEnabled", v).apply() }

    /** Stored as "type:productName" — numeric device ids change across reboots. */
    var audioPreferredDevice: String
        get() = sp.getString("audioPreferredDevice", "") ?: ""
        set(v) { sp.edit().putString("audioPreferredDevice", v).apply() }

    var recentUrls: List<String>
        get() = (sp.getString("recentUrls", "") ?: "").split('\n').filter { it.isNotBlank() }
        set(v) { sp.edit().putString("recentUrls", v.distinct().take(3).joinToString("\n")).apply() }

    var lastError: String
        get() = sp.getString("lastError", "") ?: ""
        set(v) {
            sp.edit().putString("lastError", v)
                .putLong("lastErrorAt", System.currentTimeMillis()).apply()
        }
    val lastErrorAt: Long get() = sp.getLong("lastErrorAt", 0)

    var lastCrashAt: Long
        get() = sp.getLong("lastCrashAt", 0)
        set(v) { sp.edit().putLong("lastCrashAt", v).apply() }

    fun rememberUrl(url: String) {
        if (url.isBlank()) return
        recentUrls = listOf(url) + recentUrls
    }

    companion object {
        /** Bare "192.168.1.50:8080" becomes "http://192.168.1.50:8080/". */
        fun normalizeUrl(raw: String): String {
            val s = raw.trim()
            if (s.isEmpty()) return ""
            val withScheme = if (s.startsWith("http://") || s.startsWith("https://")) s else "http://$s"
            return if (android.net.Uri.parse(withScheme).path.isNullOrEmpty()) "$withScheme/" else withScheme
        }
    }
}
