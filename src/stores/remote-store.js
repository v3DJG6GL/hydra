// Host-side bridge for the remote VJ deck: connects this (renderer) tab to
// the relay as the room's host, executes deck intents through the SAME
// VJPanel/adapter paths the local deck uses, and broadcasts authoritative
// state back (full code text after every change — sketches are tiny).
//
// Pairing material: ?vjroom=&vjtoken= URL params pin it (kiosk autostart),
// otherwise generated once and kept in localStorage. The deck URL is
// location.origin + /deck.html#room=…&token=… — surfaced by the pairing
// screen (deck.html#pair on this same browser profile), NEVER on the
// projected page itself.
import { codeHash, relayUrl, randomId } from '../panel/wire.js'
import { fmtNumber } from '../panel/metadata.js'
import * as fftBus from '../lib/fft-bus.js'
import { isDisplay, applyTier, currentTier, collectDiag, showReplacedOverlay } from '../lib/display-mode.js'

const ROOM_KEY = 'hydra-vj-room'
const TOKEN_KEY = 'hydra-vj-token'
// display-mode credentials live under their own keys: a TV paired via the
// short-code flow holds a revocable display token, never the room token,
// and display mode must never mint credentials of its own (that would
// silently claim a fresh room and defeat pairing entirely)
const DISPLAY_ROOM_KEY = 'hydra-vj-display-room'
const DISPLAY_TOKEN_KEY = 'hydra-vj-display-token'
const FFT_INTERVAL_MS = 90
const ROOM_RE = /^[A-Za-z0-9_-]{10,64}$/
const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/

