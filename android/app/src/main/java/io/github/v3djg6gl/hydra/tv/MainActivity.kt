package io.github.v3djg6gl.hydra.tv

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import org.json.JSONObject

/**
 * The kiosk: one fullscreen WebView on the hydra display page. The page owns
 * rendering, pairing, and the relay; this activity owns fullscreen,
 * keep-screen-on, WebView recovery, key policy, and the native audio path.
 *
 * Keys: everything D-pad flows to the page as DOM KeyboardEvents (the
 * pairing overlay runs on Enter/arrows). BACK is double-press-to-exit,
 * long-press for settings (the one guaranteed escape hatch across remotes);
 * a single BACK forwards Escape to the page. MENU/SETTINGS opens settings.
 */
class MainActivity : Activity() {
    companion object {
        private const val RC_MIC = 41
        private const val EXIT_WINDOW_MS = 2000L
        const val EXTRA_FROM_SETTINGS = "fromSettings"
        const val EXTRA_FROM_BOOT = "fromBoot"
    }

    lateinit var prefs: Prefs
    lateinit var bridge: ShellBridge
    lateinit var watchdog: Watchdog
    lateinit var audioCapture: AudioCapture
    private lateinit var host: WebViewHost
    private lateinit var root: FrameLayout
    private var errorOverlay: LinearLayout? = null
    private var lastBackUp = 0L
    private var backLongPressFired = false
    private var sentToSettings = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        CrashRestart.install(this)
        prefs = Prefs(this)

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        WindowCompat.setDecorFitsSystemWindows(window, false)

        root = FrameLayout(this)
        root.setBackgroundColor(Color.BLACK)
        setContentView(root)

