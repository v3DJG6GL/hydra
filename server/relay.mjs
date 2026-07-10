// WebSocket relay for the remote VJ deck (docs/remote-deck-plan.md).
//
// A dumb, host-authoritative pipe: it never interprets deck intents or host
// state — it authenticates sockets into rooms and forwards messages. The only
// state it owns is per-room persistence (scene bank + pairing material) as
// one JSON file per room, and the short-code pairing sessions (in-memory,
// deliberately lost on restart).
//
// Wire protocol (JSON text frames):
//   first frame (within HELLO_TIMEOUT):
//     {t:'hello', role:'host'|'deck', room, token, build?}
//     {t:'hello', role:'pair'}                     display pairing, no creds
//   relay replies {t:'welcome', id, role, scope, caps, hostPresent,
//     persistedScenes?, preview?} (persistedScenes/preview only to the host —
//     preview carries the HYDRA_PREVIEW_* budget overrides, see below) or
//     closes with {t:'error', code}.
//   host -> relay:  {t:'cast', msg}         broadcast msg to every deck
//                   {t:'to', id, msg}       send msg to one deck
//                   {t:'persist', scenes}   store the scene bank
//   deck -> relay:  {t:'intent', msg}       forwarded to the host as
//                                           {t:'intent', from, msg}
//                   {t:'pairApprove', code, name?, requireConfirm?, reqId}
//                   {t:'displayList', reqId}
//                   {t:'displayRevoke', id, reqId}
//                   {t:'displayRename', id, name, reqId}
//   relay -> host:  {t:'deckJoined'|'deckLeft', id}
//   relay -> deck:  {t:'hostState', present}
//                   {t:'pairResult', reqId, ok, state?|error?, display?}
//                   {t:'pairEvent', code:'linked'|'confirm-timeout', display?}
//                   {t:'displays', reqId, displays:[…]}
//   pairing socket: relay -> {t:'pairCode', code, ttl}
//                   relay -> {t:'pairApproved', name}   (require-confirm only)
//                   pair  -> {t:'pairConfirm'}
//                   relay -> {t:'paired', room, token, id, name}
//   a second host hello takes the room over; the old socket gets
//   {t:'error', code:'replaced'} and is closed (newest host wins — that is
//   how a reloaded kiosk recovers before the dead socket times out).
//
// Security model: the control channel is remote code execution BY DESIGN, so
// joining requires the unguessable room id AND a valid token (the room token,
// bound trust-on-first-use and persisted as a sha256 hash so a relay restart
// can't be used to re-bind it; or a per-display token issued by the pairing
// flow, individually revocable, host-role-only). All comparisons are
// constant-time; display tokens are scanned in full with no early exit.
// Pairing codes are single-use, expire on the RELAY clock only, and the
// issued token travels once, down the same socket that displayed the code —
// a code photographed off a projector screen redeems nothing. Handshakes are
// rate-limited per IP (and code verification separately, tighter), sockets
// that don't hello in time are dropped, and the Origin header must match the
// request Host unless HYDRA_RELAY_ALLOWED_ORIGINS says otherwise.
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

// display pairing (docs/remote-deck.md). Crockford base32: no I/L/O/U, so a
// code read off a screen types unambiguously on a phone keyboard.
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const PAIR_CODE_LEN = 8
const PAIR_TTL_MS = 10 * 60 * 1000
const PAIR_CONFIRM_TTL_MS = 60 * 1000
const PAIR_MAX_PER_IP = 3
const PAIR_MAX_GLOBAL = 32
const PAIR_VERIFY_PER_MIN = 5
const CAPS = ['pair', 'fft2', 'diag'] // feature detection for mixed-version clients

const sha256hex = (s) => crypto.createHash('sha256').update(String(s)).digest('hex')

const timingSafeEq = (a, b) => {
    const ha = crypto.createHash('sha256').update(String(a)).digest()
    const hb = crypto.createHash('sha256').update(String(b)).digest()
    return crypto.timingSafeEqual(ha, hb)
}

// presented token vs stored sha256 hex — both sides become 32-byte digests
const tokenMatchesHash = (token, hexHash) => {
    if (typeof hexHash !== 'string' || hexHash.length !== 64) return false
    try {
        return crypto.timingSafeEqual(
            crypto.createHash('sha256').update(String(token)).digest(),
            Buffer.from(hexHash, 'hex')
        )
    } catch (e) { return false }
}

// user-typed codes: uppercase, strip separators, map the glyphs Crockford
// base32 deliberately excludes onto their look-alikes
const canonCode = (raw) => String(raw || '')
    .toUpperCase().replace(/[\s-]/g, '')
    .replace(/[IL]/g, '1').replace(/O/g, '0')

