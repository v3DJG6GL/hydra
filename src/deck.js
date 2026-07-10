// Remote VJ deck bootstrap (deck.html): the full VJPanel rendered on this
// device, driving a hydra renderer elsewhere through the relay. Pairing
// credentials arrive in the URL fragment (#room=…&token=…) so they never
// show up in server logs; without them this page becomes the pairing screen.
import VJPanel from './panel/panel.js'
import RemoteHost from './panel/host-remote.js'
import { parseDeckHash, deckUrl, relayUrl } from './panel/wire.js'

const statusEl = document.getElementById('vj-remote-status')
const rootEl = document.getElementById('vj-remote-root')
const pairEl = document.getElementById('vj-remote-pair')
const toastsEl = document.getElementById('vj-remote-toasts')

const toast = (msg, kind) => {
    const t = document.createElement('div')
    t.className = 'vj-toast' + (kind === 'error' ? ' vj-toast-error' : '')
    t.textContent = msg
    toastsEl.appendChild(t)
    setTimeout(() => t.remove(), 4200)
}
window._reportError = (err) => toast((err && err.message) || String(err), 'error')

// keep the tablet awake mid-set (secure contexts only — WAN https or localhost)
if (navigator.wakeLock) {
    const grab = () => navigator.wakeLock.request('screen').catch(() => {})
    grab()
    document.addEventListener('visibilitychange', () => { if (!document.hidden) grab() })
}

const creds = parseDeckHash(location.hash)

// ---- pairing screens: "module face" — the pair page is a piece of deck
// hardware. Chassis + silkscreen labels, the QR in a patch-bay frame with
// the four output-tally colors as corner brackets, and the projector
// warning as a hazard-tape strip along the module's base.

const h = (tag, cls, text) => {
    const n = document.createElement(tag)
    if (cls) n.className = cls
    if (text !== undefined) n.textContent = text
    return n
}

// QR bay: white tile inside tally-colored corner brackets
function qrBay(url) {
    const bay = h('div', 'vj-pair-qrbay')
    const frame = h('div', 'vj-pair-qrframe')
    const tile = h('div', 'vj-pair-qrtile')
    tile.id = 'vj-pair-qr'
    frame.appendChild(tile)
    for (let i = 0; i < 4; i++) frame.appendChild(h('i'))
    bay.appendChild(frame)
    bay.appendChild(h('div', 'vj-pair-silk', 'SCAN ON THE DECK DEVICE'))
    renderQr(tile, url)
    return bay
}

function legacyCopy(input) {
    try {
        input.select()
        return document.execCommand('copy')
    } catch (e) { return false }
}

// mono URL field with an attached COPY button (clipboard API where the
// context is secure, hidden-selection execCommand on plain LAN http)
function linkRow(url) {
    const row = h('div', 'vj-pair-linkrow')
    const input = h('input', 'vj-pair-url')
    input.readOnly = true
    input.value = url
    input.onclick = () => input.select()
    const btn = h('button', 'vj-pair-copy', 'COPY')
    const done = (ok) => {
        btn.textContent = ok ? 'COPIED' : 'COPY FAILED'
        btn.classList.toggle('vj-pair-copied', ok)
        clearTimeout(btn._reset)
        btn._reset = setTimeout(() => {
            btn.textContent = 'COPY'
            btn.classList.remove('vj-pair-copied')
        }, 1400)
    }
    btn.onclick = () => {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(url).then(() => done(true), () => done(legacyCopy(input)))
        } else {
            done(legacyCopy(input))
        }
    }
    row.append(input, btn)
    return row
}

// one module for every pairing surface: a bay (QR or the manual form) next
// to the copy + actions column, hazard tape underneath
function pairModule({ error, bay, eyebrow, title, explainer, children = [] }) {
    const mod = h('div', 'vj-pair-module')
    if (error) mod.appendChild(h('div', 'vj-pair-errorbar', '⚠ ' + error))
    const body = h('div', 'vj-pair-body')
    body.appendChild(bay)
    const ctrl = h('div', 'vj-pair-ctrl')
    ctrl.appendChild(h('div', 'vj-pair-eyebrow', eyebrow))
    ctrl.appendChild(h('h1', 'vj-pair-title', title))
    ctrl.appendChild(h('p', 'vj-pair-expl', explainer))
    children.forEach((c) => ctrl.appendChild(c))
    body.appendChild(ctrl)
    mod.appendChild(body)
    const hz = h('div', 'vj-pair-hazard')
    hz.appendChild(h('span', 'vj-pair-hazard-glyph', '⚠'))
    hz.appendChild(h('span', null, 'KEEP THIS PAGE OFF THE PROJECTOR — THE LINK CARRIES FULL CONTROL'))
    mod.appendChild(hz)
    return mod
}

