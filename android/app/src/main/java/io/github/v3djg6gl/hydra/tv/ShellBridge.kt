package io.github.v3djg6gl.hydra.tv

import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.webkit.WebViewCompat
import org.json.JSONObject

/**
 * window.HydraShell — the entire JS bridge, page ↔ shell.
 *
 * Page → shell: the @JavascriptInterface methods below (called on the
 * WebView's JavaBridge thread; anything mutating hops to the main thread).
 * Shell → page: existence-guarded evaluateJavascript pushes —
 *   window.__hydraNativeFft([8 floats])           ~25 Hz while capturing
 *   window.__hydraShellEvent({type:'audioState'|'visible'|'reloadScheduled',…})
 * The web-side consumers live in src/lib/fft-bus.js and display-mode.js.
 */
class ShellBridge(private val main: MainActivity, private val prefs: Prefs) {
    private val handler = Handler(Looper.getMainLooper())
    private val logBuf = ArrayDeque<String>()

    @Volatile var webView: WebView? = null

    // ---- shell → page pushes

    fun pushFft(bins: FloatArray) {
        val arr = StringBuilder("[")
        for (i in bins.indices) {
            if (i > 0) arr.append(',')
            arr.append(String.format(java.util.Locale.US, "%.3f", bins[i]))
        }
        arr.append(']')
        eval("window.__hydraNativeFft && window.__hydraNativeFft($arr)")
    }

    fun pushEvent(ev: JSONObject) {
        eval("window.__hydraShellEvent && window.__hydraShellEvent($ev)")
    }

    fun pushAudioState(state: JSONObject) {
        pushEvent(JSONObject().apply {
            put("type", "audioState")
            for (k in state.keys()) put(k, state.get(k))
        })
    }

    private fun eval(js: String) {
        handler.post { webView?.evaluateJavascript(js, null) }
    }

    // ---- page → shell (JavaBridge thread!)

    @JavascriptInterface
    fun getConfig(): String {
        val wvPkg = try {
            WebViewCompat.getCurrentWebViewPackage(main)?.let { "${it.packageName} ${it.versionName}" }
        } catch (e: Exception) { null }
        val appVersion = try {
            main.packageManager.getPackageInfo(main.packageName, 0).versionName
        } catch (e: Exception) { "?" }
        return JSONObject().apply {
            put("api", 1)
            put("appVersion", appVersion)
            put("displayName", prefs.displayName)
            put("serverUrl", prefs.serverUrl)
            put("device", "${Build.MANUFACTURER} ${Build.MODEL}")
            put("androidSdk", Build.VERSION.SDK_INT)
            put("webview", wvPkg ?: "unknown")
        }.toString()
    }

    @JavascriptInterface
    fun heartbeat(json: String?) {
        main.watchdog.noteHeartbeat()
    }

    @JavascriptInterface
    fun requestReload(reason: String?) {
        log("info", "page requested reload: $reason")
        handler.post { main.reloadPage("page:$reason") }
    }

    @JavascriptInterface
    fun openSettings() {
        handler.post { main.openSettings() }
    }

    @JavascriptInterface
    fun log(level: String?, msg: String?) {
        val line = "[page:$level] $msg"
        Log.i("HydraTv", line)
        synchronized(logBuf) {
            logBuf.addLast(line)
            while (logBuf.size > 50) logBuf.removeFirst()
        }
    }

    fun recentLogs(): List<String> = synchronized(logBuf) { logBuf.toList() }

    // ---- native audio

    @JavascriptInterface
    fun audioListInputs(): String = main.audioCapture.listInputs().toString()

    @JavascriptInterface
    fun audioStart(json: String?) {
        if (!prefs.audioEnabled) {
            // surfaced on the deck OSD via the audioState event — the user
            // flips the switch in the shell settings once, deliberately
            pushAudioState(JSONObject().apply {
                put("state", "denied"); put("error", "native audio disabled in TV settings")
            })
            return
        }
        val deviceId = try { JSONObject(json ?: "{}").optInt("deviceId", -1).takeIf { it > 0 } }
        catch (e: Exception) { null }
        handler.post { main.startAudio(deviceId) }
    }

    @JavascriptInterface
    fun audioStop() {
        handler.post { main.audioCapture.requestStop() }
    }

    @JavascriptInterface
    fun audioState(): String = main.audioCapture.stateJson().toString()
}
