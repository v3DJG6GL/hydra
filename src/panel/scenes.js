// Scene banks: 8 localStorage slots holding {code, thumb, savedAt}.
// Thumbnails come from hydra's getScreenImage (captured inside the render
// tick, so never a blank frame from the non-preserved WebGL buffer).
const KEY = 'hydra-vj-scenes'
export const SLOT_COUNT = 8
const THUMB_W = 96
const THUMB_H = 54

export function loadScenes() {
    try {
        const arr = JSON.parse(localStorage.getItem(KEY))
        if (Array.isArray(arr)) {
            const out = arr.slice(0, SLOT_COUNT)
            while (out.length < SLOT_COUNT) out.push(null)
            return out
        }
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