function showPairScreen(error) {
    statusEl.hidden = true
    rootEl.hidden = true
    pairEl.hidden = false
    pairEl.textContent = ''

    // same browser profile as a renderer tab? offer its pairing directly
    let localRoom = null
    let localToken = null
    try {
        localRoom = localStorage.getItem('hydra-vj-room')
        localToken = localStorage.getItem('hydra-vj-token')
    } catch (e) { /* private mode */ }

    const wrap = h('div', 'vj-pair-wrap')
    const rail = h('div', 'vj-pair-rail')
    rail.appendChild(h('span', 'vj-pair-brand', 'HYDRA VJ DECK'))
    rail.appendChild(h('span', 'vj-pair-railsep', '/'))
    rail.appendChild(h('span', 'vj-pair-railmode', 'PAIRING'))
    if (localRoom) rail.appendChild(h('span', 'vj-pair-railroom', 'ROOM ' + localRoom.slice(0, 8)))
    wrap.appendChild(rail)
    const stage = h('div', 'vj-pair-stage')

    let mod
    if (localRoom && localToken) {
        const url = deckUrl(location.origin, localRoom, localToken)
        const here = h('button', 'vj-pair-btn', 'OPEN THE DECK IN THIS WINDOW')
        here.onclick = () => { location.hash = 'room=' + localRoom + '&token=' + localToken; location.reload() }
        const rot = h('button', 'vj-pair-btn vj-pair-danger', 'ROTATE PAIRING — LOG OUT ALL DECKS')
        rot.title = 'forget these credentials; the renderer generates fresh ones on its next reload'
        rot.onclick = () => {
            if (!confirm('Invalidate this pairing? Every connected deck loses control until re-paired, and the hydra tab must be reloaded.')) return
            try {
                localStorage.removeItem('hydra-vj-room')
                localStorage.removeItem('hydra-vj-token')
            } catch (e) { /* private mode */ }
            location.reload()
        }
        mod = pairModule({
            error,
            bay: qrBay(url),
            eyebrow: 'PAIR A DECK',
            title: 'Control this renderer from a tablet or phone',
            explainer: 'Open this link on the device that will run the deck — scan the code, or copy the link across. Anyone with the link has full control of the visuals.',
            children: [linkRow(url), here, rot]
        })
    } else {
        // no pairing on this device: manual entry takes the QR bay's place
        const bay = h('div', 'vj-pair-qrbay')
        const form = h('form', 'vj-pair-form')
        const room = h('input', 'vj-pair-in')
        room.placeholder = 'room'
        const token = h('input', 'vj-pair-in')
        token.placeholder = 'token'
        const go = h('button', 'vj-pair-btn', 'CONNECT')
        form.append(room, token, go)
        form.onsubmit = (e) => {
            e.preventDefault()
            if (!room.value.trim() || !token.value.trim()) return
            location.hash = 'room=' + room.value.trim() + '&token=' + token.value.trim()
            location.reload()
        }
        bay.appendChild(form)
        bay.appendChild(h('div', 'vj-pair-silk', 'ENTER THE PAIRING BY HAND'))
        mod = pairModule({
            error,
            bay,
            eyebrow: 'PAIR A DECK',
            title: 'No pairing on this device yet',
            explainer: 'On the machine that runs the hydra visuals, open ' + location.origin +
                '/deck.html — it shows a QR code and link for this device. Or type the room and token by hand.'
        })
    }
    stage.appendChild(mod)
    wrap.appendChild(stage)
    pairEl.appendChild(wrap)
}

function renderQr(el, url) {
    import('./panel/qr.js')
        .then((m) => m.drawQr(el, url))
        .catch(() => { el.remove() })
}

function boot({ room, token }) {
    const state = {
        panel: { open: true, popup: false, pip: false },
        showCode: true,
        translation: null,
        editor: null,
        hydra: null
    }
    const host = new RemoteHost({ url: relayUrl(), room, token })
    // "pair another device": this deck shows its own pairing as a QR overlay
    host.requestPairUi = () => {
        const overlay = h('div', 'vj-remote-pair')
        const url = deckUrl(location.origin, room, token)
        const close = h('button', 'vj-pair-btn', 'CLOSE')
        close.onclick = () => overlay.remove()
        const stage = h('div', 'vj-pair-stage')
        stage.appendChild(pairModule({
            bay: qrBay(url),
            eyebrow: 'PAIR ANOTHER DEVICE',
            title: 'Enroll one more controller',
            explainer: 'Scan on the new device, or copy the link across — it gets the same full control of the renderer as this deck.',
            children: [linkRow(url), close]
        }))
        overlay.appendChild(stage)
        overlay.onclick = (e) => { if (e.target === overlay || e.target === stage) overlay.remove() }
        document.body.appendChild(overlay)
    }
    const panel = new VJPanel(state, () => {}, host)
    panel.remoteRoot = rootEl
    panel.attachSceneKeys(document)
    window.vjPanel = panel // console access, in hydra tradition
    // the ◉ LIVE preference persisted from an earlier session
    if (panel.previewOn) host.setPreview(true)

    const setStatus = () => {
        const cls = 'vj-remote-status'
        if (!host.connected) {
            statusEl.className = cls + ' vj-st-down'
            statusEl.textContent = 'relay unreachable — reconnecting…'
            statusEl.hidden = false
        } else if (!host.hostPresent) {
            statusEl.className = cls + ' vj-st-wait'
            statusEl.textContent = 'connected — waiting for the renderer (open hydra on the host machine)'
            statusEl.hidden = false
        } else {
            statusEl.className = cls + ' vj-st-up'
            statusEl.textContent = '● live'
            statusEl.hidden = false
            clearTimeout(setStatus._hide)
            setStatus._hide = setTimeout(() => { if (host.connected && host.hostPresent) statusEl.hidden = true }, 1500)
        }
    }
    setStatus()

    host.on('status', () => { setStatus(); panel.renderAll() })
    host.on('code-changed', (cause) => panel.onRemoteCode(cause))
    host.on('ui-changed', () => panel.renderAll())
    host.on('toast', toast)
    host.on('fatal', (code) => {
        if (code === 'unauthorized' || code === 'bad-token' || code === 'bad-room') {
            showPairScreen('pairing rejected (' + code + ') — the renderer may have rotated its token; re-pair below.')
        }
    })
    // 'scenes-changed' -> renderAll is wired inside the VJPanel constructor
}

if (creds) boot(creds)
else showPairScreen()