export default function remoteStore(state, emitter) {
    if (typeof WebSocket === 'undefined' || window.location.protocol === 'file:') return

    fftBus.attachFftBus(emitter)

    let room = null
    let token = null
    let needsPairing = false
    const params = (() => {
        try { return new URLSearchParams(window.location.search) } catch (e) { return new URLSearchParams() }
    })()
    if (isDisplay()) {
        // kiosk pinning (?vjroom=&vjtoken=) still bypasses pairing; otherwise
        // use a previously paired display credential or run the code flow
        try {
            room = params.get('vjroom') || localStorage.getItem(DISPLAY_ROOM_KEY)
            token = params.get('vjtoken') || localStorage.getItem(DISPLAY_TOKEN_KEY)
        } catch (e) { /* private mode */ }
        if (!ROOM_RE.test(String(room || '')) || !TOKEN_RE.test(String(token || ''))) {
            room = null
            token = null
            needsPairing = true
        } else {
            try {
                localStorage.setItem(DISPLAY_ROOM_KEY, room)
                localStorage.setItem(DISPLAY_TOKEN_KEY, token)
            } catch (e) { /* private mode */ }
        }
    } else {
        try {
            room = params.get('vjroom') || localStorage.getItem(ROOM_KEY)
            token = params.get('vjtoken') || localStorage.getItem(TOKEN_KEY)
            if (!room || !ROOM_RE.test(room)) room = 'r' + randomId(12)
            if (!token || !TOKEN_RE.test(token)) token = randomId(24)
            localStorage.setItem(ROOM_KEY, room)
            localStorage.setItem(TOKEN_KEY, token)
        } catch (e) {
            // private mode: session-scoped pairing still works
            room = room || 'r' + randomId(12)
            token = token || randomId(24)
        }
    }

    state.vjRemote = { room, token, connected: false, decks: 0 }

    let ws = null
    let seq = 0
    let backoff = 1000
    let closedByReplace = false
    let stopped = false // display credential revoked — back to pairing, no retries
    const fftSubs = new Set()
    const diagSubs = new Set()
    const ensured = new Map() // deckId -> Set(path) for disconnect auto-commit
    let fftTimer = null
    let diagTimer = null
    let fftSourceDeckId = null // the deck elected to stream fftBins (last claim wins)

    const panel = () => {
        emitter.emit('panel: ensure')
        const p = state.vjPanel
        // the dock may be closed on this machine, so the panel-store's
        // debounced rebuild never runs — intents need a model that matches
        // the buffer (edits are guarded against exactly this staleness)
        const c = cm()
        if (p && c && (!p.model || p.model.text !== c.getValue())) p.rebuild()
        return p
    }
    const cm = () => state.editor && state.editor.editor && state.editor.editor.cm

    const sendRaw = (obj) => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj))
    }
    const cast = (msg) => sendRaw({ t: 'cast', msg })
    const to = (id, msg) => sendRaw({ t: 'to', id, msg })

    const globals = () => ({
        speed: typeof window.speed === 'number' ? window.speed : 1,
        bpm: typeof window.bpm === 'number' ? window.bpm : 30
    })

    const fftState = () => ({ ...fftBus.state(), sourceDeckId: fftSourceDeckId })

    const snapshotMsg = () => {
        const p = panel()
        const c = cm()
        return {
            t: 'snapshot',
            seq,
            code: c ? c.getValue() : '',
            historySize: c ? c.historySize() : { undo: 0, redo: 0 },
            scenes: p ? p.host.scenes : [],
            transforms: p ? p.host.getTransforms() : {},
            showCode: state.showCode !== false,
            globals: globals(),
            lbClean: !!(p && p.lb.clean),
            canPreview: !!(p && p.host.captureStream()),
            fft: fftState(),
            display: { on: isDisplay(), tier: currentTier() }
        }
    }

    // fft source changes (bus arbitration or deck election) reach every deck
    fftBus.onChange(() => cast({ t: 'fftState', ...fftState() }))
    // a.setSmooth()/setCutoff()/setScale()/setBins() on this renderer must
    // reach the deck that owns the mic so its Meyda pipeline stays in sync
    fftBus.onSettingCall((fn, value) => {
        if (fftSourceDeckId) to(fftSourceDeckId, { t: 'fftCtl', fn, value })
    })

    // ---- outgoing state: debounced full-text pushes

    let castTimer = null
    let pendingCause = null
    const scheduleCodeCast = (cause) => {
        if (cause && !pendingCause) pendingCause = cause
        clearTimeout(castTimer)
        castTimer = setTimeout(() => {
            const c = cm()
            if (!c) return
            const p = state.vjPanel
            cast({
                t: 'codeChanged',
                seq: ++seq,
                cause: pendingCause,
                code: c.getValue(),
                historySize: c.historySize(),
                globals: globals(),
                lbClean: !!(p && p.lb.clean)
            })
            pendingCause = null
        }, 80)
    }

    // host edits typed by hand must reach the decks too
    let wireTimer = setInterval(() => {
        const c = cm()
        if (!c || c.__vjRemoteWired) return
        c.__vjRemoteWired = true
        clearInterval(wireTimer)
        c.on('changes', () => scheduleCodeCast(null))
    }, 500)

    emitter.on('panel: runtime-reverted', () => cast({ t: 'reverted' }))
    emitter.on('ui: toggle code', () => cast({ t: 'ui', seq: ++seq, showCode: state.showCode !== false }))
    // a real eval that isn't LiveBind's own shadow invalidates every remote
    // binding exactly like the local ones
    emitter.on('repl: eval', () => {
        const p = state.vjPanel
        if (p && !p.lb.evaling && !p.lb.clean) cast({ t: 'lb', clean: false })
    })

    const wireScenes = () => {
        const p = panel()
        if (!p || p.host.__vjRemoteScenes) return p
        p.host.__vjRemoteScenes = true
        p.host.on('scenes-changed', () => {
            cast({ t: 'scenes', seq: ++seq, scenes: p.host.scenes })
            sendRaw({ t: 'persist', scenes: p.host.scenes })
        })
        return p
    }

    // ---- incoming intents

    const handleIntent = (from, msg) => {
        const p = wireScenes()
        if (!p) return
        switch (msg.op) {
            case 'reqSnapshot':
                to(from, snapshotMsg())
                return
            case 'edit': {
                const c = cm()
                const ok = !!c && codeHash(c.getValue()) === msg.baseHash
                if (!ok) {
                    to(from, { t: 'evalResult', reqId: msg.reqId, ok: false, error: 'edit rejected (out of sync) — resyncing' })
                    to(from, snapshotMsg())
                    return
                }
                const applied = msg.quiet
                    ? p.applyQuiet(msg.edit)
                    : p.apply(msg.edit, { replaceURL: !!msg.replaceURL })
                to(from, {
                    t: 'evalResult',
                    reqId: msg.reqId,
                    ok: !!applied,
                    error: applied ? undefined : 'edit failed to eval on the renderer'
                })
                scheduleCodeCast('edit')
                return
            }
            case 'history':
                p.historyStep(msg.dir === 'redo' ? 'redo' : 'undo')
                scheduleCodeCast('history')
                return
            case 'random':
                if (msg.kind === 'shuffle') p.deckShuffle()
                else p.deckMutate(!!msg.changeTransform)
                scheduleCodeCast('random')
                return
            case 'run':
                p.host.run(String(msg.code))
                return
            case 'evalExpr':
                p.host.evalExpr(String(msg.src), (v) => to(from, { t: 'exprResult', reqId: msg.reqId, value: v }))
                return
            case 'liveEnsure': {
                const key = p.lb.ensure(p.ctx(), msg.path, msg.value)
                if (key) {
                    if (!ensured.has(from)) ensured.set(from, new Set())
                    ensured.get(from).add(msg.path)
                }
                to(from, { t: 'ack', reqId: msg.reqId, ok: !!key })
                return
            }
            case 'liveSet': {
                let key = p.lb.bindings.get(msg.path)
                if (!key || !p.lb.isLive(msg.path)) {
                    key = p.lb.ensure(p.ctx(), msg.path, msg.value) // self-heal after an invalidating eval
                }
                if (!key) return
                p.lb.set(key, msg.value)
                p.flashParamValue(msg.path, msg.value)
                cast({ t: 'flash', path: msg.path, value: msg.value, src: from })
                return
            }
            case 'global':
                if (msg.name === 'speed' || msg.name === 'bpm') window[msg.name] = msg.value
                return
            case 'audio':
                p.host.audioCall(String(msg.fn), msg.value)
                return
            case 'toggleCode':
                p.host.toggleCode() // the 'ui: toggle code' hook above casts the new state
                return
            case 'fft':
                if (msg.on) fftSubs.add(from)
                else fftSubs.delete(from)
                syncFftTimer()
                return
            case 'fftPub': {
                // this deck claims (or releases) the "I stream the FFT" role —
                // last claim wins; the displaced deck sees fftState and stops
                const prev = fftSourceDeckId
                if (msg.on) fftSourceDeckId = from
                else if (fftSourceDeckId === from) fftSourceDeckId = null
                if (prev !== fftSourceDeckId) cast({ t: 'fftState', ...fftState() })
                return
            }
            case 'fftBins':
                if (from === fftSourceDeckId) fftBus.pushDeckBins(msg.bins)
                return
            case 'fftSource':
                fftBus.setMode(String(msg.source)) // bus onChange casts fftState
                return
            case 'displayTier':
                if (isDisplay() && applyTier(String(msg.tier))) {
                    cast({ t: 'display', on: true, tier: currentTier() })
                }
                return
            case 'diag':
                if (msg.on) diagSubs.add(from)
                else diagSubs.delete(from)
                syncDiagTimer()
                return
            case 'sceneSave':
                p.saveScene(msg.i | 0)
                return
            case 'sceneRecall':
                p.recallScene(msg.i | 0, msg.replaceURL ? { replaceURL: true } : undefined)
                scheduleCodeCast('scene')
                return
            case 'sceneClear':
                p.clearScene(msg.i | 0)
                return
            case 'sceneAdd':
                p.addScene()
                return
            case 'sceneRemove':
                p.removeScene(msg.i | 0)
                return
            case 'sceneMove':
                p.moveScene(msg.from | 0, msg.to | 0)
                return
            case 'scenesReplace':
                if (Array.isArray(msg.scenes)) p.host.sceneReplaceAll(msg.scenes)
                return
            case 'previewStart':
                if (typeof msg.w === 'number' && isFinite(msg.w)) frameReq.set(from, reqPx(msg.w))
                startRtc(from, p)
                return
            case 'previewSize': {
                // a deck pane was resized — retarget its streams live
                if (typeof msg.w !== 'number' || !isFinite(msg.w)) return
                frameReq.set(from, reqPx(msg.w))
                const pc = pcs.get(from)
                if (pc) capPreviewSenders(pc, deckTarget(from))
                return
            }
            case 'previewStop':
                stopRtc(from)
                frameSubs.delete(from)
                frameReq.delete(from)
                syncFrameTimer()
                return
            case 'rtc':
                onRtcAnswer(from, msg)
                return
            case 'frames':
                if (msg.on) frameSubs.add(from)
                else frameSubs.delete(from)
                syncFrameTimer()
                return
            default:
                emitter.emit('vj-remote: intent', from, msg)
        }
    }

    // ---- live preview: hydra's captureStream over WebRTC per deck, with
    // relayed frames (getScreenImage, adaptive ~1–3fps) as the fallback

    // WebP is ~30% smaller than JPEG at like quality and every deck browser
    // decodes it — but not every host encodes it (Safari): toDataURL falls
    // back to PNG silently there, hence the one-time capability probe
    const frameMime = (() => {
        try {
            const c = document.createElement('canvas')
            c.width = c.height = 2
            return c.toDataURL('image/webp').startsWith('data:image/webp') ? 'image/webp' : 'image/jpeg'
        } catch (e) { return 'image/jpeg' }
    })()

    const pcs = new Map() // deckId -> RTCPeerConnection
    const frameSubs = new Set()
    let frameTimer = null
    let frameBusy = false

    // high-entropy sketches (voronoi at high frequency…) are the bandwidth
    // worst case on both preview paths — budget them to preview-pane rates.
    // Profile by mode: plain http IS the LAN rig by definition (see
    // docs/remote-deck.md — mixing modes is impossible anyway), so it gets
    // generous budgets; https (WAN) stays tight for venue uplinks. Both are
    // overridable per-deployment via HYDRA_PREVIEW_* env vars on the relay,
    // delivered in the welcome. frameKbps is the relayed-frames rate budget:
    // base64 data-URL chars are one wire byte each, so kbps maps to chars/ms.
    const lan = window.location.protocol === 'http:'
    const prevCfg = {
        rtcKbps: lan ? 6000 : 1200, // WebRTC sender bitrate cap
        frameKbps: lan ? 400 : 150, // relayed-frames budget, KB/s
        frameWidth: lan ? 720 : 480, // resolution ceiling, both paths
        minFrameMs: 350 // fastest frame cadence
    }
    const PREV_CLAMPS = { rtcKbps: [100, 50000], frameKbps: [20, 5000], frameWidth: [160, 1920], minFrameMs: [100, 2000] }
    const applyPreviewCfg = (cfg) => {
        if (!cfg) return
        Object.keys(PREV_CLAMPS).forEach((k) => {
            const v = cfg[k]
            if (typeof v === 'number' && isFinite(v)) {
                prevCfg[k] = Math.min(PREV_CLAMPS[k][1], Math.max(PREV_CLAMPS[k][0], Math.round(v)))
            }
        })
        frameMs = Math.max(frameMs, prevCfg.minFrameMs)
    }

    // decks report how large their preview pane actually renders (device
    // px, sent with previewStart and again after a resize) — encoding more
    // than the largest pane, or the configured ceiling, is wasted uplink
    const frameReq = new Map() // deckId -> requested px
    const reqPx = (w) => Math.min(1920, Math.max(160, Math.round(w)))
    const deckTarget = (deckId) => Math.min(prevCfg.frameWidth, frameReq.get(deckId) || 480)
    const frameWidths = () => {
        let top = 480
        frameReq.forEach((w) => { top = Math.max(top, w) })
        top = Math.min(prevCfg.frameWidth, top)
        return [top, Math.round(top * 0.75), Math.round(top * 0.6)]
    }
    // perceived quality order for a VJ preview is resolution > quality >
    // motion — heavy sketches surrender framerate first (minFrameMs →
    // 800ms), then a little quality, then one resolution step at a time,
    // and walk back up in reverse when the sketch calms down
    const FRAME_MAX_MS = 800
    let frameQ = 0.55
    let frameTier = 0
    let frameMs = prevCfg.minFrameMs

    // best-effort sender cap — a UA without populated encodings just stays
    // uncapped, exactly as before. Re-callable: scaleResolutionDownBy and
    // maxBitrate apply live, so a deck resize retargets without renegotiating
    const capPreviewSenders = (pc, targetW) => {
        pc.getSenders().forEach((sender) => {
            if (!sender.track) return
            try {
                const prm = sender.getParameters()
                if (!prm.encodings || !prm.encodings.length) return
                const w = sender.track.getSettings ? (sender.track.getSettings().width || 0) : 0
                prm.encodings.forEach((enc) => {
                    enc.maxBitrate = prevCfg.rtcKbps * 1000
                    enc.scaleResolutionDownBy = w > targetW * 1.25 ? w / targetW : 1
                })
                prm.degradationPreference = 'maintain-framerate'
                sender.setParameters(prm).catch(() => { /* caps rejected — uncapped */ })
            } catch (e) { /* getParameters unsupported */ }
        })
    }

    const stopRtc = (deckId) => {
        const pc = pcs.get(deckId)
        if (pc) {
            try { pc.close() } catch (e) { /* already closed */ }
            pcs.delete(deckId)
        }
    }

    const startRtc = async (deckId, p) => {
        stopRtc(deckId)
        const stream = p && p.host.captureStream()
        if (!stream || typeof RTCPeerConnection === 'undefined') return // deck times out into frames
        let pc
        try {
            // two independent STUN providers — venue networks sometimes block one
            pc = new RTCPeerConnection({ iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun.cloudflare.com:3478' }
            ] })
        } catch (e) { return }
        pcs.set(deckId, pc)
        try {
            stream.getTracks().forEach((t) => {
                try { t.contentHint = 'motion' } catch (e) { /* hint unsupported */ }
                pc.addTrack(t, stream)
            })
            pc.onicecandidate = (e) => {
                if (e.candidate) to(deckId, { t: 'rtc', kind: 'candidate', candidate: e.candidate })
            }
            const offer = await pc.createOffer()
            await pc.setLocalDescription(offer)
            capPreviewSenders(pc, deckTarget(deckId))
            to(deckId, { t: 'rtc', kind: 'offer', sdp: pc.localDescription.sdp })
        } catch (e) {
            stopRtc(deckId)
        }
    }

    const onRtcAnswer = (deckId, msg) => {
        const pc = pcs.get(deckId)
        if (!pc) return
        if (msg.kind === 'answer') {
            pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp }).then(() => {
                (pc.__pending || []).forEach((c) => pc.addIceCandidate(c).catch(() => { /* stale */ }))
                pc.__pending = null
            }).catch(() => {})
        } else if (msg.kind === 'candidate') {
            // trickle candidates can outrun the answer's setRemoteDescription
            if (pc.remoteDescription) pc.addIceCandidate(msg.candidate).catch(() => { /* stale */ })
            else (pc.__pending = pc.__pending || []).push(msg.candidate)
        }
    }

    // self-scheduling so the cadence can adapt; the first frame goes out
    // immediately on subscribe
    const scheduleFrame = (ms) => {
        frameTimer = setTimeout(() => {
            captureFrame()
            if (frameSubs.size) scheduleFrame(frameMs)
            else frameTimer = null
        }, ms)
    }
    const syncFrameTimer = () => {
        if (frameSubs.size && !frameTimer) scheduleFrame(0)
        else if (!frameSubs.size && frameTimer) {
            clearTimeout(frameTimer)
            frameTimer = null
        }
    }

    const captureFrame = () => {
        if (frameBusy) return
        const hydra = state.hydra && state.hydra.hydra
        if (!hydra || typeof hydra.getScreenImage !== 'function') return
        frameBusy = true
        let settled = false
        const done = () => { if (!settled) { settled = true; frameBusy = false } }
        const guard = setTimeout(done, 2000) // rendering stalled — skip the frame
        try {
            hydra.getScreenImage((blob) => {
                if (!blob) { clearTimeout(guard); return done() }
                const url = URL.createObjectURL(blob)
                const img = new Image()
                img.onload = () => {
                    try {
                        const c = document.createElement('canvas')
                        const w = frameWidths()[frameTier]
                        c.width = w
                        c.height = Math.max(1, Math.round(w * img.height / img.width))
                        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height)
                        const data = c.toDataURL(frameMime, frameQ)
                        // feedback toward the rate budget — framerate gives
                        // way first, resolution last (and recovers first)
                        const budget = prevCfg.frameKbps * 1000
                        const rate = data.length * 1000 / frameMs
                        if (rate > budget) {
                            if (frameMs < FRAME_MAX_MS) {
                                const need = Math.round(data.length * 1000 / budget)
                                frameMs = Math.min(FRAME_MAX_MS, Math.max(frameMs + 50, need))
                            } else if (frameQ > 0.4) frameQ = Math.max(0.4, frameQ - 0.07)
                            else if (frameTier < 2) frameTier++
                        } else if (rate < budget * 0.5) {
                            if (frameTier > 0) frameTier--
                            else if (frameQ < 0.55) frameQ = Math.min(0.55, frameQ + 0.04)
                            else if (frameMs > prevCfg.minFrameMs) frameMs = Math.max(prevCfg.minFrameMs, frameMs - 60)
                        }
                        frameSubs.forEach((id) => to(id, { t: 'frame', data }))
                    } catch (e) { /* canvas hiccup — drop the frame */ }
                    URL.revokeObjectURL(url)
                    clearTimeout(guard)
                    done()
                }
                img.onerror = () => {
                    URL.revokeObjectURL(url)
                    clearTimeout(guard)
                    done()
                }
                img.src = url
            })
        } catch (e) {
            clearTimeout(guard)
            done()
        }
    }

    const syncFftTimer = () => {
        if (fftSubs.size && !fftTimer) {
            fftTimer = setInterval(() => {
                const p = state.vjPanel
                const audio = p && p.host.audio ? p.host.audio() : null
                const fft = audio && audio.fft
                if (!fft || !fft.length) return
                // the bus writes deck/native bins into this same a.fft, so
                // every deck's meter shows whichever source is live
                cast({ t: 'fftFrame', bins: Array.from(fft.slice(0, 8), (v) => +(+v).toFixed(3)), src: fftBus.state().active })
            }, FFT_INTERVAL_MS)
        } else if (!fftSubs.size && fftTimer) {
            clearInterval(fftTimer)
            fftTimer = null
        }
    }

    // 1 Hz device diagnostics for the deck OSD (targeted, subscribers only)
    const syncDiagTimer = () => {
        if (diagSubs.size && !diagTimer) {
            diagTimer = setInterval(() => {
                const d = collectDiag()
                diagSubs.forEach((id) => to(id, d))
            }, 1000)
        } else if (!diagSubs.size && diagTimer) {
            clearInterval(diagTimer)
            diagTimer = null
        }
    }

    // when a controller vanishes mid-gesture, pin its last live values into
    // the code — otherwise the wall shows X while the code says Y
    const commitDeckValues = (deckId) => {
        const paths = ensured.get(deckId)
        ensured.delete(deckId)
        const p = state.vjPanel
        if (!paths || !p || p.outOfSync || !p.model) return
        paths.forEach((path) => {
            if (!p.lb.isLive(path)) return
            const stillHeld = Array.from(ensured.values()).some((set) => set.has(path))
            if (stillHeld) return
            const arg = p.model.pathIndex.get(path)
            const key = p.lb.bindings.get(path)
            const v = key !== undefined && window.__vj ? window.__vj[key] : undefined
            if (!arg || arg.kind !== 'number' || typeof v !== 'number' || !isFinite(v)) return
            if (parseFloat(fmtNumber(v)) === arg.value) return
            p.applyQuiet({ from: arg.range[0], to: arg.range[1], text: fmtNumber(v) })
        })
        scheduleCodeCast('edit')
    }

    // ---- relay connection (host role)

    const connect = () => {
        if (closedByReplace) return
        try {
            ws = new WebSocket(relayUrl())
        } catch (e) {
            retry()
            return
        }
        ws.onopen = () => {
            ws.send(JSON.stringify({ t: 'hello', role: 'host', room, token }))
        }
        ws.onmessage = (e) => {
            let msg
            try { msg = JSON.parse(e.data) } catch (err) { return }
            if (msg.t === 'welcome') {
                backoff = 1000
                state.vjRemote.connected = true
                state.vjRemote.decks = msg.deckCount || 0
                applyPreviewCfg(msg.preview)
                // a kiosk with wiped localStorage gets its bank back from the relay
                const p = wireScenes()
                if (p && Array.isArray(msg.persistedScenes) && p.host.scenes.every((s) => !s) &&
                    msg.persistedScenes.some(Boolean)) {
                    p.host.sceneReplaceAll(msg.persistedScenes)
                }
                if (msg.deckCount) cast(snapshotMsg())
            } else if (msg.t === 'intent') {
                try { handleIntent(msg.from, msg.msg) } catch (err) {
                    console.warn('vj remote intent failed', msg.msg && msg.msg.op, err)
                }
            } else if (msg.t === 'deckJoined') {
                state.vjRemote.decks++
                wireScenes()
                to(msg.id, snapshotMsg())
            } else if (msg.t === 'deckLeft') {
                state.vjRemote.decks = Math.max(0, state.vjRemote.decks - 1)
                fftSubs.delete(msg.id)
                syncFftTimer()
                diagSubs.delete(msg.id)
                syncDiagTimer()
                if (fftSourceDeckId === msg.id) {
                    fftSourceDeckId = null // bus staleness falls back per arbitration
                    cast({ t: 'fftState', ...fftState() })
                }
                stopRtc(msg.id)
                frameSubs.delete(msg.id)
                frameReq.delete(msg.id)
                syncFrameTimer()
                commitDeckValues(msg.id)
                emitter.emit('vj-remote: deck-left', msg.id)
            } else if (msg.t === 'error' && msg.code === 'replaced') {
                // another host tab took the room over — newest wins, stand down
                closedByReplace = true
                // …except a TV going silently dark looks like a crash: say
                // what happened and let the remote's OK key reclaim the room
                if (isDisplay()) showReplacedOverlay()
            } else if (msg.t === 'error' && isDisplay() &&
                (msg.code === 'revoked' || msg.code === 'unauthorized' || msg.code === 'bad-token' || msg.code === 'bad-room')) {
                // this display's credential is gone — wipe it and re-pair
                stopped = true
                try {
                    localStorage.removeItem(DISPLAY_ROOM_KEY)
                    localStorage.removeItem(DISPLAY_TOKEN_KEY)
                } catch (e) { /* private mode */ }
                startDisplayPairing()
            }
        }
        ws.onclose = () => {
            state.vjRemote.connected = false
            retry()
        }
        ws.onerror = () => { /* close follows */ }
    }

    const retry = () => {
        if (closedByReplace || stopped) return
        const delay = backoff + Math.random() * 500
        backoff = Math.min(backoff * 2, 60000) // no relay deployed -> quiet slow retries
        setTimeout(connect, delay)
    }

    // display with no credential: run the short-code pairing overlay; the
    // relay hands over {room, token} once a deck approves the code
    const startDisplayPairing = () => {
        import('../views/display-pair.js').then((m) => {
            m.startPairing({
                onPaired: (creds) => {
                    room = creds.room
                    token = creds.token
                    state.vjRemote.room = room
                    state.vjRemote.token = token
                    try {
                        localStorage.setItem(DISPLAY_ROOM_KEY, room)
                        localStorage.setItem(DISPLAY_TOKEN_KEY, token)
                    } catch (e) { /* private mode */ }
                    stopped = false
                    backoff = 1000
                    connect()
                }
            })
        }).catch((e) => console.warn('display pairing unavailable', e))
    }

    if (needsPairing) startDisplayPairing()
    else connect()

    // targeted send for other stores (WebRTC preview signaling)
    emitter.on('vj-remote: send', (deckId, msg) => to(deckId, msg))
}
