package io.github.v3djg6gl.hydra.tv

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.text.InputType
import android.webkit.CookieManager
import android.webkit.WebStorage
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Spinner
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import androidx.webkit.WebViewCompat
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/**
 * The escape hatch (hold BACK in the kiosk, or MENU). Plain vertical list of
 * stock widgets — D-pad focus order = document order, no focus code needed.
 *
 * Headless provisioning (Pi5 / bench):
 *   adb shell am start -n io.github.v3djg6gl.hydra.tv/.SettingsActivity \
 *     -e url "http://192.168.1.50:8080/?display=1" -e name "stage tv" --ez apply true
 */
class SettingsActivity : Activity() {
    private lateinit var prefs: Prefs
    private lateinit var urlIn: EditText
    private lateinit var nameIn: EditText
    private lateinit var autostartSw: Switch
    private lateinit var audioSw: Switch
    private lateinit var deviceSpin: Spinner
    private lateinit var diag: TextView
    private var deviceIds: List<String> = emptyList()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        applyIntentExtras(intent)

        val pad = (resources.displayMetrics.density * 28).toInt()
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad * 2, pad, pad * 2, pad)
            setBackgroundColor(Color.parseColor("#0a0b0d"))
        }

        col.addView(caption("HYDRA DISPLAY — SETTINGS", 22f, "#dffff9"))

        col.addView(caption("server url (e.g. https://hydra-….example.com/?display=1  or  http://<pi>:8080/?display=1)", 12f))
        urlIn = EditText(this).apply {
            setText(prefs.serverUrl)
            inputType = InputType.TYPE_TEXT_VARIATION_URI
            isSingleLine = true
            setTextColor(Color.WHITE)
        }
        col.addView(urlIn)
        prefs.recentUrls.filter { it != prefs.serverUrl }.take(2).forEach { recent ->
            col.addView(Button(this).apply {
                text = "recent: $recent"
                isAllCaps = false
                setOnClickListener { urlIn.setText(recent) }
            })
        }

        col.addView(caption("display name (shown on the deck)", 12f))
        nameIn = EditText(this).apply {
            setText(prefs.displayName)
            isSingleLine = true
            setTextColor(Color.WHITE)
        }
        col.addView(nameIn)

        autostartSw = Switch(this).apply {
            text = "start on boot"
            isChecked = prefs.autostart
            setTextColor(Color.WHITE)
        }
        col.addView(autostartSw)
        col.addView(caption(overlayStatus(), 11f))
        if (Build.VERSION.SDK_INT >= 29 && !Settings.canDrawOverlays(this)) {
            col.addView(Button(this).apply {
                text = "GRANT \"DISPLAY OVER OTHER APPS\" (needed for boot autostart)"
                setOnClickListener {
                    try {
                        startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                            Uri.parse("package:$packageName")))
                    } catch (e: Exception) {
                        Toast.makeText(context, "not available on this device — use: adb shell appops set $packageName SYSTEM_ALERT_WINDOW allow", Toast.LENGTH_LONG).show()
                    }
                }
            })
        }

        audioSw = Switch(this).apply {
            text = "allow native audio capture (TV mic → a.fft)"
            isChecked = prefs.audioEnabled
            setTextColor(Color.WHITE)
        }
        col.addView(audioSw)
        col.addView(caption("input device (auto = system default / last USB mic)", 12f))
        deviceSpin = Spinner(this)
        populateDevices()
        col.addView(deviceSpin)
        val micGranted = checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
        col.addView(caption(if (micGranted) "microphone permission: granted" else
            "microphone permission: not granted yet (the system asks when capture first starts)", 11f))

        col.addView(Button(this).apply {
            text = "SAVE & OPEN KIOSK"
            setOnClickListener { saveAll(); finishToKiosk() }
        })
        col.addView(Button(this).apply {
            text = "TEST CONNECTION"
            setOnClickListener { saveAll(); testConnection() }
        })
        col.addView(Button(this).apply {
            text = "CLEAR WEBVIEW DATA & RE-PAIR"
            setOnClickListener {
                AlertDialog.Builder(this@SettingsActivity)
                    .setMessage("Clears the stored pairing — the display shows a fresh pairing code next boot. Scenes stay on the relay.")
                    .setPositiveButton("CLEAR") { _, _ ->
                        WebStorage.getInstance().deleteAllData()
                        CookieManager.getInstance().removeAllCookies(null)
                        Toast.makeText(this@SettingsActivity, "cleared — reopen the kiosk", Toast.LENGTH_SHORT).show()
                    }
                    .setNegativeButton("KEEP", null)
                    .show()
            }
        })

        diag = caption(diagnostics(), 11f)
        col.addView(diag)

        val scroll = ScrollView(this)
        scroll.addView(col)
        setContentView(scroll)
    }

    override fun onPause() {
        saveAll()
        super.onPause()
    }

    private fun caption(text: String, size: Float, color: String = "#8891a0"): TextView =
        TextView(this).apply {
            this.text = text
            textSize = size
            setTextColor(Color.parseColor(color))
            val p = (resources.displayMetrics.density * 8).toInt()
            setPadding(0, p, 0, p / 2)
        }

    private fun overlayStatus(): String = when {
        Build.VERSION.SDK_INT < 29 -> "boot autostart: no extra grant needed on this Android version"
        Settings.canDrawOverlays(this) -> "boot autostart: overlay grant OK"
        else -> "boot autostart on Android 10+ needs the \"display over other apps\" grant below"
    }

    private fun populateDevices() {
        val am = getSystemService(AUDIO_SERVICE) as AudioManager
        val devices = am.getDevices(AudioManager.GET_DEVICES_INPUTS)
            .filter { AudioCapture.typeLabel(it.type) != "input_${it.type}" }
        val labels = mutableListOf("auto")
        val ids = mutableListOf("")
        devices.forEach {
            labels.add("${it.productName} (${AudioCapture.typeLabel(it.type)})")
            ids.add("${AudioCapture.typeLabel(it.type)}:${it.productName}")
        }
        deviceIds = ids
        deviceSpin.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, labels)
        val current = ids.indexOf(prefs.audioPreferredDevice)
        if (current >= 0) deviceSpin.setSelection(current)
    }

    private fun saveAll() {
        prefs.serverUrl = urlIn.text.toString()
        prefs.displayName = nameIn.text.toString()
        prefs.autostart = autostartSw.isChecked
        prefs.audioEnabled = audioSw.isChecked
        prefs.audioPreferredDevice = deviceIds.getOrElse(deviceSpin.selectedItemPosition) { "" }
        prefs.rememberUrl(prefs.serverUrl)
    }

    private fun finishToKiosk() {
        if (prefs.serverUrl.isBlank()) {
            Toast.makeText(this, "set a server url first", Toast.LENGTH_SHORT).show()
            return
        }
        startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP))
        finish()
    }

    private fun testConnection() {
        val url = prefs.serverUrl
        if (url.isBlank()) return
        thread {
            val result = try {
                val conn = URL(url).openConnection() as HttpURLConnection
                conn.requestMethod = "GET"
                conn.connectTimeout = 5000
                conn.readTimeout = 5000
                val code = conn.responseCode
                conn.disconnect()
                "HTTP $code"
            } catch (e: Exception) {
                "failed: ${e.message}"
            }
            runOnUiThread { Toast.makeText(this, "$url → $result", Toast.LENGTH_LONG).show() }
        }
    }

    private fun diagnostics(): String {
        val wv = try {
            WebViewCompat.getCurrentWebViewPackage(this)?.let { "${it.packageName} ${it.versionName}" }
        } catch (e: Exception) { null } ?: "unknown"
        val appVersion = try { packageManager.getPackageInfo(packageName, 0).versionName } catch (e: Exception) { "?" }
        val err = if (prefs.lastError.isNotEmpty())
            "last error: ${prefs.lastError} (${java.text.DateFormat.getDateTimeInstance().format(prefs.lastErrorAt)})"
        else "last error: none"
        return listOf(
            "— diagnostics —",
            "app: $appVersion   android: ${Build.VERSION.SDK_INT} (${Build.MANUFACTURER} ${Build.MODEL})",
            "webview: $wv",
            err,
            "keep-awake note: Android 11+ Energy Saver can still turn the screen off —",
            "  disable it in system settings, or: adb shell settings put secure attentive_timeout -1"
        ).joinToString("\n")
    }

    /** adb provisioning: -e url … -e name … --ez autostart true --ez apply true */
    private fun applyIntentExtras(intent: Intent?) {
        intent ?: return
        intent.getStringExtra("url")?.let { prefs.serverUrl = it }
        intent.getStringExtra("name")?.let { prefs.displayName = it }
        if (intent.hasExtra("autostart")) prefs.autostart = intent.getBooleanExtra("autostart", true)
        if (intent.hasExtra("audio")) prefs.audioEnabled = intent.getBooleanExtra("audio", false)
        if (intent.getBooleanExtra("apply", false)) {
            prefs.rememberUrl(prefs.serverUrl)
            startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            finish()
        }
    }
}
