// Single owner of a.fft when the bins come from somewhere other than this
// page's microphone. Three producers feed it:
//   local  — hydra-synth's own getUserMedia/Meyda pipeline (detectAudio)
//   native — an app shell (Android TV) pushing bins via window.__hydraNativeFft
//   deck   — a paired deck streaming bins over the relay ({op:'fftBins'})
// One producer is active at a time: an explicit selection is sticky, 'auto'
// prefers deck > native > local among producers that delivered within
// STALE_MS. While a non-local producer is active the real Audio object's
// tick() is muted so hydra stops overwriting a.fft with mic data; with
// detectAudio off entirely (display mode) a stub Audio is installed at
// hydraSynth.synth.a so a.fft / a0()..aN() / a.setBins() keep working and
// restore-audio.js re-points window.a to it unchanged.
//
// Wire format is ≤8 bins in both directions; the bus re-buckets to whatever
// a.setBins() asked for. Deck bins arrive fully processed (the deck runs the
// same Meyda pipeline, so setSmooth/setCutoff/setScale are forwarded to it —
// see onSettingCall). Native bins arrive as normalized 0..1 magnitudes; the
// bus applies only the smoothing setting to them (cutoff/scale calibrate the
// sones scale of the Meyda path and have no meaning for normalized input).

const WIRE_BINS = 8
const STALE_MS = 2000
const ARBITRATE_MS = 500
const MODE_KEY = 'hydra-vj-fft-source'
const MODES = ['auto', 'deck', 'native', 'local', 'off']

const now = () => Date.now()

class StubAudio {
    constructor() {
        this.vol = 0
        this.cutoff = 2
        this.smooth = 0.4
        this.scale = 10
        this.max = 15
        this.beat = { holdFrames: 20, threshold: 40, _cutoff: 0, decay: 0.98, _framesSinceBeat: 0 }
        this.onBeat = () => {}
        this.setBins(4)
    }

    setBins(numBins) {
        this.bins = Array(numBins).fill(0)
        this.prevBins = Array(numBins).fill(0)
        this.fft = Array(numBins).fill(0)
        this.settings = Array(numBins).fill(0).map(() => ({
            cutoff: this.cutoff, scale: this.scale, smooth: this.smooth
        }))
        // same global helpers the vendor Audio defines — they read the global
        // `a` at call time, so they survive restore-audio re-pointing
        this.bins.forEach((bin, index) => {
            window['a' + index] = (scale = 1, offset = 0) => () => window.a.fft[index] * scale + offset
        })
    }

    setCutoff(cutoff) {
        this.cutoff = cutoff
        this.settings.forEach((el) => { el.cutoff = cutoff })
    }

    setSmooth(smooth) {
        this.smooth = smooth
        this.settings.forEach((el) => { el.smooth = smooth })
    }

    setScale(scale) {
        this.scale = scale
        this.settings.forEach((el) => { el.scale = scale })
    }

    setMax(max) { this.max = max }
    tick() {}
    show() {}
    hide() {}
}

let mode = 'auto'
try {
    const stored = localStorage.getItem(MODE_KEY)
    if (MODES.includes(stored)) mode = stored
} catch (e) { /* private mode */ }

let active = 'off'
let audioObj = null // hydraSynth.synth.a — stub or real
let isStub = false
let timer = null
const prod = {
    deck: { lastAt: 0, bins: null },
    native: { lastAt: 0, bins: null, smoothed: null }
}
const changeCbs = []
const settingCbs = []

const sanitize = (bins) => {
    if (!Array.isArray(bins)) return null
    const out = bins.slice(0, WIRE_BINS).map((v) => {
        const n = +v
        return isFinite(n) ? Math.max(0, n) : 0
    })
    return out.length ? out : null
}

// mean-pool wire bins into however many a.setBins() asked for
const rebucket = (bins, n) => {
    if (bins.length === n) return bins.slice()
    const out = new Array(n)
    for (let i = 0; i < n; i++) {
        const from = Math.floor(i * bins.length / n)
        const to = Math.max(from + 1, Math.floor((i + 1) * bins.length / n))
        let sum = 0
        for (let j = from; j < to; j++) sum += bins[j]
        out[i] = sum / (to - from)
    }
    return out
}

const localAvailable = () => !isStub && !!(audioObj && audioObj.meyda)

const muteLocalTick = (muted) => {
    if (!audioObj || isStub) return
    if (muted && !audioObj.__busRealTick) {
        audioObj.__busRealTick = audioObj.tick
        audioObj.tick = () => {}
    } else if (!muted && audioObj.__busRealTick) {
        audioObj.tick = audioObj.__busRealTick
        delete audioObj.__busRealTick
    }
}

const applyBins = (bins) => {
    if (!audioObj || !bins) return
    // vendor tick() replaces a.fft each frame too — sketches read a.fft[i]
    audioObj.fft = rebucket(bins, audioObj.bins.length)
}

