// One capture at a time. hydra-synth holds a SINGLE imageCallback slot:
// getScreenImage(cb) arms it, the next tick encodes the canvas via toBlob,
// and canvasToImage delivers the blob to the callback — or, if the slot is
// empty, DOWNLOADS the frame as a PNG (<a download> click, the screencap()
// feature). Two overlapping captures — the deck preview's frame loop plus a
// scene-save thumbnail — race exactly into that branch: the second arm
// overwrites the slot, the first blob consumes-and-clears it, and the second
// blob finds it empty → a surprise "save file" dialog on the renderer.
// Every capture goes through here instead: one getScreenImage in flight,
// concurrent requests share its frame.
const state = new WeakMap() // hydra -> {waiting: [cb…], busy}

export function captureFrame(hydra, cb) {
    if (!hydra || typeof hydra.getScreenImage !== 'function') return cb(null)
    let s = state.get(hydra)
    if (!s) {
        s = { waiting: [], busy: false }
        state.set(hydra, s)
    }
    s.waiting.push(cb)
    if (!s.busy) pump(hydra, s)
}

function flush(s, blob) {
    const list = s.waiting.splice(0)
    for (const fn of list) {
        try { fn(blob) } catch (e) { console.warn('vj capture callback failed', e) }
    }
}

function pump(hydra, s) {
    s.busy = true
    let delivered = false
    // rendering can stall (cold start, lost context): answer waiters with
    // null after 3s so thumbnails/frames don't hang — but keep the slot
    // LATCHED, because arming a second capture while the first blob is
    // still encoding is precisely what triggers the download branch. The
    // latch only lifts when the callback truly fires, or after 10s when
    // the frame is clearly never coming.
    const answer = setTimeout(() => flush(s, null), 3000)
    const unlatch = setTimeout(() => {
        if (delivered) return
        delivered = true
        s.busy = false
        if (s.waiting.length) pump(hydra, s)
    }, 10000)
    const settle = (blob) => {
        if (delivered) return
        delivered = true
        clearTimeout(answer)
        clearTimeout(unlatch)
        flush(s, blob)
        if (s.waiting.length) pump(hydra, s)
        else s.busy = false
    }
    try {
        hydra.getScreenImage((blob) => settle(blob || null))
    } catch (e) {
        settle(null)
    }
}
