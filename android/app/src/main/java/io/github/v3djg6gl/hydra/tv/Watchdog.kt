package io.github.v3djg6gl.hydra.tv

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.os.Handler
import android.os.Looper

/**
 * Keeps the kiosk alive: reloads a wedged page (missed heartbeats), retries
 * failed loads with backoff (short-circuited the moment the network comes
 * back — covers wifi-after-boot), and hands over to the error overlay when
 * reloading clearly isn't helping (storm guard).
 *
 * Pages that predate the heartbeat contract degrade to PASSIVE: only load
 * errors and renderer-process death trigger recovery.
 */
class Watchdog(
    context: Context,
    private val reload: (reason: String) -> Unit,
    private val showError: (detail: String) -> Unit
) {
    companion object {
        private const val TICK_MS = 5000L
        private const val HEARTBEAT_TIMEOUT_MS = 15000L // 3 missed beats
        private const val CAPABILITY_PROBE_MS = 45000L
        private val ERROR_BACKOFF_MS = longArrayOf(2000, 5000, 15000, 30000, 60000, 300000)
        private const val STORM_WINDOW_MS = 10 * 60 * 1000L
        private const val STORM_LIMIT = 3
        private const val STORM_RETRY_MS = 5 * 60 * 1000L
    }

    private enum class State { WAITING_FIRST_HEARTBEAT, ACTIVE, PASSIVE, ERROR }

    private val handler = Handler(Looper.getMainLooper())
    private var state = State.PASSIVE
    private var pageFinishedAt = 0L
    private var lastHeartbeat = 0L
    private var errorStep = 0
    private val reloadTimes = ArrayDeque<Long>()
    private var pendingRetry: Runnable? = null
    private var running = false

    val lastHeartbeatAgeMs: Long
        get() = if (lastHeartbeat == 0L) -1 else System.currentTimeMillis() - lastHeartbeat

    private val ticker = object : Runnable {
        override fun run() {
            if (!running) return
            val now = System.currentTimeMillis()
            when (state) {
                State.WAITING_FIRST_HEARTBEAT ->
                    if (now - pageFinishedAt > CAPABILITY_PROBE_MS) state = State.PASSIVE
                State.ACTIVE ->
                    if (now - lastHeartbeat > HEARTBEAT_TIMEOUT_MS) doReload("heartbeat lost")
                else -> {}
            }
            handler.postDelayed(this, TICK_MS)
        }
    }

    private val connectivity = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager

    init {
        try {
            connectivity.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    // don't wait out a long backoff once the link is up
                    handler.post {
                        if (pendingRetry != null) {
                            handler.removeCallbacks(pendingRetry!!)
                            pendingRetry = null
                            reload("network up")
                        }
                    }
                }
            })
        } catch (e: Exception) { /* callback quota — backoff alone still works */ }
    }

    fun start() {
        if (running) return
        running = true
        handler.postDelayed(ticker, TICK_MS)
    }

    fun stop() {
        running = false
        handler.removeCallbacks(ticker)
        pendingRetry?.let { handler.removeCallbacks(it) }
        pendingRetry = null
    }

    fun notePageFinished() {
        pageFinishedAt = System.currentTimeMillis()
        errorStep = 0
        if (state != State.ACTIVE) state = State.WAITING_FIRST_HEARTBEAT
    }

    fun noteHeartbeat() {
        lastHeartbeat = System.currentTimeMillis()
        if (state != State.ERROR) state = State.ACTIVE
    }

    fun noteLoadError(detail: String) {
        val delay = ERROR_BACKOFF_MS[errorStep.coerceAtMost(ERROR_BACKOFF_MS.size - 1)]
        errorStep++
        showError(detail)
        val r = Runnable { pendingRetry = null; reload("error retry") }
        pendingRetry = r
        handler.postDelayed(r, delay)
    }

    /** Renderer process death and page reload requests also come through here. */
    fun doReload(reason: String) {
        val now = System.currentTimeMillis()
        reloadTimes.addLast(now)
        while (reloadTimes.isNotEmpty() && now - reloadTimes.first() > STORM_WINDOW_MS) reloadTimes.removeFirst()
        if (reloadTimes.size > STORM_LIMIT) {
            state = State.ERROR
            showError("reload storm — $reason (still retrying every 5 min)")
            val r = Runnable { pendingRetry = null; reloadTimes.clear(); reload("storm retry") }
            pendingRetry = r
            handler.postDelayed(r, STORM_RETRY_MS)
            return
        }
        state = State.WAITING_FIRST_HEARTBEAT
        pageFinishedAt = now // fresh probe window
        reload(reason)
    }
}
