// Scene banks: localStorage slots holding {code, thumb, savedAt}. The bank
// grows on demand (the + tile appends a slot) but never shrinks below
// SLOT_COUNT, so the familiar 1-8 key row is always on screen.
// Thumbnails come from hydra's getScreenImage (captured inside the render
// tick, so never a blank frame from the non-preserved WebGL buffer).
const KEY = 'hydra-vj-scenes'
export const SLOT_COUNT = 8

export function normalizeScenes(arr) {
    const out = arr.map((s) => s && typeof s.code === 'string'
        ? {
            code: s.code,
            thumb: typeof s.thumb === 'string' ? s.thumb : null,
            savedAt: s.savedAt || Date.now(),
            cat: normalizeCat(s.cat)
        }
        : null)
    while (out.length < SLOT_COUNT) out.push(null)
    return out
}

// shortcut groups: a scene may belong to one group 1-9; ctrl+shift+<digit>
// recalls a random scene from that group (see panel.randomSceneCat)
export function normalizeCat(cat) {
    const n = typeof cat === 'string' ? parseInt(cat, 10) : cat
    return Number.isInteger(n) && n >= 1 && n <= 9 ? n : null
}
const THUMB_W = 96
const THUMB_H = 54

export function loadScenes() {
    try {
        const arr = JSON.parse(localStorage.getItem(KEY))
        if (Array.isArray(arr)) return normalizeScenes(arr)
    } catch (e) { /* corrupted storage -> fresh bank */ }
    return new Array(SLOT_COUNT).fill(null)
}

export function saveScenes(scenes) {
    try {
        localStorage.setItem(KEY, JSON.stringify(scenes))
    } catch (e) {
        console.warn('vj panel: could not persist scenes', e)
    }
}

const CYCLE_KEY = 'hydra-vj-cycle-secs'

export function loadCycleSecs() {
    try {
        const v = parseFloat(localStorage.getItem(CYCLE_KEY))
        if (isFinite(v) && v >= 1 && v <= 3600) return v
    } catch (e) { /* fall through to default */ }
    return 8
}

export function saveCycleSecs(secs) {
    try {
        localStorage.setItem(CYCLE_KEY, String(secs))
    } catch (e) { /* non-fatal */ }
}

const CYCLE_RANDOM_KEY = 'hydra-vj-cycle-random'

export function loadCycleRandom() {
    try {
        return localStorage.getItem(CYCLE_RANDOM_KEY) === '1'
    } catch (e) { return false }
}

export function saveCycleRandom(on) {
    try {
        localStorage.setItem(CYCLE_RANDOM_KEY, on ? '1' : '0')
    } catch (e) { /* non-fatal */ }
}

// ---- hotkey cooldown: minimum seconds between "performance" hotkey triggers
// (random scene / random change), so a mashed key can't strobe the output.
// 0 = off. Per-device (localStorage); a ?cooldown=N URL param seeds it, which
// is how a TV kiosk gets configured (append it to the server URL once).

// each action kind ('scene', 'randomize') has its own duration and timer
export const COOLDOWN_KINDS = ['scene', 'randomize']
const cooldownKey = (kind) => 'hydra-vj-hotkey-cooldown-' + kind
const LEGACY_COOLDOWN_KEY = 'hydra-vj-hotkey-cooldown' // pre-split shared value

const validSecs = (raw) => {
    const v = parseFloat(raw)
    return isFinite(v) && v >= 0 && v <= 3600 ? v : null
}

try {
    const params = new URLSearchParams(window.location.search)
    // ?cooldown=N seeds both kinds; ?cooldownScene= / ?cooldownRandom= one each
    const seed = { scene: params.get('cooldownScene'), randomize: params.get('cooldownRandom') }
    const both = params.get('cooldown')
    COOLDOWN_KINDS.forEach((kind) => {
        const v = validSecs(seed[kind] !== null ? seed[kind] : both)
        if (v !== null) localStorage.setItem(cooldownKey(kind), String(v))
    })
} catch (e) { /* no window / private mode */ }

export function loadCooldownSecs(kind) {
    try {
        const v = validSecs(localStorage.getItem(cooldownKey(kind)))
        if (v !== null) return v
        const legacy = validSecs(localStorage.getItem(LEGACY_COOLDOWN_KEY))
        if (legacy !== null) return legacy
    } catch (e) { /* fall through to default */ }
    return 0
}

export function saveCooldownSecs(kind, secs) {
    if (!COOLDOWN_KINDS.includes(kind)) return
    try {
        localStorage.setItem(cooldownKey(kind), String(secs))
    } catch (e) { /* non-fatal */ }
}

// reads the setting on every call so config changes (deck popover, remote
// op) apply immediately
const lastTrigger = {}
export function cooldownGate(kind) {
    const secs = loadCooldownSecs(kind)
    if (secs <= 0) return true
    const t = Date.now()
    if (lastTrigger[kind] && t - lastTrigger[kind] < secs * 1000) return false
    lastTrigger[kind] = t
    return true
}

export function captureThumb(hydra, cb) {
    if (!hydra || typeof hydra.getScreenImage !== 'function') return cb(null)
    let done = false
    const finish = (thumb) => { if (!done) { done = true; cb(thumb) } }
    // getScreenImage only fires on the next tick; don't hang if rendering
    // stalls (3s covers a cold software-rendered first capture)
    const timeout = setTimeout(() => finish(null), 3000)
    try {
        hydra.getScreenImage((blob) => {
            clearTimeout(timeout)
            if (!blob) return finish(null)
            const url = URL.createObjectURL(blob)
            const img = new Image()
            img.onload = () => {
                try {
                    const c = document.createElement('canvas')
                    c.width = THUMB_W
                    c.height = THUMB_H
                    c.getContext('2d').drawImage(img, 0, 0, THUMB_W, THUMB_H)
                    finish(c.toDataURL('image/jpeg', 0.7))
                } catch (e) {
                    finish(null)
                } finally {
                    URL.revokeObjectURL(url)
                }
            }
            img.onerror = () => { URL.revokeObjectURL(url); finish(null) }
            img.src = url
        })
    } catch (e) {
        clearTimeout(timeout)
        finish(null)
    }
}