const newPairCode = () => {
    const bytes = crypto.randomBytes(PAIR_CODE_LEN)
    let code = ''
    for (let i = 0; i < PAIR_CODE_LEN; i++) code += CODE_ALPHABET[bytes[i] % 32]
    return code
}

const newDisplayToken = () => crypto.randomBytes(24).toString('base64url')

const cleanName = (raw) => String(raw || 'display')
    .replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) || 'display'

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

    // roomId -> {tokenHash, displays, host, decks: Map<id, ws>, lastSeen}
    const rooms = new Map()
    const handshakes = new Map() // ip -> {count, resetAt}
    const pairVerifies = new Map() // ip -> {count, resetAt} — code guessing, tighter
    const pairSessions = new Map() // canonical code -> session
    let nextId = 1

    // ---- per-room persistence: one JSON file, schema v2
    //   {v:2, scenes, savedAt, roomTokenHash, displays:[{id, name, tokenHash,
    //    scope:'display', createdAt, createdBy, lastSeenAt}]}
    // v1 files ({scenes, savedAt}) load with the new fields defaulted. Raw
    // tokens never touch the disk; scenes stay plaintext as before.

    const roomFile = (roomId) => path.join(dataDir, roomId + '.json')
    const loadRoomFile = (roomId) => {
        try {
            const parsed = JSON.parse(fs.readFileSync(roomFile(roomId), 'utf8'))
            return parsed && typeof parsed === 'object' ? parsed : null
        } catch (e) { return null }
    }
    // read-merge-write so scene persists never clobber pairing material and
    // vice versa (the two write paths are independent)
    const saveRoomFile = (roomId, mut) => {
        try {
            const f = loadRoomFile(roomId) || {}
            f.v = 2
            mut(f)
            fs.writeFileSync(roomFile(roomId), JSON.stringify(f))
        } catch (e) { log('persist failed', e.message) }
    }

    const getRoom = (roomId) => {
        let room = rooms.get(roomId)
        if (!room) {
            const f = loadRoomFile(roomId)
            room = {
                tokenHash: (f && typeof f.roomTokenHash === 'string') ? f.roomTokenHash : null,
                displays: (f && Array.isArray(f.displays)) ? f.displays : [],
                host: null,
                decks: new Map(),
                lastSeen: Date.now()
            }
            rooms.set(roomId, room)
        }
        return room
    }

    const loadPersistedScenes = (roomId) => {
        const f = loadRoomFile(roomId)
        return f && Array.isArray(f.scenes) ? f.scenes : null
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

    const bumpRate = (map, ip, perMin) => {
        const now = Date.now()
        let entry = map.get(ip)
        if (!entry || now > entry.resetAt) {
            entry = { count: 0, resetAt: now + 60000 }
            map.set(ip, entry)
        }
        entry.count++
        return entry.count <= perMin
    }

    const send = (ws, obj) => {
        if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj))
    }
    const refuse = (ws, code) => {
        send(ws, { t: 'error', code })
        ws.close(4000, code)
    }

    // ---- display pairing sessions (memory only — a relay restart voids
    // every outstanding code, nothing dangles)

    const pendingPerIp = (ip) => {
        let n = 0
        pairSessions.forEach((s) => { if (s.ip === ip) n++ })
        return n
    }

    const dropSession = (session) => {
        clearTimeout(session.expireTimer)
        clearTimeout(session.confirmTimer)
        if (pairSessions.get(session.code) === session) pairSessions.delete(session.code)
    }

    const startPairSession = (ws, ip) => {
        if (pairSessions.size >= PAIR_MAX_GLOBAL || pendingPerIp(ip) >= PAIR_MAX_PER_IP) {
            return refuse(ws, 'pair-limit')
        }
        let code = newPairCode()
        while (pairSessions.has(code)) code = newPairCode() // vanishing odds, cheap
        const session = {
            code, ws, ip,
            state: 'pending', // -> approved (require-confirm) -> issued
            roomId: null, name: null, requireConfirm: false,
            approverWs: null, approveReqId: null,
            displayId: null,
            expireTimer: null, confirmTimer: null
        }
        session.expireTimer = setTimeout(() => {
            dropSession(session)
            refuse(ws, 'pair-expired') // the display shows "press OK for a fresh code"
        }, PAIR_TTL_MS)
        pairSessions.set(code, session)
        ws.vj = { role: 'pair', session }
        send(ws, { t: 'pairCode', code, ttl: Math.round(PAIR_TTL_MS / 1000) })
        log(`pair session opened (${pairSessions.size} pending)`)
    }

    // the issued token travels exactly once, down the pairing socket that
    // displayed the code — approval from a deck cannot be replayed elsewhere
    const issueDisplay = (session) => {
        const token = newDisplayToken()
        const entry = {
            id: session.displayId,
            name: session.name,
            tokenHash: sha256hex(token),
            scope: 'display',
            createdAt: Date.now(),
            createdBy: session.approvedById || null,
            lastSeenAt: null
        }
        const room = getRoom(session.roomId)
        room.displays.push(entry)
        saveRoomFile(session.roomId, (f) => {
            f.displays = room.displays
            if (room.tokenHash) f.roomTokenHash = room.tokenHash
        })
        session.state = 'issued'
        send(session.ws, { t: 'paired', room: session.roomId, token, id: entry.id, name: entry.name })
        try { session.ws.close(1000, 'paired') } catch (e) { /* already gone */ }
        send(session.approverWs, {
            t: 'pairEvent', code: 'linked',
            display: { id: entry.id, name: entry.name, createdAt: entry.createdAt }
        })
        dropSession(session)
        log(`display ${entry.id} paired into ${session.roomId}`)
    }

    const displayRows = (room) => room.displays.map((d) => ({
        id: d.id,
        name: d.name,
        createdAt: d.createdAt,
        lastSeenAt: d.lastSeenAt,
        connected: !!(room.host && room.host.vj && room.host.vj.displayId === d.id)
    }))

    // ---- deck-side pairing/management frames (the only relay-level policy
    // beyond auth — everything else stays a dumb pipe)

    const handleDeckRelayFrame = (ws, msg) => {
        const { room, roomId, id } = ws.vj
        if (msg.t === 'pairApprove') {
            if (!bumpRate(pairVerifies, ws.ip, PAIR_VERIFY_PER_MIN)) {
                return send(ws, { t: 'pairResult', reqId: msg.reqId, ok: false, error: 'rate-limited' })
            }
            const session = pairSessions.get(canonCode(msg.code))
            // one uniform failure for expired/unknown/already-used — a code
            // guesser learns nothing about which codes ever existed
            if (!session || session.state !== 'pending' || session.ws.readyState !== session.ws.OPEN) {
                return send(ws, { t: 'pairResult', reqId: msg.reqId, ok: false, error: 'code-unknown' })
            }
            pairSessions.delete(session.code) // single-use: gone at approval
            session.roomId = roomId // the approving deck's room — never typed
            session.name = cleanName(msg.name)
            session.displayId = 'd' + crypto.randomBytes(4).toString('hex')
            session.approverWs = ws
            session.approvedById = id
            session.requireConfirm = !!msg.requireConfirm
            if (session.requireConfirm) {
                session.state = 'approved'
                clearTimeout(session.expireTimer)
                session.confirmTimer = setTimeout(() => {
                    send(ws, { t: 'pairEvent', code: 'confirm-timeout', display: { id: session.displayId, name: session.name } })
                    dropSession(session)
                    refuse(session.ws, 'confirm-timeout')
                }, PAIR_CONFIRM_TTL_MS)
                send(session.ws, { t: 'pairApproved', name: session.name })
                send(ws, {
                    t: 'pairResult', reqId: msg.reqId, ok: true, state: 'awaiting-confirm',
                    display: { id: session.displayId, name: session.name }
                })
            } else {
                issueDisplay(session)
                send(ws, {
                    t: 'pairResult', reqId: msg.reqId, ok: true, state: 'linked',
                    display: { id: session.displayId, name: session.name }
                })
            }
            return true
        }
        if (msg.t === 'displayList') {
            send(ws, { t: 'displays', reqId: msg.reqId, displays: displayRows(room) })
            return true
        }
        if (msg.t === 'displayRevoke') {
            const before = room.displays.length
            room.displays = room.displays.filter((d) => d.id !== msg.id)
            if (room.displays.length !== before) {
                saveRoomFile(roomId, (f) => { f.displays = room.displays })
                if (room.host && room.host.vj && room.host.vj.displayId === msg.id) {
                    refuse(room.host, 'revoked') // close handler clears room.host
                }
                log(`display ${msg.id} revoked from ${roomId}`)
            }
            send(ws, { t: 'displays', reqId: msg.reqId, displays: displayRows(room) })
            return true
        }
        if (msg.t === 'displayRename') {
            const d = room.displays.find((x) => x.id === msg.id)
            if (d) {
                d.name = cleanName(msg.name)
                saveRoomFile(roomId, (f) => { f.displays = room.displays })
            }
            send(ws, { t: 'displays', reqId: msg.reqId, displays: displayRows(room) })
            return true
        }
        return false
    }

    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD })

    httpServer.on('upgrade', (req, socket, head) => {
        let pathname = ''
        try { pathname = new URL(req.url, 'http://x').pathname } catch (e) { /* fall through */ }
        if (pathname !== wsPath) return // vite HMR & friends keep their own upgrades
        const ip = (req.socket.remoteAddress || 'unknown')
        if (!bumpRate(handshakes, ip, HANDSHAKES_PER_MIN)) { socket.destroy(); return }
        if (!originOk(req)) { socket.destroy(); return }
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
    })

    wss.on('connection', (ws, req) => {
        ws.isAlive = true
        ws.on('pong', () => { ws.isAlive = true })
        ws.vj = null // set after a valid hello
        ws.ip = (req && req.socket && req.socket.remoteAddress) || 'unknown'
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
                if (msg.role === 'pair') return startPairSession(ws, ws.ip)
                if (msg.role !== 'host' && msg.role !== 'deck') return refuse(ws, 'bad-role')
                if (!ROOM_RE.test(String(msg.room || ''))) return refuse(ws, 'bad-room')
                if (!TOKEN_RE.test(String(msg.token || ''))) return refuse(ws, 'bad-token')
                const room = getRoom(msg.room)

                // display tokens first: constant-time scan of EVERY entry (no
                // early exit — the scan time never says which slot matched)
                let display = null
                for (const d of room.displays) {
                    const hit = tokenMatchesHash(msg.token, d.tokenHash)
                    if (hit && !display) display = d
                }
                let scope
                if (display) {
                    // display credentials render, they never control
                    if (msg.role !== 'host') return refuse(ws, 'unauthorized')
                    scope = 'display'
                    display.lastSeenAt = Date.now()
                    saveRoomFile(msg.room, (f) => { f.displays = room.displays })
                } else if (room.tokenHash) {
                    if (!tokenMatchesHash(msg.token, room.tokenHash)) return refuse(ws, 'unauthorized')
                    scope = 'room'
                } else {
                    // first client in binds the token; persisting the hash
                    // means a relay restart can't be used to re-bind it
                    room.tokenHash = sha256hex(msg.token)
                    saveRoomFile(msg.room, (f) => { f.roomTokenHash = room.tokenHash })
                    scope = 'room'
                }

                room.lastSeen = Date.now()
                const id = 'c' + (nextId++)
                ws.vj = { id, role: msg.role, roomId: msg.room, room, scope, displayId: display ? display.id : null }
                if (msg.role === 'host') {
                    if (room.host && room.host !== ws) {
                        refuse(room.host, 'replaced')
                    }
                    room.host = ws
                    send(ws, {
                        t: 'welcome', id, role: 'host', scope, caps: CAPS,
                        hostPresent: true,
                        deckCount: room.decks.size,
                        persistedScenes: loadPersistedScenes(msg.room),
                        ...(preview[ws.mode] ? { preview: preview[ws.mode] } : {})
                    })
                    room.decks.forEach((deck) => send(deck, { t: 'hostState', present: true }))
                    log(`host ${id} up in ${msg.room} (${scope}, ${room.decks.size} decks waiting)`)
                } else {
                    room.decks.set(id, ws)
                    send(ws, { t: 'welcome', id, role: 'deck', scope, caps: CAPS, hostPresent: !!room.host })
                    send(room.host, { t: 'deckJoined', id })
                    log(`deck ${id} joined ${msg.room}`)
                }
                return
            }

            const { role, room } = ws.vj
            if (role === 'pair') {
                const session = ws.vj.session
                if (msg.t === 'pairConfirm' && session && session.state === 'approved') issueDisplay(session)
                return
            }
            room.lastSeen = Date.now()
            if (role === 'host') {
                if (msg.t === 'cast') room.decks.forEach((deck) => send(deck, msg.msg))
                else if (msg.t === 'to') send(room.decks.get(msg.id), msg.msg)
                else if (msg.t === 'persist') {
                    if (Array.isArray(msg.scenes)) {
                        saveRoomFile(ws.vj.roomId, (f) => {
                            f.scenes = msg.scenes
                            f.savedAt = Date.now()
                        })
                    }
                }
            } else {
                if (msg.t === 'intent') send(room.host, { t: 'intent', from: ws.vj.id, msg: msg.msg })
                else handleDeckRelayFrame(ws, msg)
            }
        })

        ws.on('close', () => {
            clearTimeout(helloTimer)
            if (!ws.vj) return
            if (ws.vj.role === 'pair') {
                // an abandoned session leaves no trace (token issued at
                // 'issued' only, and that state already dropped the session)
                if (ws.vj.session) dropSession(ws.vj.session)
                return
            }
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
                rooms.delete(id) // the room file stays on disk for the next show
            }
        })
    }, PING_INTERVAL_MS)
    wss.on('close', () => clearInterval(pinger))

    return {
        wss,
        rooms,
        stats: () => ({
            rooms: rooms.size,
            clients: wss.clients.size,
            pairing: pairSessions.size
        }),
        close: () => { clearInterval(pinger); wss.close() }
    }
}