// native bins are normalized magnitudes — apply the smooth setting so
// a.setSmooth() behaves the same regardless of producer
const applyNative = (bins) => {
    if (!audioObj) return
    const smooth = (audioObj.settings && audioObj.settings[0] ? audioObj.settings[0].smooth : 0.4)
    const p = prod.native
    if (!p.smoothed || p.smoothed.length !== bins.length) p.smoothed = bins.slice()
    else p.smoothed = bins.map((v, i) => v * (1 - smooth) + p.smoothed[i] * smooth)
    applyBins(p.smoothed)
}

const fireChange = () => {
    const s = state()
    changeCbs.forEach((cb) => {
        try { cb(s) } catch (e) { console.warn('fft-bus change handler failed', e) }
    })
}

const setActive = (next) => {
    if (next === active) return
    const prev = active
    active = next
    if (prev === 'local' || next === 'local') muteLocalTick(next !== 'local')
    if (prev === 'native' && window.HydraShell && window.HydraShell.audioStop) {
        try { window.HydraShell.audioStop() } catch (e) { /* shell gone */ }
    }
    if (next === 'native' && window.HydraShell && window.HydraShell.audioStart) {
        try { window.HydraShell.audioStart('{}') } catch (e) { /* shell gone */ }
    }
    if (next === 'off' && audioObj) audioObj.fft = audioObj.fft.map(() => 0)
    fireChange()
}

const arbitrate = () => {
    if (!audioObj) return
    const t = now()
    const deckLive = t - prod.deck.lastAt < STALE_MS
    const nativeLive = t - prod.native.lastAt < STALE_MS
    let next
    if (mode === 'off') next = 'off'
    else if (mode !== 'auto') next = mode
    else next = deckLive ? 'deck' : nativeLive ? 'native' : localAvailable() ? 'local' : 'off'
    setActive(next)
    // an explicitly selected producer that stopped delivering shows a frozen
    // meter otherwise — decay to silence so the visuals settle
    if ((active === 'deck' && !deckLive) || (active === 'native' && !nativeLive)) {
        audioObj.fft = audioObj.fft.map((v) => v * 0.85)
    }
}

// the shell may call this before hydra has booted — false tells it to chill
window.__hydraNativeFft = (bins) => {
    const clean = sanitize(bins)
    if (!clean || !audioObj) return false
    prod.native.lastAt = now()
    prod.native.bins = clean
    if (active === 'native') applyNative(clean)
    return active === 'native'
}

function wireSynth() {
    const synth = window.hydraSynth && window.hydraSynth.synth
    if (!synth || audioObj) return
    if (!synth.a) {
        synth.a = new StubAudio()
        isStub = true
    } else {
        // hook the real object's setting methods so deck-forwarding (see
        // onSettingCall) works no matter which path called a.setSmooth()
        isStub = false
    }
    audioObj = synth.a
    ;['setSmooth', 'setCutoff', 'setScale', 'setBins'].forEach((fn) => {
        const orig = audioObj[fn]
        if (typeof orig !== 'function' || orig.__busWrapped) return
        const wrapped = (value) => {
            const r = orig.call(audioObj, value)
            settingCbs.forEach((cb) => {
                try { cb(fn, value) } catch (e) { /* handler failed */ }
            })
            return r
        }
        wrapped.__busWrapped = true
        audioObj[fn] = wrapped
    })
    if (window.a !== synth.a) window.a = synth.a
    if (!timer) timer = setInterval(arbitrate, ARBITRATE_MS)
    arbitrate()
}

// ---- public surface (a plain singleton — both the renderer stores and the
// display page import this same instance)

export function attachFftBus(emitter) {
    if (emitter) emitter.on('hydra loaded', wireSynth)
    if (window.hydraSynth) wireSynth()
}

export function setMode(m) {
    if (!MODES.includes(m) || m === mode) return
    mode = m
    try {
        if (m === 'auto') localStorage.removeItem(MODE_KEY)
        else localStorage.setItem(MODE_KEY, m)
    } catch (e) { /* private mode */ }
    arbitrate()
    fireChange() // mode changed even if active didn't
}

export function pushDeckBins(bins) {
    const clean = sanitize(bins)
    if (!clean) return
    prod.deck.lastAt = now()
    prod.deck.bins = clean
    if (audioObj && active !== 'deck') arbitrate() // wake auto promptly
    if (active === 'deck') applyBins(clean)
}

export function state() {
    return {
        mode,
        active,
        bins: audioObj ? audioObj.bins.length : 4
    }
}

export function onChange(cb) { changeCbs.push(cb) }

// fires whenever a.setSmooth/setCutoff/setScale/setBins runs on the renderer
// (sketch code, deck audio-settings rows, anything) — remote-store forwards
// these to the streaming deck so its Meyda pipeline stays in sync
export function onSettingCall(cb) { settingCbs.push(cb) }
