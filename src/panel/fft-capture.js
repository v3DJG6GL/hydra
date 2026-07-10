// Deck-side FFT source: when the renderer runs somewhere without a usable
// microphone (a TV, a projector booth), THIS device captures audio and
// streams the processed bins to the host as {op:'fftBins'} intents. The
// pipeline replicates hydra-synth's Audio class exactly — Meyda
// loudness.specific (24 bark bands) → group-sum into N bins → per-bin EMA
// smoothing → max(0, (bin - cutoff) / scale) — so a.setSmooth()/setCutoff()/
// setScale()/setBins() calls on the renderer behave identically no matter
// which device owns the mic (the host forwards them here as {t:'fftCtl'}).
//
// getUserMedia needs a secure context: WAN https or localhost. On plain LAN
// http the MIC button stays disabled with a tooltip (docs/remote-deck.md).
import Meyda from 'meyda'

const SEND_MS = 40 // ~25Hz — matches the native shell's cadence
const WIRE_BINS_MAX = 8

export default class FftCapture {
    constructor(host) {
        this.host = host
        this.enabled = false
        this.numBins = 4
        this.cutoff = 2
        this.scale = 10
        this.smooth = 0.4
        this._prevBins = []
        this._timer = null
        this._stream = null
        this._ctx = null
        this._meyda = null
    }

    supported() {
        return !!(window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
    }

    // host fftCtl forwards land here (and panel rows via the same path)
    applyCtl(fn, value) {
        if (fn === 'setSmooth' && isFinite(+value)) this.smooth = +value
        else if (fn === 'setCutoff' && isFinite(+value)) this.cutoff = +value
        else if (fn === 'setScale' && isFinite(+value)) this.scale = +value
        else if (fn === 'setBins') this.setBins(value)
    }

    setBins(n) {
        const bins = Math.max(1, Math.min(WIRE_BINS_MAX, Math.round(+n) || 4))
        if (bins === this.numBins) return
        this.numBins = bins
        this._prevBins = []
    }

    async start() {
        if (this.enabled) return true
        if (!this.supported()) return false
        try {
            this._stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
        } catch (e) {
            return false
        }
        try {
            this._ctx = new (window.AudioContext || window.webkitAudioContext)()
            if (this._ctx.state === 'suspended') this._ctx.resume().catch(() => {})
            const source = this._ctx.createMediaStreamSource(this._stream)
            this._meyda = Meyda.createMeydaAnalyzer({
                audioContext: this._ctx,
                source,
                featureExtractors: ['loudness']
            })
        } catch (e) {
            this.stop()
            return false
        }
        this.enabled = true
        this._timer = setInterval(() => this._tick(), SEND_MS)
        return true
    }

    stop() {
        this.enabled = false
        clearInterval(this._timer)
        this._timer = null
        if (this._meyda) {
            try { this._meyda.stop() } catch (e) { /* never started */ }
            this._meyda = null
        }
        if (this._ctx) {
            try { this._ctx.close() } catch (e) { /* already closed */ }
            this._ctx = null
        }
        if (this._stream) {
            this._stream.getTracks().forEach((t) => { try { t.stop() } catch (e) { /* dead */ } })
            this._stream = null
        }
        this._prevBins = []
    }

    _tick() {
        if (!this.enabled || !this.host.connected || !this.host.hostPresent) return
        let features = null
        try { features = this._meyda.get() } catch (e) { return }
        if (!features || !features.loudness || !features.loudness.specific) return
        const specific = features.loudness.specific
        const n = this.numBins
        const spacing = Math.floor(specific.length / n)
        if (!spacing) return
        if (this._prevBins.length !== n) this._prevBins = Array(n).fill(0)
        const bins = Array(n).fill(0).map((_, i) => {
            let sum = 0
            for (let j = i * spacing; j < (i + 1) * spacing; j++) sum += specific[j]
            return sum * (1 - this.smooth) + this._prevBins[i] * this.smooth
        })
        this._prevBins = bins
        const fft = bins.map((bin) => +Math.max(0, (bin - this.cutoff) / this.scale).toFixed(3))
        this.host.sendFftBins(fft)
    }
}
