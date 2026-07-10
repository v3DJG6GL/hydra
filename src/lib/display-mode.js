// Display mode: ?display=1 turns the renderer page into a bare output device
// (TV / projector kiosk). The editor still boots — remote control reads its
// buffer — but the overlay starts hidden, hydra runs without its own mic
// (a.fft comes from the fft-bus: a deck stream or the app shell's native
// capture), and the internal render resolution is a deck-controllable tier
// instead of blindly following the window size.
//
// The page detects an Android shell by the presence of window.HydraShell
// (see android/, ShellBridge.kt) and feeds it a 5s heartbeat so the shell's
// watchdog can reload a wedged page. Shell events arrive on
// window.__hydraShellEvent; native FFT bins on window.__hydraNativeFft
// (owned by fft-bus.js).
import * as bus from './fft-bus.js'

const TIER_KEY = 'hydra-vj-display-tier'
export const TIERS = ['540', '720', '1080', 'native']
const HEARTBEAT_MS = 5000

let _isDisplay = null
export function isDisplay() {
    if (_isDisplay === null) {
        try {
            _isDisplay = new URLSearchParams(window.location.search).get('display') === '1'
        } catch (e) { _isDisplay = false }
    }
    return _isDisplay
}

let tier = '720'
try {
    const stored = localStorage.getItem(TIER_KEY)
    if (TIERS.includes(stored)) tier = stored
} catch (e) { /* private mode */ }

export function currentTier() { return tier }

// internal render size for a tier: fixed height, width follows the window's
// aspect; CSS stretches the canvas full-screen (image-rendering: pixelated).
// 'native' is the only tier that honors devicePixelRatio — the stock page
// never did, so everything else is a plain CSS-pixel budget.
const tierSize = (t) => {
    const aspect = window.innerWidth / Math.max(1, window.innerHeight)
    const h = t === 'native'
        ? Math.round(window.innerHeight * (window.devicePixelRatio || 1))
        : parseInt(t, 10)
    return { w: Math.max(2, Math.round(h * aspect)), h }
}

export function applyTier(t) {
    if (!TIERS.includes(t)) return false
    tier = t
    try { localStorage.setItem(TIER_KEY, t) } catch (e) { /* private mode */ }
    const hydra = window.hydraSynth
    if (hydra && typeof hydra.setResolution === 'function') {
        const { w, h } = tierSize(t)
        try { hydra.setResolution(w, h) } catch (e) { console.warn('setResolution failed', e) }
    }
    return true
}

// ---- diagnostics for the deck OSD ({op:'diag'} subscription)

let fpsFrames = 0
let fpsAt = 0
let fps = 0
const sampleFps = () => {
    fpsFrames++
    const t = performance.now()
    if (t - fpsAt >= 1000) {
        fps = Math.round(fpsFrames * 1000 / (t - fpsAt))
        fpsFrames = 0
        fpsAt = t
    }
    requestAnimationFrame(sampleFps)
}

let glRenderer = null
const webglRenderer = () => {
    if (glRenderer !== null) return glRenderer
    try {
        const canvas = document.getElementById('hydra-canvas')
        const gl = canvas && (canvas.getContext('webgl') || canvas.getContext('experimental-webgl'))
        if (!gl) return (glRenderer = '')
        const info = gl.getExtension('WEBGL_debug_renderer_info')
        glRenderer = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER))
    } catch (e) { glRenderer = '' }
    return glRenderer
}

export function collectDiag() {
    const hydra = window.hydraSynth
    const synthFps = hydra && hydra.synth && hydra.synth.stats ? hydra.synth.stats.fps : 0
    const canvas = document.getElementById('hydra-canvas')
    return {
        t: 'diag',
        ua: navigator.userAgent,
        webglRenderer: webglRenderer(),
        fps: Number.isFinite(synthFps) && synthFps > 0 && synthFps < 1000 ? synthFps : fps,
        tier,
        res: canvas ? { w: canvas.width, h: canvas.height } : null,
        dpr: window.devicePixelRatio || 1,
        display: isDisplay(),
        fftActive: bus.state().active,
        shell: !!window.HydraShell,
        ts: Date.now()
    }
}

// ---- "replaced" overlay: on a TV, silently going dark when another
// renderer takes the room is indistinguishable from a crash. Show what
// happened and let the remote's OK key reclaim (a reload re-hellos as the
// newest host and wins the room back).

export function showReplacedOverlay() {
    if (document.getElementById('vj-display-replaced')) return
    const wrap = document.createElement('div')
    wrap.id = 'vj-display-replaced'
    wrap.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.88);' +
        'display:flex;flex-direction:column;align-items:center;justify-content:center;' +
        'font-family:monospace;color:#dffff9;text-align:center;padding:5vh 5vw;'
    const title = document.createElement('div')
    title.textContent = 'ANOTHER RENDERER TOOK OVER THIS ROOM'
    title.style.cssText = 'font-size:3.2vmin;letter-spacing:.2em;margin-bottom:2vh;'
    const hint = document.createElement('div')
    hint.textContent = 'press OK / ENTER to reclaim the visuals on this screen'
    hint.style.cssText = 'font-size:2.2vmin;opacity:.7;'
    wrap.append(title, hint)
    document.body.appendChild(wrap)
    // survive choo's <body> morphing (it removes foreign nodes on render)
    const remount = setInterval(() => {
        if (!wrap.isConnected) document.body.appendChild(wrap)
    }, 400)
    const onKey = (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            clearInterval(remount)
            document.removeEventListener('keydown', onKey)
            window.location.reload()
        }
    }
    document.addEventListener('keydown', onKey)
}

// ---- choo store: wires the display behaviors into the page lifecycle.
// A no-op unless ?display=1, so index.js registers it unconditionally.

export default function displayStore(state, emitter) {
    // the shell event hook exists regardless of mode — a misconfigured shell
    // URL without ?display=1 should still not throw in the bridge
    window.__hydraShellEvent = (ev) => {
        if (!ev || typeof ev !== 'object') return
        if (ev.type === 'audioState') {
            state.shellAudio = ev
            emitter.emit('vj-shell: audio-state', ev)
        }
        // 'visible' and 'reloadScheduled' are informational — nothing to do
    }

    if (!isDisplay()) return

    state.showCode = false
    requestAnimationFrame(sampleFps)

    emitter.on('hydra loaded', () => {
        applyTier(tier)
        webglRenderer() // probe once while the context is fresh
    })

    // HDMI mode changes / projector re-negotiation: keep the tier's aspect
    let resizeTimer = null
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer)
        resizeTimer = setTimeout(() => applyTier(tier), 300)
    })

    // shell watchdog heartbeat — harmless without a shell
    setInterval(() => {
        if (window.HydraShell && window.HydraShell.heartbeat) {
            try {
                window.HydraShell.heartbeat(JSON.stringify({ fps: collectDiag().fps, rendering: fps > 0 }))
            } catch (e) { /* shell gone */ }
        }
    }, HEARTBEAT_MS)
}
