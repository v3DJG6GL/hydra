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
// broadcasts (host bridge -> this):
//   snapshot, codeChanged{cause}, scenes, ui, flash, fftFrame, evalResult,
//   reverted, ack, exprResult, hostState
import { codeHash } from './wire.js'

const LIVE_SEND_MS = 33 // coalesce fader streams to ~30Hz per path
const BACKOFF_MIN = 500
const BACKOFF_MAX = 8000

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
                if (this._previewImg) {
                    this._previewImg.src = msg.data
                    this._setPreviewMode('frames')
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
    // WebRTC first (signaled through the relay; STUN keeps it working over
    // WAN behind most NATs), throttled JPEG frames over the relay as the
    // dependable fallback — frames traverse anything the controls traverse.

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
            clearTimeout(this._rtcTimer)
            if (this._previewVideo) this._previewVideo.srcObject = null
        }
    }

    _kickPreview() {
        this._send({ op: 'previewStart' })
        clearTimeout(this._rtcTimer)
        // no track in time -> the P2P route is blocked (symmetric NAT, no
        // captureStream on the host…) -> switch to relayed frames
        this._rtcTimer = setTimeout(() => { if (this._previewOn) this._framesOn() }, 5000)
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
            this._previewWrap = wrap
            this._previewVideo = video
            this._previewImg = img
            if (this._rtcStream) video.srcObject = this._rtcStream
            this._setPreviewMode(this._mode || 'rtc')
        }
        const p = this._previewVideo.play()
        if (p && p.catch) p.catch(() => { /* resumes on autoplay */ })
        return this._previewWrap
    }

    _setPreviewMode(mode) {
        this._mode = mode
        if (!this._previewVideo) return
        this._previewVideo.style.display = mode === 'rtc' ? '' : 'none'
        this._previewImg.style.display = mode === 'frames' ? '' : 'none'
    }

    _onRtc(msg) {
        if (msg.kind === 'offer') {
            this._closePc()
            let pc
            try {
                pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })
            } catch (e) {
                this._framesOn()
                return
            }
            this._pc = pc
            pc.ontrack = (e) => {
                this._rtcStream = e.streams[0] || new MediaStream([e.track])
                if (this._previewVideo) {
                    this._previewVideo.srcObject = this._rtcStream
                    const p = this._previewVideo.play()
                    if (p && p.catch) p.catch(() => {})
                }
                clearTimeout(this._rtcTimer)
                this._framesOff()
                this._setPreviewMode('rtc')
            }
            pc.onicecandidate = (e) => {
                if (e.candidate) this._send({ op: 'rtc', kind: 'candidate', candidate: e.candidate })
            }
            pc.oniceconnectionstatechange = () => {
                if (this._previewOn && ['failed', 'disconnected', 'closed'].includes(pc.iceConnectionState)) {
                    this._framesOn()
                }
            }
            pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp })
                .then(() => pc.createAnswer())
                .then((a) => pc.setLocalDescription(a))
                .then(() => this._send({ op: 'rtc', kind: 'answer', sdp: pc.localDescription.sdp }))
                .catch(() => this._framesOn())
        } else if (msg.kind === 'candidate' && this._pc) {
            this._pc.addIceCandidate(msg.candidate).catch(() => { /* stale */ })
        }
    }

    _closePc() {
        if (this._pc) {
            try { this._pc.close() } catch (e) { /* already closed */ }
            this._pc = null
        }
        this._rtcStream = null
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
