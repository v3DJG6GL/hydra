// WebSocket relay for the remote VJ deck (docs/remote-deck-plan.md).
//
// A dumb, host-authoritative pipe: it never interprets deck intents or host
// state — it authenticates sockets into rooms and forwards messages. The only
// state it owns is the per-room scene bank (so a kiosk host with wiped
// localStorage gets its scenes back) persisted as one JSON file per room.
//
// Wire protocol (JSON text frames):
//   first frame (within HELLO_TIMEOUT):
//     {t:'hello', role:'host'|'deck', room, token, build?}
//   relay replies {t:'welcome', id, role, hostPresent, persistedScenes?,
//     preview?} (persistedScenes/preview only to the host — preview carries
//     the HYDRA_PREVIEW_* budget overrides, see below) or closes with
//     {t:'error', code}.
//   host -> relay:  {t:'cast', msg}         broadcast msg to every deck
//                   {t:'to', id, msg}       send msg to one deck
//                   {t:'persist', scenes}   store the scene bank
//   deck -> relay:  {t:'intent', msg}       forwarded to the host as
//                                           {t:'intent', from, msg}
//   relay -> host:  {t:'deckJoined'|'deckLeft', id}
//   relay -> deck:  {t:'hostState', present}
//   a second host hello takes the room over; the old socket gets
//   {t:'error', code:'replaced'} and is closed (newest host wins — that is
//   how a reloaded kiosk recovers before the dead socket times out).
//
// Security model: the control channel is remote code execution BY DESIGN, so
// joining requires the unguessable room id AND its token (bound at room
// creation, compared constant-time). Handshakes are rate-limited per IP,
// sockets that don't hello in time are dropped, and the Origin header must
// match the request Host unless HYDRA_RELAY_ALLOWED_ORIGINS says otherwise.
import { WebSocketServer } from 'ws'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const HELLO_TIMEOUT_MS = 5000
const PING_INTERVAL_MS = 25000 // under typical 60s proxy idle timeouts
const MAX_PAYLOAD = 8 * 1024 * 1024 // snapshots carry scene thumbs; frames are ~50KB
const ROOM_RE = /^[A-Za-z0-9_-]{10,64}$/ // also the on-disk filename — no traversal
const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/
const HANDSHAKES_PER_MIN = 30
const ROOM_IDLE_DROP_MS = 24 * 60 * 60 * 1000

const timingSafeEq = (a, b) => {
    const ha = crypto.createHash('sha256').update(String(a)).digest()
    const hb = crypto.createHash('sha256').update(String(b)).digest()
    return crypto.timingSafeEqual(ha, hb)
}

// Preview bandwidth budgets, pushed to the renderer in its welcome. Unset
// vars leave the page's own mode-based defaults (LAN generous / WAN tight)
// alone — only explicitly set values override, clamped to sane ranges.
// A single stack can serve both modes (LAN http + a TLS proxy in front):
// the renderer's Origin scheme picks the scope, so limits can differ.
//   HYDRA_PREVIEW_RTC_KBPS      WebRTC sender bitrate cap
//   HYDRA_PREVIEW_FRAME_KBPS    relayed-frames rate budget (KB/s on the wire)
//   HYDRA_PREVIEW_FRAME_WIDTH   preview resolution ceiling (both paths)
//   HYDRA_PREVIEW_MIN_FRAME_MS  min gap between fallback-mode snapshots,
//                               i.e. the frames path's top speed (350≈3fps)
//   HYDRA_PREVIEW_LAN_* / HYDRA_PREVIEW_WAN_*  mode-scoped variants; a
//   scoped var beats the unscoped one for renderers in that mode
const previewCfg = (env, scope) => {
    const pick = (key, lo, hi) => {
        const scoped = env['HYDRA_PREVIEW_' + scope + '_' + key]
        const v = parseInt(scoped !== undefined ? scoped : env['HYDRA_PREVIEW_' + key], 10)
        return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined
    }
    const cfg = {
        rtcKbps: pick('RTC_KBPS', 100, 50000),
        frameKbps: pick('FRAME_KBPS', 20, 5000),
        frameWidth: pick('FRAME_WIDTH', 160, 1920),
        minFrameMs: pick('MIN_FRAME_MS', 100, 2000)
    }
    Object.keys(cfg).forEach((k) => { if (cfg[k] === undefined) delete cfg[k] })
    return Object.keys(cfg).length ? cfg : null
}

