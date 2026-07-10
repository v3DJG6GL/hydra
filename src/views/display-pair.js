// Short-code display pairing (TV / projector kiosk). The display holds no
// credentials, so it asks the relay for a pairing session ({t:'hello',
// role:'pair'}) and shows the short-lived single-use code; the operator
// types it into an already-authenticated deck, which approves it, and the
// relay issues this display its own revocable token down THIS socket (the
// code cannot be redeemed from anywhere else). Showing the code on a
// projected screen is harmless by design — it grants nothing by itself and
// expires. See docs/remote-deck.md and server/relay.mjs.
//
// D-pad friendly: a TV WebView delivers remote keys as ArrowUp/Down/Left/
// Right/Enter KeyboardEvents. Enter confirms (when the deck asked for an
// on-TV confirm) or requests a fresh code once the current one expired.
import { relayUrl } from '../panel/wire.js'

const REQUEST_BACKOFF_MIN = 2000
const REQUEST_BACKOFF_MAX = 30000

export function startPairing({ onPaired }) {
    let ws = null
    let backoff = REQUEST_BACKOFF_MIN
    let phase = 'requesting' // requesting | code | confirm | expired | paired
    let code = ''
    let expiresAt = 0
    let approvedName = ''
    let countdownTimer = null
    let retryTimer = null
    let done = false

    // ---- overlay UI (self-contained styles: the pairing screen must render
    // even if the app css failed to load)

    let wrap = document.getElementById('vj-display-pair')
    if (wrap) wrap.remove()
    wrap = document.createElement('div')
    wrap.id = 'vj-display-pair'
    wrap.style.cssText = 'position:fixed;inset:0;z-index:9998;background:#050807;' +
        'display:flex;flex-direction:column;align-items:center;justify-content:center;' +
        'font-family:monospace;color:#dffff9;text-align:center;padding:5vh 5vw;'
    const eyebrow = mk('div', 'font-size:2vmin;letter-spacing:.35em;opacity:.6;margin-bottom:1.5vh;', 'HYDRA DISPLAY')
    const title = mk('div', 'font-size:2.6vmin;letter-spacing:.12em;margin-bottom:4vh;', 'PAIR THIS SCREEN')
    const codeEl = mk('div', 'font-size:11vmin;letter-spacing:.18em;font-weight:bold;' +
        'padding:2vh 4vw;border:2px solid #1f4;border-radius:1vmin;min-width:40vw;color:#5f8;', '····')
    const sub = mk('div', 'font-size:2.2vmin;opacity:.75;margin-top:3.5vh;max-width:70vw;line-height:1.6;',
        'connecting to the relay…')
    const foot = mk('div', 'font-size:1.8vmin;opacity:.45;margin-top:5vh;letter-spacing:.1em;',
        'this code grants nothing by itself — a paired deck must approve it')
    wrap.append(eyebrow, title, codeEl, sub, foot)
    document.body.appendChild(wrap)
    // choo morphs <body> on every render and clobbers foreign nodes — keep
    // the overlay mounted for as long as pairing is running
    const remount = setInterval(() => {
        if (done) return clearInterval(remount)
        if (!wrap.isConnected) document.body.appendChild(wrap)
    }, 400)

    function mk(tag, css, text) {
        const n = document.createElement(tag)
        n.style.cssText = css
        if (text) n.textContent = text
        return n
    }

    const grouped = (c) => c.length > 4 ? c.slice(0, 4) + '-' + c.slice(4) : c

    const render = () => {
        if (phase === 'requesting') {
            codeEl.textContent = '····'
            codeEl.style.opacity = '.35'
            sub.textContent = 'requesting a pairing code…'
        } else if (phase === 'code') {
            codeEl.textContent = grouped(code)
            codeEl.style.opacity = '1'
            const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000))
            sub.textContent = 'on a paired deck: toprail QR button → LINK A TV / DISPLAY → enter this code' +
                '   ·   expires in ' + Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0')
        } else if (phase === 'confirm') {
            codeEl.textContent = 'OK?'
            sub.textContent = 'approved by the deck' + (approvedName ? ' as "' + approvedName + '"' : '') +
                ' — press OK / ENTER on this screen to finish pairing'
        } else if (phase === 'expired') {
            codeEl.style.opacity = '.35'
            sub.textContent = 'code expired — press OK / ENTER for a fresh one'
        } else if (phase === 'paired') {
            codeEl.textContent = '✓'
            codeEl.style.opacity = '1'
            sub.textContent = 'paired' + (approvedName ? ' as "' + approvedName + '"' : '') + ' — connecting…'
        }
    }

    const onKey = (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        if (phase === 'confirm' && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ t: 'pairConfirm' }))
        } else if (phase === 'expired' || phase === 'requesting') {
            reconnectNow()
        }
    }
    document.addEventListener('keydown', onKey)

    // ---- relay pairing socket

    const cleanup = () => {
        done = true
        clearInterval(countdownTimer)
        clearTimeout(retryTimer)
        document.removeEventListener('keydown', onKey)
        if (ws) { try { ws.close() } catch (e) { /* dead */ } }
    }

    const reconnectNow = () => {
        clearTimeout(retryTimer)
        backoff = REQUEST_BACKOFF_MIN
        connect()
    }

    const scheduleRetry = () => {
        if (done) return
        phase = phase === 'code' || phase === 'confirm' ? 'expired' : phase
        render()
        clearTimeout(retryTimer)
        retryTimer = setTimeout(connect, backoff + Math.random() * 500)
        backoff = Math.min(backoff * 2, REQUEST_BACKOFF_MAX)
    }

    const connect = () => {
        if (done) return
        if (ws) { try { ws.close() } catch (e) { /* dead */ } }
        phase = 'requesting'
        render()
        try {
            ws = new WebSocket(relayUrl())
        } catch (e) {
            scheduleRetry()
            return
        }
        const sock = ws
        sock.onopen = () => sock.send(JSON.stringify({ t: 'hello', role: 'pair' }))
        sock.onmessage = (e) => {
            let msg
            try { msg = JSON.parse(e.data) } catch (err) { return }
            if (msg.t === 'pairCode') {
                phase = 'code'
                code = String(msg.code || '')
                // countdown is cosmetic — validity is enforced on the relay
                // clock alone (cheap TV boxes boot with a dead RTC)
                expiresAt = Date.now() + (msg.ttl || 600) * 1000
                backoff = REQUEST_BACKOFF_MIN
                clearInterval(countdownTimer)
                countdownTimer = setInterval(() => {
                    if (phase !== 'code') return
                    if (Date.now() >= expiresAt) {
                        phase = 'expired'
                        clearInterval(countdownTimer)
                    }
                    render()
                }, 1000)
                render()
            } else if (msg.t === 'pairApproved') {
                phase = 'confirm'
                approvedName = String(msg.name || '')
                render()
            } else if (msg.t === 'paired') {
                phase = 'paired'
                approvedName = String(msg.name || approvedName)
                render()
                cleanup()
                setTimeout(() => wrap.remove(), 900)
                onPaired({ room: msg.room, token: msg.token })
            } else if (msg.t === 'error') {
                // pair-expired / pair-limit / relay restart: fresh code
                scheduleRetry()
            }
        }
        sock.onclose = () => { if (!done && phase !== 'paired') scheduleRetry() }
        sock.onerror = () => { /* close follows */ }
    }

    connect()
    return { cancel: () => { cleanup(); wrap.remove() } }
}