        bridge = ShellBridge(this, prefs)
        audioCapture = AudioCapture(
            this,
            onBins = { bridge.pushFft(it) },
            onState = { bridge.pushAudioState(it) }
        )
        watchdog = Watchdog(
            this,
            reload = { reason -> runOnUiThread { reloadPage(reason) } },
            showError = { detail -> runOnUiThread { showErrorOverlay(detail) } }
        )
        host = WebViewHost(this, bridge, root)
    }

    // singleTask: launcher/boot relaunches land here — keep getIntent() honest
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        // a fresh manual launch re-arms the optional config-on-launch screen
        if (!intent.getBooleanExtra(EXTRA_FROM_SETTINGS, false) &&
            !intent.getBooleanExtra(EXTRA_FROM_BOOT, false)) sentToSettings = false
    }

    override fun onResume() {
        super.onResume()
        hideSystemBars()
        val skipConfig = intent?.getBooleanExtra(EXTRA_FROM_SETTINGS, false) == true ||
            intent?.getBooleanExtra(EXTRA_FROM_BOOT, false) == true
        if (prefs.serverUrl.isBlank()) {
            // backed out of settings without configuring → let the app close
            // instead of bouncing straight back into settings forever
            if (sentToSettings) { finish(); return }
            sentToSettings = true
            openSettings()
            return
        }
        if (prefs.configOnLaunch && !skipConfig && !sentToSettings) {
            sentToSettings = true
            openSettings()
            return
        }
        if (host.webView == null) {
            host.build()
            loadKiosk()
        }
        host.onResume()
        host.webView?.requestFocus()
        watchdog.start()
        audioCapture.onActivityStart()
        bridge.pushEvent(JSONObject().put("type", "visible").put("visible", true))
    }

    override fun onPause() {
        bridge.pushEvent(JSONObject().put("type", "visible").put("visible", false))
        host.onPause()
        watchdog.stop()
        super.onPause()
    }

    override fun onStop() {
        audioCapture.onActivityStop()
        super.onStop()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars() // some TV dialogs restore the bars
    }

    private fun hideSystemBars() {
        val c = WindowInsetsControllerCompat(window, root)
        c.hide(WindowInsetsCompat.Type.systemBars())
        c.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    }

    private fun loadKiosk() {
        hideErrorOverlay()
        // scheme-less URLs (user typed a bare host) resolve https→http here;
        // the resolved form is persisted so the origin checks see it too
        UrlProbe.resolve(prefs.serverUrl) { resolved ->
            if (isFinishing || isDestroyed) return@resolve
            if (resolved != prefs.serverUrl) prefs.serverUrl = resolved
            host.load(prefs.serverUrl)
        }
    }

    fun reloadPage(reason: String) {
        bridge.log("shell", "reload: $reason")
        bridge.pushEvent(JSONObject().put("type", "reloadScheduled").put("reason", reason).put("inMs", 0))
        if (host.webView == null) host.build()
        loadKiosk()
    }

    fun rebuildWebView(reason: String) {
        bridge.log("shell", "rebuild: $reason")
        host.build()
        loadKiosk()
        watchdog.doReload(reason)
    }

    fun onPageFinished() {
        hideErrorOverlay()
        watchdog.notePageFinished()
    }

    fun onPageError(detail: String) {
        prefs.lastError = detail
        watchdog.noteLoadError(detail)
    }

    fun openSettings() {
        startActivity(Intent(this, SettingsActivity::class.java))
    }

    // ---- native audio: permission hop lives here (needs an Activity)

    fun startAudio(deviceId: Int?) {
        if (!audioCapture.hasPermission()) {
            audioCapture.requestStart(deviceId) // remembers the request; retries after grant
            requestPermissions(arrayOf(android.Manifest.permission.RECORD_AUDIO), RC_MIC)
            return
        }
        audioCapture.requestStart(deviceId)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == RC_MIC) {
            audioCapture.onPermissionResult(
                grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED)
        }
    }

    // ---- key policy

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        when (keyCode) {
            KeyEvent.KEYCODE_BACK -> {
                event.startTracking()
                return true
            }
            KeyEvent.KEYCODE_MENU, KeyEvent.KEYCODE_SETTINGS -> {
                openSettings()
                return true
            }
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onKeyLongPress(keyCode: Int, event: KeyEvent): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            backLongPressFired = true
            openSettings()
            return true
        }
        return super.onKeyLongPress(keyCode, event)
    }

    override fun onKeyUp(keyCode: Int, event: KeyEvent): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            if (backLongPressFired || event.isCanceled) {
                backLongPressFired = false
                return true
            }
            val now = System.currentTimeMillis()
            if (now - lastBackUp < EXIT_WINDOW_MS) {
                finish()
            } else {
                lastBackUp = now
                Toast.makeText(this, "press BACK again to exit — hold for settings", Toast.LENGTH_SHORT).show()
                // let the page close its own overlays too
                host.webView?.evaluateJavascript(
                    "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))", null)
            }
            return true
        }
        return super.onKeyUp(keyCode, event)
    }

    // ---- error overlay (native — must render even when the page can't)

    private fun showErrorOverlay(detail: String) {
        hideErrorOverlay()
        val pad = (resources.displayMetrics.density * 24).toInt()
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(Color.argb(230, 5, 8, 7))
            setPadding(pad, pad, pad, pad)
        }
        col.addView(TextView(this).apply {
            text = "HYDRA DISPLAY — CONNECTION TROUBLE"
            setTextColor(Color.parseColor("#dffff9"))
            textSize = 22f
            gravity = Gravity.CENTER
        })
        col.addView(TextView(this).apply {
            val hb = watchdog.lastHeartbeatAgeMs
            text = listOf(
                "url: ${prefs.serverUrl}",
                "error: $detail",
                if (hb >= 0) "last page heartbeat: ${hb / 1000}s ago" else "no page heartbeat seen",
                "retrying automatically…"
            ).joinToString("\n")
            setTextColor(Color.parseColor("#8891a0"))
            textSize = 14f
            gravity = Gravity.CENTER
            setPadding(0, pad / 2, 0, pad / 2)
        })
        val row = LinearLayout(this).apply { gravity = Gravity.CENTER }
        row.addView(Button(this).apply {
            text = "RETRY NOW"
            setOnClickListener { reloadPage("manual retry") }
        })
        row.addView(Button(this).apply {
            text = "SETTINGS"
            setOnClickListener { openSettings() }
        })
        col.addView(row)
        root.addView(col, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        errorOverlay = col
        row.getChildAt(0).requestFocus()
    }

    private fun hideErrorOverlay() {
        errorOverlay?.let { root.removeView(it) }
        errorOverlay = null
        host.webView?.requestFocus()
    }
}
