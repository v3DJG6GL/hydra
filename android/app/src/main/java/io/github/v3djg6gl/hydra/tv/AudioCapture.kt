package io.github.v3djg6gl.hydra.tv

import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.Looper
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.abs

/**
 * Native audio capture → 8 FFT bands for the page ("TV mic" a.fft source).
 *
 * Exists because getUserMedia inside a TV WebView is a dead end: it is
 * secure-context-gated (so plain-http LAN kiosks never get it) and broken
 * outright on several TV builds. AudioRecord reaches the projector's
 * built-in mics and USB mics regardless of the page's origin.
 *
 * Off until the page (or the deck, through the page) asks: no AudioRecord,
 * no permission prompt at boot. Prefers UNPROCESSED, then VOICE_RECOGNITION
 * (both dodge the AGC that flattens exactly the dynamics music-reactive
 * visuals ride on), then MIC.
 */
class AudioCapture(
    private val context: Context,
    private val onBins: (FloatArray) -> Unit,
    private val onState: (JSONObject) -> Unit
) {
    companion object {
        private const val WINDOW = 2048
        private const val HOP = 1024
        private const val PUSH_MS = 40L // ~25 Hz toward the page
        private val RETRY_MS = longArrayOf(5000, 10000, 30000, 60000)
        // input types worth listing (skip telephony/FM/echo-reference noise)
        private val MIC_TYPES = setOf(
            AudioDeviceInfo.TYPE_BUILTIN_MIC,
            AudioDeviceInfo.TYPE_USB_DEVICE,
            AudioDeviceInfo.TYPE_USB_HEADSET,
            AudioDeviceInfo.TYPE_WIRED_HEADSET,
            AudioDeviceInfo.TYPE_LINE_ANALOG,
            AudioDeviceInfo.TYPE_LINE_DIGITAL,
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO
        )

        fun typeLabel(type: Int): String = when (type) {
            AudioDeviceInfo.TYPE_BUILTIN_MIC -> "builtin_mic"
            AudioDeviceInfo.TYPE_USB_DEVICE -> "usb_device"
            AudioDeviceInfo.TYPE_USB_HEADSET -> "usb_headset"
            AudioDeviceInfo.TYPE_WIRED_HEADSET -> "wired_headset"
            AudioDeviceInfo.TYPE_LINE_ANALOG -> "line_in"
            AudioDeviceInfo.TYPE_LINE_DIGITAL -> "line_in_digital"
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "bluetooth"
            else -> "input_$type"
        }
    }

    private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val main = Handler(Looper.getMainLooper())

    @Volatile private var record: AudioRecord? = null
    @Volatile private var thread: Thread? = null
    @Volatile var state: String = "idle"; private set
    @Volatile private var silenced = false
    @Volatile private var lastError: String? = null
    @Volatile private var sourceName = ""
    @Volatile private var sampleRate = 48000
    @Volatile private var requestedDeviceId: Int? = null
    /** the page asked for capture and hasn't stopped it — drives retries */
    @Volatile var startRequested = false; private set
    private var retryStep = 0
    private var retryPosted: Runnable? = null

    private val deviceCallback = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(added: Array<out AudioDeviceInfo>) {
            // a preferred USB mic plugged back in: restart onto it
            if (startRequested && preferredDevice() != null) restart()
            emitState()
        }
        override fun onAudioDevicesRemoved(removed: Array<out AudioDeviceInfo>) {
            emitState()
        }
    }

    init {
        audioManager.registerAudioDeviceCallback(deviceCallback, main)
    }

    fun hasPermission(): Boolean =
        context.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED

    fun listInputs(): JSONObject {
        val inputs = JSONArray()
        audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS)
            .filter { it.type in MIC_TYPES }
            .forEach {
                inputs.put(JSONObject().apply {
                    put("id", it.id)
                    put("type", typeLabel(it.type))
                    put("name", it.productName?.toString() ?: typeLabel(it.type))
                })
            }
        return JSONObject().apply {
            put("inputs", inputs)
            put("selectedId", record?.routedDevice?.id ?: JSONObject.NULL)
            put("capturing", state == "capturing")
        }
    }

    fun stateJson(): JSONObject = JSONObject().apply {
        put("state", state)
        put("deviceId", record?.routedDevice?.id ?: JSONObject.NULL)
        put("sampleRate", sampleRate)
        put("source", sourceName)
        put("silenced", silenced)
        put("error", lastError ?: JSONObject.NULL)
    }

    private fun emitState() = onState(stateJson())

    private fun setState(s: String, error: String? = null) {
        state = s
        lastError = error
        emitState()
    }

    /** Called from the bridge; permission flow is MainActivity's job. */
    fun requestStart(deviceId: Int?) {
        startRequested = true
        requestedDeviceId = deviceId ?: requestedDeviceId
        retryStep = 0
        main.post { tryStart() }
    }

    fun requestStop() {
        startRequested = false
        retryPosted?.let { main.removeCallbacks(it) }
        main.post { stopInternal("idle") }
    }

    /** Activity lifecycle: capture pauses in background (API 30+ silences it anyway). */
    fun onActivityStop() { main.post { stopInternal(if (startRequested) "starting" else "idle") } }
    fun onActivityStart() { if (startRequested) main.post { tryStart() } }

    fun onPermissionResult(granted: Boolean) {
        if (granted) main.post { tryStart() }
        else { startRequested = false; setState("denied") }
    }

    private fun preferredDevice(): AudioDeviceInfo? {
        val devices = audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS).filter { it.type in MIC_TYPES }
        requestedDeviceId?.let { id -> devices.find { it.id == id }?.let { return it } }
        val stored = Prefs(context).audioPreferredDevice
        if (stored.isNotEmpty()) {
            devices.find { "${typeLabel(it.type)}:${it.productName}" == stored }?.let { return it }
        }
        return null
    }

    private fun restart() {
        stopInternal("starting")
        tryStart()
    }

    @SuppressLint("MissingPermission") // guarded by hasPermission()
    private fun tryStart() {
        if (!startRequested || state == "capturing" || state == "denied") return
        if (!hasPermission()) { setState("denied", "RECORD_AUDIO not granted"); return }
        setState("starting")

        val unprocessedOk = Build.VERSION.SDK_INT >= 24 &&
            audioManager.getProperty(AudioManager.PROPERTY_SUPPORT_AUDIO_SOURCE_UNPROCESSED) == "true"
        val sources = buildList {
            if (unprocessedOk) add(MediaRecorder.AudioSource.UNPROCESSED to "unprocessed")
            add(MediaRecorder.AudioSource.VOICE_RECOGNITION to "voice_recognition")
            add(MediaRecorder.AudioSource.MIC to "mic")
        }
        var rec: AudioRecord? = null
        outer@ for ((src, name) in sources) {
            for (rate in intArrayOf(48000, 44100)) {
                val minBuf = AudioRecord.getMinBufferSize(
                    rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_FLOAT
                )
                if (minBuf <= 0) continue
                try {
                    val r = AudioRecord(src, rate, AudioFormat.CHANNEL_IN_MONO,
                        AudioFormat.ENCODING_PCM_FLOAT, minBuf * 4)
                    if (r.state == AudioRecord.STATE_INITIALIZED) {
                        rec = r; sourceName = name; sampleRate = rate
                        break@outer
                    }
                    r.release()
                } catch (e: Exception) { /* next combination */ }
            }
        }
        if (rec == null) { scheduleRetry("no usable audio input"); return }

        preferredDevice()?.let { rec.preferredDevice = it }
        if (Build.VERSION.SDK_INT >= 29) {
            rec.registerAudioRecordingCallback({ it.run() }, object : AudioManager.AudioRecordingCallback() {
                override fun onRecordingConfigChanged(configs: MutableList<android.media.AudioRecordingConfiguration>) {
                    // Assistant holds mic priority on TV: we keep recording,
                    // the OS feeds us silence, and we say so on the deck OSD
                    val mine = configs.find { it.clientAudioSessionId == rec.audioSessionId }
                    val s = mine?.isClientSilenced == true
                    if (s != silenced) { silenced = s; emitState() }
                }
            })
        }

        try { rec.startRecording() } catch (e: Exception) {
            rec.release(); scheduleRetry("startRecording failed: ${e.message}"); return
        }
        if (rec.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
            rec.release(); scheduleRetry("input busy"); return
        }

        record = rec
        retryStep = 0
        setState("capturing")
        val fft = Fft(WINDOW, sampleRate)
        val t = Thread({ readLoop(rec, fft) }, "hydra-audio")
        thread = t
        t.start()
    }

    private fun readLoop(rec: AudioRecord, fft: Fft) {
        val buf = FloatArray(HOP)
        val window = FloatArray(WINDOW)
        var lastPush = 0L
        var zeroSince = 0L
        while (record === rec && startRequested) {
            val n = rec.read(buf, 0, HOP, AudioRecord.READ_BLOCKING)
            if (n == AudioRecord.ERROR_DEAD_OBJECT) {
                main.post { if (record === rec) { stopInternal("starting"); scheduleRetry("input died") } }
                return
            }
            if (n <= 0) continue
            System.arraycopy(window, n, window, 0, WINDOW - n)
            System.arraycopy(buf, 0, window, WINDOW - n, n)

            // API 28 has no isClientSilenced: sustained exact-zero input is
            // the best available "possibly silenced" heuristic
            if (Build.VERSION.SDK_INT < 29) {
                val zero = buf.all { abs(it) < 1e-7f }
                val now = System.currentTimeMillis()
                if (zero) {
                    if (zeroSince == 0L) zeroSince = now
                    else if (now - zeroSince > 2000 && !silenced) { silenced = true; main.post { emitState() } }
                } else if (silenced || zeroSince != 0L) {
                    zeroSince = 0
                    if (silenced) { silenced = false; main.post { emitState() } }
                }
            }

            val now = System.currentTimeMillis()
            if (now - lastPush >= PUSH_MS) {
                lastPush = now
                onBins(fft.bands8(window))
            }
        }
    }

    private fun scheduleRetry(error: String) {
        setState("error", error)
        if (!startRequested) return
        val delay = RETRY_MS[retryStep.coerceAtMost(RETRY_MS.size - 1)]
        retryStep++
        val r = Runnable { if (startRequested) tryStart() }
        retryPosted = r
        main.postDelayed(r, delay)
    }

    private fun stopInternal(newState: String) {
        val rec = record
        record = null
        thread = null
        silenced = false
        if (rec != null) {
            try { rec.stop() } catch (e: Exception) { /* not recording */ }
            try { rec.release() } catch (e: Exception) { /* already released */ }
        }
        setState(newState)
    }
}
