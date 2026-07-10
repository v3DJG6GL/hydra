// The remote host adapter: the deck runs the full VJPanel on another device
// and every call that host-local.js would make into the shared JS context
// becomes an intent over the relay websocket instead. The renderer's tab
// stays the single source of truth — this adapter keeps a mirror of its
// state (code text, history size, scenes, transforms, globals) fed by
// snapshot + delta broadcasts, and the panel re-renders from that mirror.
//
// intents (this -> host bridge, src/stores/remote-store.js):
//   {op:'edit', edit:{from,to,text}, quiet, replaceURL, baseHash, reqId}
//   {op:'history', dir} {op:'random', kind, changeTransform} {op:'run', code}
//   {op:'scene*', ...} {op:'global'|'audio'|'toggleCode'|'fft', ...}
//   {op:'liveEnsure', path, value, reqId} {op:'liveSet', path, value}
//   {op:'evalExpr', src, reqId} {op:'reqSnapshot'}
//   {op:'previewStart', w} {op:'previewSize', w} {op:'previewStop'}
//   {op:'frames', on} {op:'rtc', kind, …}
// broadcasts (host bridge -> this):
//   snapshot, codeChanged{cause}, scenes, ui, flash, fftFrame, evalResult,
//   reverted, ack, exprResult, hostState
import { codeHash } from './wire.js'

const LIVE_SEND_MS = 33 // coalesce fader streams to ~30Hz per path
const BACKOFF_MIN = 500
const BACKOFF_MAX = 8000
// two independent STUN providers — venue networks sometimes block one
const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' }
]

export default class RemoteHost {
    constructor(opts) {
        this.remote = true
        this.url = opts.url
        this.room = opts.room
        this.token = opts.token
        this.panel = null
        this._subs = {}

        this.connected = false
        this.hostPresent = false
        this.id = null
        this.seq = -1
        this.snapshotReceived = false

        this.code = ''
        this.hist = { undo: 0, redo: 0 }
        this.scenes = new Array(8).fill(null)
        this.transforms = null
        this.globals = { speed: 1, bpm: 30 }
        this.showCode = true

        this.lb = new RemoteLiveBind(this)
        this._reqId = 1
        this._pending = new Map() // reqId -> {cb, timer}
        this._fftCbs = []
        this._liveQueue = new Map() // path -> value
        this._liveTimer = null
        this._backoff = BACKOFF_MIN
        this._closed = false
        try { this._statsOn = localStorage.getItem('hydra-vj-preview-diag') === '1' } catch (e) { this._statsOn = false }
        this._connect()
    }

    bind(panel) {
        this.panel = panel
    }

    on(evt, fn) {
        (this._subs[evt] = this._subs[evt] || []).push(fn)
    }

    _fire(evt, ...args) {
        (this._subs[evt] || []).forEach((fn) => {
            try { fn(...args) } catch (e) { console.warn('vj remote handler failed', e) }
        })
    }

    // ----------------------------------------------------------- transport

    _connect() {
        if (this._closed) return
        let ws
        try {
            ws = new WebSocket(this.url)
        } catch (e) {
            this._retry()
            return
        }
        this.ws = ws
        ws.onopen = () => {
            ws.send(JSON.stringify({ t: 'hello', role: 'deck', room: this.room, token: this.token }))
        }
        ws.onmessage = (e) => {
            let msg
            try { msg = JSON.parse(e.data) } catch (err) { return }
            this._onMessage(msg)
        }
        ws.onclose = () => {
            const was = this.connected
            this.connected = false
            this.lb.invalidate()
            if (was) this._fire('status')
            this._retry()
        }
        ws.onerror = () => { /* close follows */ }
    }

    _retry() {
        if (this._closed) return
        const delay = this._backoff + Math.random() * 250
        this._backoff = Math.min(this._backoff * 2, BACKOFF_MAX)
        setTimeout(() => this._connect(), delay)
    }

    close() {
        this._closed = true
        if (this._statsTimer) {
            clearInterval(this._statsTimer)
            this._statsTimer = null
        }
        if (this.ws) try { this.ws.close() } catch (e) { /* already dead */ }
    }

