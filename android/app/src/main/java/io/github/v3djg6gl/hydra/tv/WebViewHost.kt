package io.github.v3djg6gl.hydra.tv

import android.annotation.SuppressLint
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.view.ViewGroup
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient

/**
 * Owns the WebView: creation, configuration, and — critically — the rebuild
 * path. Since Android 8 the renderer runs out of process; when it is OOM-
 * killed (2 GB TV boxes!) onRenderProcessGone MUST return true and replace
 * the WebView, or the whole app dies with it. Always built programmatically
 * so a rebuild is symmetric with first construction.
 */
class WebViewHost(
    private val activity: MainActivity,
    private val bridge: ShellBridge,
    private val container: ViewGroup
) {
    var webView: WebView? = null
        private set
    private var rendererDeaths = ArrayDeque<Long>()

    fun currentOrigin(): Triple<String, String, Int>? {
        val uri = Uri.parse(Prefs(activity).serverUrl)
        val scheme = uri.scheme ?: return null
        val host = uri.host ?: return null
        val port = if (uri.port > 0) uri.port else if (scheme == "https") 443 else 80
        return Triple(scheme, host, port)
    }

    private fun sameOrigin(url: String): Boolean {
        val cfg = currentOrigin() ?: return false
        val uri = Uri.parse(url)
        val port = if (uri.port > 0) uri.port else if (uri.scheme == "https") 443 else 80
        return uri.scheme == cfg.first && uri.host == cfg.second && port == cfg.third
    }

    @SuppressLint("SetJavaScriptEnabled")
    fun build(): WebView {
        destroy()
        WebView.setWebContentsDebuggingEnabled(true) // chrome://inspect from a dev machine
        val wv = WebView(activity)
        wv.setBackgroundColor(Color.BLACK)
        // NEVER setLayerType(LAYER_TYPE_SOFTWARE, …) here or on any ancestor —
        // software canvases have no WebGL and hydra dies
        with(wv.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true // pairing credential lives in localStorage
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            setSupportMultipleWindows(false)
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        }
        wv.addJavascriptInterface(bridge, "HydraShell")
        bridge.webView = wv
        wv.isFocusable = true
        wv.isFocusableInTouchMode = true

        wv.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                // page-side getUserMedia (only reachable on https origins):
                // grant capture to OUR origin when the app itself holds the
                // Android permission, deny everything else
                val fromOurOrigin = sameOrigin(request.origin.toString())
                val grantable = request.resources.filter {
                    it == PermissionRequest.RESOURCE_AUDIO_CAPTURE && fromOurOrigin &&
                        activity.audioCapture.hasPermission()
                }
                activity.runOnUiThread {
                    if (grantable.isNotEmpty()) request.grant(grantable.toTypedArray())
                    else request.deny()
                }
            }

            override fun onConsoleMessage(msg: android.webkit.ConsoleMessage): Boolean {
                bridge.log("console", "${msg.message()} (${msg.sourceId()}:${msg.lineNumber()})")
                return true
            }
        }

        wv.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                // a kiosk never browses away — swallow everything off-origin
                return !sameOrigin(request.url.toString())
            }

            override fun onPageFinished(view: WebView, url: String) {
                activity.onPageFinished()
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (!request.isForMainFrame) return
                activity.onPageError("${error.errorCode}: ${error.description}")
            }

            override fun onReceivedHttpError(view: WebView, request: WebResourceRequest,
                                             response: android.webkit.WebResourceResponse) {
                if (!request.isForMainFrame) return
                activity.onPageError("HTTP ${response.statusCode}")
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                // also fires when Play updates the WebView package mid-run:
                // old renderers are killed, the app process survives, and we
                // rebuild on the new package
                val now = System.currentTimeMillis()
                rendererDeaths.addLast(now)
                while (rendererDeaths.isNotEmpty() && now - rendererDeaths.first() > 5 * 60 * 1000) {
                    rendererDeaths.removeFirst()
                }
                bridge.log("shell", "renderer process gone (crash=${detail.didCrash()})")
                container.post {
                    if (rendererDeaths.size > 3) {
                        destroy()
                        activity.onPageError("WebView renderer keeps dying")
                    } else {
                        activity.rebuildWebView("renderer gone")
                    }
                }
                return true // false would kill the whole app
            }
        }

        container.addView(wv, 0, ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        webView = wv
        return wv
    }

    fun load(url: String) {
        (webView ?: build()).loadUrl(url)
    }

    fun destroy() {
        val wv = webView ?: return
        webView = null
        bridge.webView = null
        try {
            container.removeView(wv)
            wv.stopLoading()
            wv.destroy()
        } catch (e: Exception) { /* already torn down */ }
    }

    fun onPause() { webView?.onPause() }
    fun onResume() { webView?.onResume() }
}
