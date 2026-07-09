// Shared bits of the deck<->host wire protocol (see server/relay.mjs for the
// relay envelope). Both sides hash the code text they believe they're editing
// so a splice from a stale deck is rejected instead of misapplied.

export function codeHash(s) {
    let h = 5381
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
    return h
}

// ws:// on plain-http (LAN mode), wss:// on https (WAN mode) — same build
export function relayUrl(loc) {
    const l = loc || window.location
    return (l.protocol === 'https:' ? 'wss://' : 'ws://') + l.host + '/ws'
}

export function randomId(bytes) {
    const arr = new Uint8Array(bytes)
    crypto.getRandomValues(arr)
    // base64url without padding — matches the relay's [A-Za-z0-9_-] rule
    return btoa(String.fromCharCode(...arr)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// deck page URL for a given pairing (creds live in the FRAGMENT so they never
// reach server logs)
export function deckUrl(origin, room, token) {
    return origin + '/deck.html#room=' + room + '&token=' + token
}

export function parseDeckHash(hash) {
    const p = new URLSearchParams((hash || '').replace(/^#/, ''))
    const room = p.get('room')
    const token = p.get('token')
    return room && token ? { room, token, pair: p.get('pair') === '1' } : null
}