    _send(msg) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ t: 'intent', msg }))
            return true
        }
        return false
    }

    _request(msg, cb, timeoutMs = 3000) {
        const reqId = this._reqId++
        const timer = setTimeout(() => {
            this._pending.delete(reqId)
            cb(null)
        }, timeoutMs)
        this._pending.set(reqId, { cb, timer })
        if (!this._send({ ...msg, reqId })) {
            clearTimeout(timer)
            this._pending.delete(reqId)
            cb(null)
        }
        return reqId
    }

    _resolve(reqId, value) {
        const p = this._pending.get(reqId)
        if (!p) return
        this._pending.delete(reqId)
        clearTimeout(p.timer)
        p.cb(value)
    }

    _onMessage(msg) {
        switch (msg.t) {
            case 'error':
                this._fire('fatal', msg.code)
                if (msg.code === 'unauthorized' || msg.code === 'bad-token' || msg.code === 'bad-room') this._closed = true
                return
            case 'welcome':
                this.id = msg.id
                this.connected = true
                this.hostPresent = !!msg.hostPresent
                this._backoff = BACKOFF_MIN
                this._fire('status')
                // the host pushes a snapshot on deckJoined; ask anyway in case
                // it raced our welcome
                this._send({ op: 'reqSnapshot' })
                return
            case 'hostState':
                this.hostPresent = !!msg.present
                if (msg.present) this._send({ op: 'reqSnapshot' })
                this._fire('status')
                return
            case 'snapshot':
                this.seq = msg.seq
                this.code = msg.code
                this.hist = msg.historySize || { undo: 0, redo: 0 }
                this.scenes = msg.scenes || this.scenes
                this.transforms = msg.transforms || this.transforms
                this.globals = { ...this.globals, ...(msg.globals || {}) }
                this.showCode = msg.showCode !== false
                this.lb.clean = !!msg.lbClean && this.lb.clean
                this._canPreview = !!msg.canPreview
                this.snapshotReceived = true
                if (this._previewOn) this._kickPreview() // resumed after a reconnect
                this._fire('code-changed', 'snapshot')
                this._fire('scenes-changed')
                this._fire('ui-changed')
                return
            case 'codeChanged':
                if (msg.seq !== undefined && this.seq >= 0 && msg.seq !== this.seq + 1) {
                    this._send({ op: 'reqSnapshot' }) // missed something
                }
                if (msg.seq !== undefined) this.seq = msg.seq
                this.code = msg.code
                this.hist = msg.historySize || this.hist
                if (msg.globals) this.globals = { ...this.globals, ...msg.globals }
                if (msg.lbClean === false) this.lb.clean = false
                this._fire('code-changed', msg.cause)
                return
            case 'scenes':
                if (msg.seq !== undefined) this.seq = msg.seq
                this.scenes = msg.scenes
                this._fire('scenes-changed')
                return
            case 'ui':
                if (msg.seq !== undefined) this.seq = msg.seq
                if (msg.showCode !== undefined) this.showCode = msg.showCode
                this._fire('ui-changed')
                return
            case 'flash':
                // another controller (or host MIDI) moved a param
                if (msg.src !== this.id && this.panel) this.panel.flashParamValue(msg.path, msg.value)
                return
            case 'lb':
                // a host-side eval replaced the running program — quiet
                // commits must go back to full evals until re-ensured
                if (!msg.clean) this.lb.invalidate()
                return
            case 'rtc':
                this._onRtc(msg)
                return
            case 'frame':
                // only while subscribed — a frame still in flight after the
                // RTC upgrade must not flip the pane back to a frozen still
                if (this._previewImg && this._framesMode) {
                    this._previewImg.src = msg.data
                    this._setPreviewMode('frames')
                    // data-URL chars ≈ wire bytes — feeds the OSD readout
                    const now = performance.now()
                    const log = this._frameLog || (this._frameLog = [])
                    log.push({ t: now, b: msg.data.length })
                    while (log.length && now - log[0].t > 5000) log.shift()
                }
                return
            case 'fftFrame':
                this._fftCbs = this._fftCbs.filter((cb) => cb(msg.bins) !== false)
                return
            case 'ack':
                this._resolve(msg.reqId, msg)
                return
            case 'exprResult':
                this._resolve(msg.reqId, msg)
                return
            case 'evalResult':
                if (msg.reqId !== undefined) this._resolve(msg.reqId, msg)
                if (!msg.ok) this._fire('toast', msg.error || 'edit rejected by the renderer', 'error')
                return
            case 'reverted':
                this._fire('toast', 'change auto-reverted (runtime error on the renderer)', 'error')
                return
            default:
                this._fire('message', msg)
        }
    }

    // --------------------------------------------- host adapter interface

    hasBuffer() {
        return this.snapshotReceived
    }

    getCode() {
        return this.code
    }

    historySize() {
        return this.hist
    }

    historyStep(dir) {
        this._send({ op: 'history', dir })
    }

    applyEdit(edit, opts) {
        this._request({
            op: 'edit',
            edit,
            quiet: false,
            replaceURL: !!(opts && opts.replaceURL),
            baseHash: codeHash(this.code)
        }, () => { /* failure surfaces via evalResult toast */ })
        return true // optimistic; authoritative text follows as codeChanged
    }

    applyQuietEdit(edit) {
        this._request({
            op: 'edit',
            edit,
            quiet: true,
            baseHash: codeHash(this.code)
        }, () => {})
        return true
    }

    runRandom(kind, changeTransform) {
        this._send({ op: 'random', kind, changeTransform: !!changeTransform })
    }

    jumpToRange() {
        this._fire('toast', 'expressions are edited in the code on the renderer screen', 'info')
    }

    run(code) {
        this._send({ op: 'run', code })
    }

    evalExpr(src, cb) {
        this._request({ op: 'evalExpr', src }, (res) => {
            cb(res && typeof res.value === 'number' && isFinite(res.value) ? res.value : null)
        })
    }

    getTransforms() {
        return this.transforms || {}
    }

    audioCall(fn, value) {
        this._send({ op: 'audio', fn, value })
    }

    audioShow() {
        return false // remote decks use the streamed meter instead
    }

    setFftStream(on) {
        this._send({ op: 'fft', on: !!on })
    }

    onFftFrame(cb) {
        this._fftCbs.push(cb)
    }

    // ------------------------------------------------------------ preview
    // Relayed frames start immediately — they traverse anything the
    // control channel traverses, so the preview works wherever the deck
    // works (WAN included). WebRTC negotiates in parallel (signaled through
    // the relay; STUN only, no TURN) and the video takes over the moment
    // P2P media actually flows; frames resume if it ever dies.

    captureStream() {
        return null // the panel uses canPreview()/previewElement() remotely
    }

    canPreview() {
        return this.snapshotReceived && !!this._canPreview
    }

    setPreview(on) {
        if (!!on === !!this._previewOn) return
        this._previewOn = !!on
        if (on) {
            this._kickPreview()
        } else {
            this._send({ op: 'previewStop' })
            this._framesOff()
            this._closePc()
            if (this._previewVideo) this._previewVideo.srcObject = null
        }
        this._syncStats()
    }

    _kickPreview() {
        // a reconnect handed us a fresh relay id, so the host's frame
        // subscription for the old id is gone — always resubscribe
        this._framesMode = false
        this._framesOn()
        this._send({ op: 'previewStart', w: this._previewPx() })
    }

    // how large the preview actually renders, in device px — the host never
    // encodes more than this (or its configured ceiling)
    _previewPx() {
        const doc = this._previewWrap ? this._previewWrap.ownerDocument : document
        const win = doc.defaultView || window
        const cssW = this._previewWrap ? this._previewWrap.getBoundingClientRect().width : 0
        const h = this._prevH || Math.min(220, win.innerHeight * 0.35)
        // object-fit: contain — the visible image is width- or height-bound
        const shown = Math.min(cssW || win.innerWidth, h * 16 / 9)
        return Math.round(Math.min(1920, Math.max(240, shown * (win.devicePixelRatio || 1))))
    }

    previewElement(doc) {
        if (!this._previewOn) return null
        if (!this._previewWrap || this._previewWrap.ownerDocument !== doc) {
            const wrap = doc.createElement('div')
            wrap.className = 'vj-preview'
            const video = doc.createElement('video')
            video.muted = true
            video.autoplay = true
            video.playsInline = true
            const img = doc.createElement('img')
            img.className = 'vj-preview-frames'
            img.alt = ''
            img.style.display = 'none'
            wrap.appendChild(video)
            wrap.appendChild(img)
            const stats = doc.createElement('div')
            stats.className = 'vj-preview-stats'
            stats.style.display = 'none'
            wrap.appendChild(stats)
            wrap.appendChild(this._buildPreviewGrip(doc))
            this._previewWrap = wrap
            this._previewVideo = video
            this._previewImg = img
            this._statsEl = stats
            try {
                const stored = parseInt(localStorage.getItem('hydra-vj-preview-h'), 10)
                if (Number.isFinite(stored)) this._prevH = stored
            } catch (e) { /* private mode */ }
            if (this._prevH) wrap.style.setProperty('--vj-prev-h', this._prevH + 'px')
            if (this._rtcStream) video.srcObject = this._rtcStream
            this._setPreviewMode(this._mode || 'frames')
        }
        const p = this._previewVideo.play()
        if (p && p.catch) p.catch(() => { /* resumes on autoplay */ })
        this._syncStats()
        return this._previewWrap
    }

    // ---- preview resizing: drag the grip for a free height, tap the size
    // button to cycle presets, double-tap the grip to reset. The height is
    // per-device (localStorage) and the host is told the resulting pixel
    // size so big panes get sharper streams (within its budget)

    _buildPreviewGrip(doc) {
        const win = doc.defaultView
        const grip = doc.createElement('div')
        grip.className = 'vj-preview-grip'
        grip.title = 'drag to resize the preview — double-tap to reset'
        grip.appendChild(doc.createElement('i'))
        const size = doc.createElement('button')
        size.className = 'vj-preview-size'
        size.textContent = '⤢'
        size.title = 'cycle preview size'
        size.onclick = (e) => {
            e.stopPropagation()
            const presets = [140, 220, 340, Math.round(win.innerHeight * 0.6)]
            const cur = this._prevH || Math.min(220, win.innerHeight * 0.35)
            const next = presets.find((p) => p > cur + 10) || presets[0]
            this._setPreviewH(next, true)
        }
        grip.appendChild(size)
        const diag = doc.createElement('button')
        diag.className = 'vj-preview-diag' + (this._statsOn ? ' vj-on' : '')
        diag.textContent = 'OSD'
        diag.title = 'toggle stream diagnostics'
        diag.onclick = (e) => {
            e.stopPropagation()
            this._toggleStats()
        }
        grip.appendChild(diag)
        this._diagBtn = diag
        grip.onpointerdown = (e) => {
            if (e.target === size || e.target === diag) return
            e.preventDefault()
            try { grip.setPointerCapture(e.pointerId) } catch (err) { /* stale pointer */ }
            const startY = e.clientY
            const startH = this._prevH || Math.min(220, win.innerHeight * 0.35)
            const move = (ev) => this._setPreviewH(startH + (ev.clientY - startY), false)
            const done = (ev) => {
                grip.removeEventListener('pointermove', move)
                grip.removeEventListener('pointerup', done)
                grip.removeEventListener('pointercancel', done)
                this._setPreviewH(startH + (ev.clientY - startY), true)
            }
            grip.addEventListener('pointermove', move)
            grip.addEventListener('pointerup', done)
            grip.addEventListener('pointercancel', done)
        }
        grip.ondblclick = () => this._setPreviewH(null, true)
        grip.oncontextmenu = (e) => e.preventDefault() // long-press is a drag here
        return grip
    }

    _setPreviewH(px, commit) {
        const doc = this._previewWrap ? this._previewWrap.ownerDocument : document
        const win = doc.defaultView || window
        this._prevH = px === null ? null
            : Math.round(Math.min(win.innerHeight * 0.7, Math.max(90, px)))
        if (this._previewWrap) {
            if (this._prevH) this._previewWrap.style.setProperty('--vj-prev-h', this._prevH + 'px')
            else this._previewWrap.style.removeProperty('--vj-prev-h')
        }
        if (!commit) return
        try {
            if (this._prevH) localStorage.setItem('hydra-vj-preview-h', String(this._prevH))
            else localStorage.removeItem('hydra-vj-preview-h')
        } catch (e) { /* private mode */ }
        if (this._previewOn) this._send({ op: 'previewSize', w: this._previewPx() })
    }

    _setPreviewMode(mode) {
        this._mode = mode
        if (!this._previewVideo) return
        this._previewVideo.style.display = mode === 'rtc' ? '' : 'none'
        this._previewImg.style.display = mode === 'frames' ? '' : 'none'
    }

    // ---- stream diagnostics: the OSD button on the grip toggles a
    // signal-status readout in the pane's corner — active path, measured
    // resolution / fps / bandwidth, LAN|WAN mode and the P2P link state.
    // Bandwidth is shown in the units of the matching HYDRA_PREVIEW_*
    // budget (kb/s for WebRTC, KB/s for frames) so it doubles as the
    // tuning readout. The toggle is per-device (localStorage).

    _toggleStats() {
        this._statsOn = !this._statsOn
        try {
            if (this._statsOn) localStorage.setItem('hydra-vj-preview-diag', '1')
            else localStorage.removeItem('hydra-vj-preview-diag')
        } catch (e) { /* private mode */ }
        this._syncStats()
    }

    _syncStats() {
        if (this._diagBtn) this._diagBtn.classList.toggle('vj-on', !!this._statsOn)
        const on = !!(this._statsOn && this._previewOn && this._statsEl)
        if (this._statsEl) this._statsEl.style.display = on ? '' : 'none'
        if (on && !this._statsTimer) {
            this._statsTimer = setInterval(() => this._updateStats(), 1000)
            this._updateStats()
        } else if (!on && this._statsTimer) {
            clearInterval(this._statsTimer)
            this._statsTimer = null
            this._rtcPrev = null
        }
    }

    _updateStats() {
        const el = this._statsEl
        if (!el) return
        const linkLine = () => {
            const net = window.location.protocol === 'https:' ? 'WAN' : 'LAN'
            const pc = this._pc
            const p2p = this._rtcLive ? 'live'
                : !window.RTCPeerConnection ? 'n/a'
                    : !pc ? '—'
                        : ({
                            new: 'checking',
                            checking: 'checking',
                            connected: 'connected',
                            completed: 'connected',
                            disconnected: 'lost'
                        })[pc.iceConnectionState] || pc.iceConnectionState
            return net + ' · p2p ' + p2p + ' · pane ' + this._previewPx() + 'px'
        }
        if (this._mode === 'rtc' && this._pc) {
            const pc = this._pc
            pc.getStats().then((stats) => {
                if (this._statsEl !== el || this._pc !== pc || !this._statsTimer) return
                let inb = null
                stats.forEach((s) => { if (s.type === 'inbound-rtp' && s.kind === 'video') inb = s })
                const c = inb && inb.codecId ? stats.get(inb.codecId) : null
                const codec = c && c.mimeType ? c.mimeType.split('/').pop().toUpperCase() : ''
                const now = performance.now()
                const prev = this._rtcPrev
                let fps = '… fps'
                let kbps = '… kb/s'
                if (inb && prev && now > prev.t) {
                    kbps = Math.max(0, Math.round((inb.bytesReceived - prev.bytes) * 8 / (now - prev.t))) + ' kb/s'
                    fps = Math.max(0, Math.round((inb.framesDecoded - prev.frames) * 1000 / (now - prev.t))) + ' fps'
                }
                if (inb) this._rtcPrev = { t: now, bytes: inb.bytesReceived || 0, frames: inb.framesDecoded || 0 }
                const res = inb && inb.frameWidth ? inb.frameWidth + '×' + inb.frameHeight : '…'
                this._renderStats(el, 'rtc', '● WEBRTC P2P' + (codec ? ' · ' + codec : ''),
                    res + ' · ' + fps + ' · ' + kbps, linkLine())
            }).catch(() => { /* pc died mid-poll */ })
        } else {
            this._rtcPrev = null
            const now = performance.now()
            const log = this._frameLog || []
            while (log.length && now - log[0].t > 5000) log.shift()
            const span = log.length ? Math.max(1000, now - log[0].t) : 0
            const fps = span ? Math.round(log.length * 10000 / span) / 10 : 0
            const kBs = span ? Math.round(log.reduce((s, f) => s + f.b, 0) / span) : 0
            const img = this._previewImg
            const res = img && img.naturalWidth ? img.naturalWidth + '×' + img.naturalHeight : '…'
            const fmt = img && img.src.startsWith('data:image/')
                ? img.src.slice(11, img.src.indexOf(';')).toUpperCase() : ''
            this._renderStats(el, 'frames', '● FRAMES' + (fmt ? ' · ' + fmt : ''),
                res + ' · ' + fps + ' fps · ' + kBs + ' KB/s', linkLine())
        }
    }

    _renderStats(el, path, l1, l2, l3) {
        const d = el.ownerDocument
        while (el.children.length < 3) el.appendChild(d.createElement('div'))
        el.children[0].className = 'vj-osd-path ' + (path === 'rtc' ? 'vj-osd-rtc' : 'vj-osd-frames')
        el.children[0].textContent = l1
        el.children[1].textContent = l2
        el.children[2].className = 'vj-osd-dim'
        el.children[2].textContent = l3
    }

    _onRtc(msg) {
        if (msg.kind === 'offer') {
            this._closePc()
            let pc
            try {
                pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
            } catch (e) {
                return // frames are already running
            }
            this._pc = pc
            pc.ontrack = (e) => {
                this._rtcStream = e.streams[0] || new MediaStream([e.track])
                if (this._previewVideo) {
                    this._previewVideo.srcObject = this._rtcStream
                    const p = this._previewVideo.play()
                    if (p && p.catch) p.catch(() => {})
                }
                // ontrack only means the offer lists a track — behind
                // symmetric NAT the media never arrives. Receiver tracks
                // unmute on the first RTP packet: that is the moment the
                // video can take over from the frames.
                const live = () => {
                    this._rtcLive = true
                    this._upgradeToRtc(pc)
                }
                if (e.track.muted === false) live()
                else e.track.onunmute = live
            }
            pc.onicecandidate = (e) => {
                if (e.candidate) this._send({ op: 'rtc', kind: 'candidate', candidate: e.candidate })
            }
            pc.oniceconnectionstatechange = () => {
                if (this._pc !== pc) return
                const s = pc.iceConnectionState
                if (['failed', 'disconnected', 'closed'].includes(s)) {
                    if (this._previewOn) this._framesOn() // P2P died — frames resume
                } else if (s === 'connected' || s === 'completed') {
                    this._upgradeToRtc(pc) // back from a transient 'disconnected'
                }
            }
            pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp })
                .then(() => {
                    this._flushCandidates(pc)
                    return pc.createAnswer()
                })
                .then((a) => pc.setLocalDescription(a))
                .then(() => this._send({ op: 'rtc', kind: 'answer', sdp: pc.localDescription.sdp }))
                .catch(() => { /* frames are already running */ })
        } else if (msg.kind === 'candidate' && this._pc) {
            const pc = this._pc
            // trickle candidates can outrun setRemoteDescription — queue them
            if (pc.remoteDescription) pc.addIceCandidate(msg.candidate).catch(() => { /* stale */ })
            else (pc.__pending = pc.__pending || []).push(msg.candidate)
        }
    }

    _flushCandidates(pc) {
        (pc.__pending || []).forEach((c) => pc.addIceCandidate(c).catch(() => { /* stale */ }))
        pc.__pending = null
    }

    _upgradeToRtc(pc) {
        if (!this._previewOn || this._pc !== pc || !this._rtcLive) return
        this._framesOff()
        this._setPreviewMode('rtc')
    }

    _closePc() {
        if (this._pc) {
            try { this._pc.close() } catch (e) { /* already closed */ }
            this._pc = null
        }
        this._rtcStream = null
        this._rtcLive = false
    }

    _framesOn() {
        if (this._framesMode) return
        this._framesMode = true
        this._send({ op: 'frames', on: true })
        this._setPreviewMode('frames')
    }

    _framesOff() {
        if (!this._framesMode) return
        this._framesMode = false
        this._send({ op: 'frames', on: false })
    }

    getGlobal(name) {
        return this.globals[name]
    }

    setGlobal(name, value) {
        this.globals[name] = value
        // fader-driven: coalesce like liveSet
        this._liveQueue.set(' global:' + name, value)
        this._scheduleLiveFlush()
    }

    getShowCode() {
        return this.showCode
    }

    toggleCode() {
        this.showCode = !this.showCode // optimistic; host 'ui' cast confirms
        this._send({ op: 'toggleCode' })
    }

    ctx() {
        return {
            cm: null,
            emit: () => {},
            getModel: () => (this.panel && !this.panel.outOfSync ? this.panel.model : null),
            rebuild: () => this.panel && this.panel.rebuild()
        }
    }

    // -------------------------------------------------------------- scenes

    sceneSave(i) {
        this._send({ op: 'sceneSave', i })
    }

    sceneRecall(i, opts) {
        this._send({ op: 'sceneRecall', i, replaceURL: !!(opts && opts.replaceURL) })
    }

    sceneClear(i) {
        this._send({ op: 'sceneClear', i })
    }

    sceneAdd() {
        this._send({ op: 'sceneAdd' })
    }

    sceneRemove(i) {
        this._send({ op: 'sceneRemove', i })
    }

    sceneMove(from, to) {
        this._send({ op: 'sceneMove', from, to })
    }

    sceneReplaceAll(arr) {
        this._send({ op: 'scenesReplace', scenes: arr })
    }

    // --------------------------------------------------------- live values

    _scheduleLiveFlush() {
        if (this._liveTimer) return
        this._liveTimer = setTimeout(() => {
            this._liveTimer = null
            for (const [key, value] of this._liveQueue) {
                if (key.startsWith(' global:')) this._send({ op: 'global', name: key.slice(8), value })
                else this._send({ op: 'liveSet', path: key, value })
            }
            this._liveQueue.clear()
        }, LIVE_SEND_MS)
    }
}

