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

const ROOM_KEY = 'hydra-vj-room'
const TOKEN_KEY = 'hydra-vj-token'
const FFT_INTERVAL_MS = 90

export default function remoteStore(state, emitter) {
    if (typeof WebSocket === 'undefined' || window.location.protocol === 'file:') return

    let room = null
    let token = null
    try {
        const params = new URLSearchParams(window.location.search)
        room = params.get('vjroom') || localStorage.getItem(ROOM_KEY)
        token = params.get('vjtoken') || localStorage.getItem(TOKEN_KEY)
        if (!room || !/^[A-Za-z0-9_-]{10,64}$/.test(room)) room = 'r' + randomId(12)
        if (!token || !/^[A-Za-z0-9_-]{16,128}$/.test(token)) token = randomId(24)
        localStorage.setItem(ROOM_KEY, room)
        localStorage.setItem(TOKEN_KEY, token)
    } catch (e) {
        // private mode: session-scoped pairing still works
        room = room || 'r' + randomId(12)
        token = token || randomId(24)
    }

    state.vjRemote = { room, token, connected: false, decks: 0 }

    let ws = null
    let seq = 0
    let backoff = 1000
    let closedByReplace = false
    const fftSubs = new Set()
    const ensured = new Map() // deckId -> Set(path) for disconnect auto-commit
    let fftTimer = null

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
            lbClean: !!(p && p.lb.clean)
        }
    }

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
            case 'sceneMove':
                p.moveScene(msg.from | 0, msg.to | 0)
                return
            case 'scenesReplace':
                if (Array.isArray(msg.scenes)) p.host.sceneReplaceAll(msg.scenes)
                return
            default:
                emitter.emit('vj-remote: intent', from, msg) // preview signaling etc.
        }
    }

    const syncFftTimer = () => {
        if (fftSubs.size && !fftTimer) {
            fftTimer = setInterval(() => {
                const p = state.vjPanel
                const audio = p && p.host.audio ? p.host.audio() : null
                const fft = audio && audio.fft
                if (!fft || !fft.length) return
                cast({ t: 'fftFrame', bins: Array.from(fft.slice(0, 8), (v) => +(+v).toFixed(3)) })
            }, FFT_INTERVAL_MS)
        } else if (!fftSubs.size && fftTimer) {
            clearInterval(fftTimer)
            fftTimer = null
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
                commitDeckValues(msg.id)
                emitter.emit('vj-remote: deck-left', msg.id)
            } else if (msg.t === 'error' && msg.code === 'replaced') {
                // another host tab took the room over — newest wins, stand down
                closedByReplace = true
            }
        }
        ws.onclose = () => {
            state.vjRemote.connected = false
            retry()
        }
        ws.onerror = () => { /* close follows */ }
    }

    const retry = () => {
        if (closedByReplace) return
        const delay = backoff + Math.random() * 500
        backoff = Math.min(backoff * 2, 60000) // no relay deployed -> quiet slow retries
        setTimeout(connect, delay)
    }

    connect()

    // targeted send for other stores (WebRTC preview signaling)
    emitter.on('vj-remote: send', (deckId, msg) => to(deckId, msg))
}
