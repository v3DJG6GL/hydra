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

function showPairScreen(error) {
    statusEl.hidden = true
    rootEl.hidden = true
    pairEl.hidden = false
    pairEl.textContent = ''
    const box = document.createElement('div')
    box.className = 'vj-pair-box'
    const h = document.createElement('h1')
    h.textContent = 'HYDRA VJ DECK — pair with a renderer'
    box.appendChild(h)
    if (error) {
        const e = document.createElement('p')
        e.className = 'vj-pair-error'
        e.textContent = error
        box.appendChild(e)
    }

    // same browser profile as a renderer tab? offer its pairing directly
    let localRoom = null
    let localToken = null
    try {
        localRoom = localStorage.getItem('hydra-vj-room')
        localToken = localStorage.getItem('hydra-vj-token')
    } catch (e) { /* private mode */ }
    if (localRoom && localToken) {
        const p = document.createElement('p')
        p.textContent = 'This browser runs a hydra renderer. Its deck URL (open on the tablet/laptop, or scan below):'
        box.appendChild(p)
        const url = deckUrl(location.origin, localRoom, localToken)
        const qr = document.createElement('div')
        qr.className = 'vj-pair-qr'
        qr.id = 'vj-pair-qr'
        box.appendChild(qr)
        const link = document.createElement('input')
        link.className = 'vj-pair-url'
        link.readOnly = true
        link.value = url
        link.onclick = () => { link.select(); try { navigator.clipboard.writeText(url) } catch (e) {} }
        box.appendChild(link)
        const here = document.createElement('button')
        here.className = 'vj-pair-connect'
        here.textContent = 'open the deck in this window'
        here.onclick = () => { location.hash = 'room=' + localRoom + '&token=' + localToken; location.reload() }
        box.appendChild(here)
        renderQr(qr, url)
    } else {
        const p = document.createElement('p')
        p.textContent = 'No pairing found. On the machine that runs the hydra visuals, open ' +
            location.origin + '/deck.html — it shows a QR code / link for this device. ' +
            'Never show that page on the projector: the link carries full control of the renderer.'
        box.appendChild(p)
        const form = document.createElement('form')
        form.className = 'vj-pair-form'
        const room = document.createElement('input')
        room.placeholder = 'room'
        const token = document.createElement('input')
        token.placeholder = 'token'
        const go = document.createElement('button')
        go.textContent = 'connect'
        form.append(room, token, go)
        form.onsubmit = (e) => {
            e.preventDefault()
            if (!room.value.trim() || !token.value.trim()) return
            location.hash = 'room=' + room.value.trim() + '&token=' + token.value.trim()
            location.reload()
        }
        box.appendChild(form)
    }
    pairEl.appendChild(box)
}

// QR placeholder until the pairing milestone wires a real encoder
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