// Same interface as LiveBind but the shadow program lives on the renderer:
// ensure() arms the binding there (message order guarantees it lands before
// the first liveSet), the ack gates quiet commits, and set() streams values.
class RemoteLiveBind {
    constructor(host) {
        this.host = host
        this.bindings = new Map() // path -> {acked}
        this.clean = false
        this.evaling = false
    }

    hasBindings() {
        return this.bindings.size > 0
    }

    isLive(path) {
        const b = this.bindings.get(path)
        return !!(b && b.acked && this.clean && this.host.connected)
    }

    ensure(ctx, path, initialValue) {
        if (!this.host.connected || !this.host.hostPresent) return null
        const existing = this.bindings.get(path)
        if (existing && existing.acked && this.clean) return path
        const b = existing || { acked: false }
        this.bindings.set(path, b)
        this.host._request({ op: 'liveEnsure', path, value: initialValue }, (res) => {
            if (res && res.ok) {
                b.acked = true
                this.clean = true
            } else {
                this.bindings.delete(path)
            }
        })
        return path // optimistic key; commits stay full-eval until the ack
    }

    set(path, value) {
        this.host._liveQueue.set(path, value)
        this.host._scheduleLiveFlush()
    }

    invalidate() {
        this.clean = false
        this.bindings.forEach((b) => { b.acked = false })
    }

    drop(path) {
        this.bindings.delete(path)
    }
}