export function attachRelay(httpServer, opts = {}) {
    const wsPath = opts.path || '/ws'
    const dataDir = opts.dataDir || process.env.HYDRA_RELAY_DATA_DIR || './vj-data'
    const allowedOrigins = (opts.allowedOrigins || process.env.HYDRA_RELAY_ALLOWED_ORIGINS || '')
        .split(',').map((s) => s.trim()).filter(Boolean)
    const preview = {
        lan: opts.preview !== undefined ? opts.preview : previewCfg(process.env, 'LAN'),
        wan: opts.preview !== undefined ? opts.preview : previewCfg(process.env, 'WAN')
    }
    const log = opts.quiet ? () => {} : (...a) => console.log('[vj-relay]', ...a)

    try { fs.mkdirSync(dataDir, { recursive: true }) } catch (e) { /* read-only fs: persistence off */ }

    const rooms = new Map() // roomId -> {token, host, decks: Map<id, ws>, lastSeen}
    const handshakes = new Map() // ip -> {count, resetAt}
    let nextId = 1

    const sceneFile = (roomId) => path.join(dataDir, roomId + '.json')
    const loadPersisted = (roomId) => {
        try {
            const parsed = JSON.parse(fs.readFileSync(sceneFile(roomId), 'utf8'))
            return Array.isArray(parsed.scenes) ? parsed.scenes : null
        } catch (e) { return null }
    }
    const persist = (roomId, scenes) => {
        if (!Array.isArray(scenes)) return
        try {
            fs.writeFileSync(sceneFile(roomId), JSON.stringify({ scenes, savedAt: Date.now() }))
        } catch (e) { log('persist failed', e.message) }
    }

    const originOk = (req) => {
        const origin = req.headers.origin
        if (!origin) return false
        if (allowedOrigins.length) return allowedOrigins.includes(origin)
        try {
            // same-origin design: the page and the relay share a host. Compare
            // hostnames, not host:port — reverse proxies drop default ports.
            const reqHost = String(req.headers.host || '').replace(/:\d+$/, '')
            return new URL(origin).hostname === reqHost && reqHost !== ''
        } catch (e) { return false }
    }

    const rateOk = (ip) => {
        const now = Date.now()
        let entry = handshakes.get(ip)
        if (!entry || now > entry.resetAt) {
            entry = { count: 0, resetAt: now + 60000 }
            handshakes.set(ip, entry)
        }
        entry.count++
        return entry.count <= HANDSHAKES_PER_MIN
    }

    const send = (ws, obj) => {
        if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj))
    }
    const refuse = (ws, code) => {
        send(ws, { t: 'error', code })
        ws.close(4000, code)
    }

    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD })

    httpServer.on('upgrade', (req, socket, head) => {
        let pathname = ''
        try { pathname = new URL(req.url, 'http://x').pathname } catch (e) { /* fall through */ }
        if (pathname !== wsPath) return // vite HMR & friends keep their own upgrades
        const ip = (req.socket.remoteAddress || 'unknown')
        if (!rateOk(ip)) { socket.destroy(); return }
        if (!originOk(req)) { socket.destroy(); return }
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
    })

    wss.on('connection', (ws, req) => {
        ws.isAlive = true
        ws.on('pong', () => { ws.isAlive = true })
        ws.vj = null // set after a valid hello
        // https page = WAN mode, plain http = LAN — scopes the preview budgets
        ws.mode = String((req && req.headers.origin) || '').startsWith('https') ? 'wan' : 'lan'

        const helloTimer = setTimeout(() => { if (!ws.vj) refuse(ws, 'hello-timeout') }, HELLO_TIMEOUT_MS)

        ws.on('message', (data, isBinary) => {
            if (isBinary) return
            let msg
            try { msg = JSON.parse(data.toString()) } catch (e) { return refuse(ws, 'bad-json') }

            if (!ws.vj) {
                clearTimeout(helloTimer)
                if (!msg || msg.t !== 'hello') return refuse(ws, 'expected-hello')
                if (msg.role !== 'host' && msg.role !== 'deck') return refuse(ws, 'bad-role')
                if (!ROOM_RE.test(String(msg.room || ''))) return refuse(ws, 'bad-room')
                if (!TOKEN_RE.test(String(msg.token || ''))) return refuse(ws, 'bad-token')
                let room = rooms.get(msg.room)
                if (!room) {
                    // first client in binds the token; nobody can rebind it later
                    room = { token: msg.token, host: null, decks: new Map(), lastSeen: Date.now() }
                    rooms.set(msg.room, room)
                } else if (!timingSafeEq(room.token, msg.token)) {
                    return refuse(ws, 'unauthorized')
                }
                room.lastSeen = Date.now()
                const id = 'c' + (nextId++)
                ws.vj = { id, role: msg.role, roomId: msg.room, room }
                if (msg.role === 'host') {
                    if (room.host && room.host !== ws) {
                        refuse(room.host, 'replaced')
                    }
                    room.host = ws
                    send(ws, {
                        t: 'welcome', id, role: 'host',
                        hostPresent: true,
                        deckCount: room.decks.size,
                        persistedScenes: loadPersisted(msg.room),
                        ...(preview[ws.mode] ? { preview: preview[ws.mode] } : {})
                    })
                    room.decks.forEach((deck) => send(deck, { t: 'hostState', present: true }))
                    log(`host ${id} up in ${msg.room} (${room.decks.size} decks waiting)`)
                } else {
                    room.decks.set(id, ws)
                    send(ws, { t: 'welcome', id, role: 'deck', hostPresent: !!room.host })
                    send(room.host, { t: 'deckJoined', id })
                    log(`deck ${id} joined ${msg.room}`)
                }
                return
            }

            const { role, room, id } = ws.vj
            room.lastSeen = Date.now()
            if (role === 'host') {
                if (msg.t === 'cast') room.decks.forEach((deck) => send(deck, msg.msg))
                else if (msg.t === 'to') send(room.decks.get(msg.id), msg.msg)
                else if (msg.t === 'persist') persist(ws.vj.roomId, msg.scenes)
            } else {
                if (msg.t === 'intent') send(room.host, { t: 'intent', from: id, msg: msg.msg })
            }
        })

        ws.on('close', () => {
            clearTimeout(helloTimer)
            if (!ws.vj) return
            const { role, room, id } = ws.vj
            if (role === 'host') {
                if (room.host === ws) {
                    room.host = null
                    room.decks.forEach((deck) => send(deck, { t: 'hostState', present: false }))
                    log(`host ${id} left`)
                }
            } else if (room.decks.get(id) === ws) {
                room.decks.delete(id)
                send(room.host, { t: 'deckLeft', id })
                log(`deck ${id} left`)
            }
        })
        ws.on('error', () => { /* close follows */ })
    })

    const pinger = setInterval(() => {
        wss.clients.forEach((ws) => {
            if (ws.isAlive === false) return ws.terminate()
            ws.isAlive = false
            try { ws.ping() } catch (e) { /* dying socket */ }
        })
        const now = Date.now()
        rooms.forEach((room, id) => {
            if (!room.host && room.decks.size === 0 && now - room.lastSeen > ROOM_IDLE_DROP_MS) {
                rooms.delete(id) // scenes file stays on disk for the next show
            }
        })
    }, PING_INTERVAL_MS)
    wss.on('close', () => clearInterval(pinger))

    return {
        wss,
        rooms,
        stats: () => ({
            rooms: rooms.size,
            clients: wss.clients.size
        }),
        close: () => { clearInterval(pinger); wss.close() }
    }
}
