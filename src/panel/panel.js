// The VJ deck controller + host-agnostic renderer. One instance owns the sketch
// model and renders into any number of hosts (the in-page dock, the pop-out
// window) as plain DOM — deliberately NOT routed through choo's app-wide
// morphing so 60Hz fader gestures never re-render the app.
//
// Everything that touches the sketch or the synth goes through `this.host`
// (a host adapter): host-local.js in the main tab and its same-context
// popup/PiP children, host-remote.js on a deck running on another device.
import { buildModel, freeOutput } from './sketch-model.js'
import { grouped, fmtNumber, fmtShort, INT_PARAMS } from './metadata.js'
import { edits } from './patcher.js'
import LocalHost from './host-local.js'
import MidiControl from './midi.js'
import { loadCycleSecs, saveCycleSecs, SLOT_COUNT } from './scenes.js'
import { openPopup, STYLE_MATCH } from './popup.js'

const CHANNEL_CLASS = { o0: 'ch-o0', o1: 'ch-o1', o2: 'ch-o2', o3: 'ch-o3' }
const TAG_ICONS = { fn: 'ƒ', array: '[ ]', time: '◷', mouse: '☩', audio: '∿', math: 'π' }
const SOURCE_FNS = { initCam: 'camera', initScreen: 'screen', initVideo: 'video', initImage: 'image' }

// a.setX(n) audio settings; def doubles as the insert value and the fader's mid-track anchor
const AUDIO_SETTINGS = {
    setSmooth: { label: 'smooth', def: 0.4 },
    setScale: { label: 'scale', def: 10 },
    setBins: { label: 'bins', def: 4, int: true },
    setCutoff: { label: 'cutoff', def: 2 }
}
// easing names hydra-synth's array interpolation understands
const EASINGS = [
    'linear', 'sin',
    'easeInQuad', 'easeOutQuad', 'easeInOutQuad',
    'easeInCubic', 'easeOutCubic', 'easeInOutCubic',
    'easeInQuart', 'easeOutQuart', 'easeInOutQuart',
    'easeInQuint', 'easeOutQuint', 'easeInOutQuint'
]

function el(d, tag, cls, text) {
    const e = d.createElement(tag)
    if (cls) e.className = cls
    if (text != null) e.textContent = text
    return e
}

export default class VJPanel {
    constructor(state, emit, host = null) {
        this.state = state
        this.emit = emit
        this.host = host || new LocalHost(state, emit)
        this.host.bind(this)
        this.host.on('scenes-changed', () => this.renderAll())
        this.cycle = { on: false, timer: null, secs: loadCycleSecs(), pos: -1 }
        this.midi = new MidiControl(this)
        this.fftShown = false
        // knobs mapped in an earlier session should work without re-arming
        if (this.midi.hasMappings()) this.midi.enable()
        this.model = null
        this.outOfSync = false
        this.parseError = null
        this.transforms = this.host.getTransforms()
        let previewPref = null
        try { previewPref = localStorage.getItem('hydra-vj-preview') } catch (e) { /* private mode */ }
        this.previewOn = previewPref === '1'
        this.dockRoot = null
        this.popupWin = null
        this.popupRoot = null
        this.pipWin = null
        this.pipRoot = null
        this.remoteRoot = null // set by the remote deck bootstrap
    }

    get lb() {
        return this.host.lb
    }

    get scenes() {
        return this.host.scenes
    }

    tr(key, fallback) {
        try {
            const v = this.state.translation.t(key)
            return v && v !== key ? v : fallback
        } catch (e) { return fallback }
    }

    ctx() {
        return this.host.ctx()
    }

    apply(edit, opts) {
        return this.host.applyEdit(edit, opts)
    }

    // text-only commit for values already live on screen (uniform or global)
    applyQuiet(edit) {
        return this.host.applyQuietEdit(edit)
    }

    historyStep(dir) {
        this.host.historyStep(dir)
        this.rebuild()
    }

    // Both random actions collapse the editor's multi-event history writes so
    // ONE deck undo press restores the previous sketch (see host runRandom).
    deckShuffle() {
        const oldModel = this.model
        this.host.runRandom('shuffle')
        this.afterHostAction(oldModel)
    }

    deckMutate(changeTransform) {
        if (this.outOfSync) return
        const oldModel = this.model
        this.host.runRandom('mutate', changeTransform)
        this.afterHostAction(oldModel)
    }

    // a local host has already applied the action when the call returns; a
    // remote host applies asynchronously and onRemoteCode does this instead
    afterHostAction(oldModel) {
        if (this.host.remote) return
        this.rebuild()
        this.flashChangedParams(oldModel)
    }

    // authoritative code arrived over the wire (remote decks only)
    onRemoteCode(cause) {
        const oldModel = this.model
        this.rebuild()
        if (cause === 'random') this.flashChangedParams(oldModel)
    }

    // pulse the rows a random action just hit, so the operator sees WHAT the
    // dice changed. A literal glitch moves exactly one value; a transform swap
    // renames paths, so its freshly-appeared args are flashed instead. After a
    // shuffle (everything different) the size guard keeps the deck calm.
    flashChangedParams(oldModel) {
        if (!oldModel || !oldModel.ok || this.outOfSync || !this.model || !this.model.ok) return
        const changed = []
        for (const [path, arg] of this.model.pathIndex) {
            if (!arg || arg.kind !== 'number') continue
            const prev = oldModel.pathIndex.get(path)
            if (prev && prev.kind === 'number' && prev.value !== arg.value) changed.push(path)
        }
        if (!changed.length) {
            for (const path of this.model.pathIndex.keys()) {
                if (!oldModel.pathIndex.has(path)) changed.push(path)
            }
        }
        if (!changed.length || changed.length > 6) return
        changed.forEach((path) => {
            const sel = `[data-path="${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`
            ;[this.dockRoot, this.popupRoot, this.pipRoot, this.remoteRoot].forEach((root) => {
                if (!root) return
                const rowEl = root.querySelector(sel)
                if (!rowEl) return
                rowEl.classList.add('vj-flash')
                setTimeout(() => rowEl.classList.remove('vj-flash'), 1300)
            })
        })
    }

    rebuild() {
        if (!this.host.hasBuffer()) return
        this.transforms = this.host.getTransforms()
        const res = buildModel(this.host.getCode(), this.transforms)
        if (res.ok) {
            this.model = res
            this.outOfSync = false
            this.parseError = null
        } else {
            this.outOfSync = true
            this.parseError = res.error
        }
        // live bindings re-arm lazily (LiveBind.ensure) on the next gesture or
        // MIDI message — no eager shadow re-eval here, so rebuilds stay free of
        // setup side effects (camera prompts etc.)
        this.renderAll()
    }

    attachDock(root) {
        this.dockRoot = root
        this.attachSceneKeys(root)
        if (!root.__vjFocus) {
            root.__vjFocus = true
            root.tabIndex = -1
            root.addEventListener('pointerup', () => {
                const active = root.ownerDocument.activeElement
                if (!root.contains(active)) root.focus({ preventScroll: true })
            })
        }
    }

    hostRootFor(node) {
        return node.closest('.vj-panel') || this.dockRoot
    }

    // aux hosts (pop-out, PiP, remote page) get preview + trimmed toprail
    isAuxRoot(root) {
        return root === this.popupRoot || root === this.pipRoot || root === this.remoteRoot
    }

    winFor(root) {
        if (root === this.popupRoot) return this.popupWin
        if (root === this.pipRoot) return this.pipWin
        if (root === this.remoteRoot) return root.ownerDocument.defaultView
        return null
    }

    // one persistent <video> per aux window so deck rebuilds re-adopt the
    // element instead of restarting the stream (avoids a black flash)
    previewFor(root) {
        // remote decks can't touch the canvas — the adapter owns the element
        // (WebRTC video or relayed JPEG frames)
        if (root === this.remoteRoot) return this.host.previewElement(root.ownerDocument)
        const stream = this.host.captureStream()
        if (!stream) return null
        const win = this.winFor(root)
        if (!win) return null
        if (!win.__vjPreview || win.__vjPreview.ownerDocument !== root.ownerDocument) {
            const d = root.ownerDocument
            const wrap = el(d, 'div', 'vj-preview')
            const video = el(d, 'video')
            video.muted = true
            video.autoplay = true
            video.playsInline = true
            wrap.appendChild(video)
            win.__vjPreview = wrap
        }
        const video = win.__vjPreview.querySelector('video')
        if (video.srcObject !== stream) video.srcObject = stream
        const p = video.play()
        if (p && p.catch) p.catch(() => { /* resumes on autoplay */ })
        return win.__vjPreview
    }

    // direct DOM readout update for MIDI-driven params (no re-render per message)
    flashParamValue(path, value) {
        const sel = `[data-path="${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"] .vj-value`
        ;[this.dockRoot, this.popupRoot, this.pipRoot, this.remoteRoot].forEach((root) => {
            if (!root) return
            const valueEl = root.querySelector(sel)
            if (valueEl) valueEl.textContent = fmtShort(value)
        })
    }

    renderAll() {
        // a re-render invalidates any open popover's anchor (and would orphan
        // its node + document listener when the root is wiped) — close it first
        this.closePopover()
        if (this.dockRoot && !this.state.panel.popup && !this.state.panel.pip) this.renderInto(this.dockRoot)
        if (this.popupRoot && this.popupWin && !this.popupWin.closed) this.renderInto(this.popupRoot)
        if (this.pipRoot && this.pipWin) this.renderInto(this.pipRoot)
        if (this.remoteRoot) this.renderInto(this.remoteRoot)
    }

    // --------------------------------------------- document picture-in-picture

    // Chromium-line browsers: float the deck in a small always-on-top window.
    // Unlike the pop-out tab this never hides the hydra tab, so visuals keep
    // rendering. Feature-detected; the button only appears when available.
    async openPip() {
        if (this.pipWin) return
        const api = window.documentPictureInPicture
        if (!api) return
        try {
            const win = await api.requestWindow({ width: 480, height: 620 })
            const doc = win.document
            Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
                .filter((link) => STYLE_MATCH.test(link.href))
                .forEach((link) => {
                    const copy = doc.createElement('link')
                    copy.rel = 'stylesheet'
                    copy.href = link.href
                    doc.head.appendChild(copy)
                })
            doc.body.className = 'vj-popup-body'
            const rootEl = doc.createElement('div')
            rootEl.id = 'vj-pip-root'
            rootEl.className = 'vj-panel vj-popup'
            doc.body.appendChild(rootEl)
            this.pipWin = win
            this.pipRoot = rootEl
            this.attachSceneKeys(doc)
            this.state.panel.pip = true
            this.state.panel.open = true
            win.addEventListener('pagehide', () => {
                this.pipWin = null
                this.pipRoot = null
                this.state.panel.pip = false
                this.renderAll()
                this.emit('render')
            })
            this.renderAll()
            this.emit('render')
        } catch (e) {
            if (window._reportError) window._reportError(e)
        }
    }

    // ---------------------------------------------------------------- popup

    popout() {
        // repeat clicks focus the existing deck tab instead of opening another
        if (this.popupWin && !this.popupWin.closed) {
            this.focusPopup()
            return
        }
        // preferred pop-out: the self-contained deck page. It carries its
        // pairing in the URL, so it survives reloads, can be bookmarked, and
        // the very same link works on a tablet. Falls back to the legacy
        // same-context popup when no relay is reachable (static hosting).
        const r = this.state.vjRemote
        if (r && r.connected) {
            const win = window.open(
                'deck.html#room=' + encodeURIComponent(r.room) + '&token=' + encodeURIComponent(r.token),
                '_blank')
            if (!win) {
                if (window._reportError) {
                    window._reportError(new Error('could not open the deck tab (popup blocked?) — allow popups for this site and try again'))
                }
                return
            }
            this.popupWin = win
            this.popupRoot = null // independent page — it renders itself
            this.state.panel.popup = true
            this.state.panel.open = true
            this.renderAll()
            this.emit('render')
            clearInterval(this._closePoll)
            this._closePoll = setInterval(() => {
                if (!this.popupWin || this.popupWin.closed) {
                    clearInterval(this._closePoll)
                    this.popupWin = null
                    this.state.panel.popup = false
                    this.renderAll()
                    this.emit('render')
                }
            }, 400)
            return
        }
        const win = openPopup()
        if (!win) {
            if (window._reportError) {
                window._reportError(new Error('could not open the deck tab (popup blocked?) — allow popups for this site and try again'))
            }
            return
        }
        this.adopt(win)
    }

    adopt(win) {
        win.__vjAdoptedGen = window.__vjGen
        this.popupWin = win
        this.popupRoot = win.document.getElementById('vj-popup-root')
        this.attachSceneKeys(win.document)
        this.state.panel.popup = true
        this.state.panel.open = true
        this.renderAll()
        this.emit('render')
        clearInterval(this._closePoll)
        this._closePoll = setInterval(() => {
            if (!this.popupWin || this.popupWin.closed) {
                clearInterval(this._closePoll)
                this.popupWin = null
                this.popupRoot = null
                this.state.panel.popup = false
                this.renderAll()
                this.emit('render')
            }
        }, 400)
    }

    focusPopup() {
        if (this.popupWin && !this.popupWin.closed) this.popupWin.focus()
    }

    // ---------------------------------------------------------------- scenes

    renderScenes(d) {
        const strip = el(d, 'div', 'vj-scenes')
        const current = this.host.hasBuffer() ? this.host.getCode() : null
        this.scenes.forEach((scene, i) => {
            const slot = el(d, 'button', 'vj-scene' + (scene ? ' vj-filled' : '') +
                (scene && current !== null && scene.code === current ? ' vj-active' : '') +
                (this.midi.isSceneMapped(i) ? ' vj-midimapped' : '') +
                (this.midi.isLearningScene(i) ? ' vj-learning' : ''))
            slot.appendChild(el(d, 'span', 'vj-scene-num', String(i + 1)))
            if (scene && scene.thumb) {
                const img = el(d, 'img', 'vj-scene-thumb')
                img.src = scene.thumb
                img.alt = ''
                img.draggable = false // the slot drags as a whole, not the image
                slot.appendChild(img)
            } else if (scene) {
                slot.appendChild(el(d, 'span', 'vj-scene-code', scene.code.replace(/\s+/g, ' ').slice(0, 18)))
            }
            // only the first 8 slots have keyboard shortcuts — don't promise
            // keys the later slots can't deliver
            slot.title = scene
                ? (i < 8
                    ? this.tr('panel.scene-recall', 'recall scene (key 1-8) — shift+click overwrites, drag to reorder, right-click for menu')
                    : this.tr('panel.scene-recall-nokey', 'recall scene — shift+click overwrites, drag to reorder, right-click for menu'))
                : (i < 8
                    ? this.tr('panel.scene-save', 'save current sketch here (shift+1-8) — right-click for menu')
                    : this.tr('panel.scene-save-nokey', 'save current sketch here — right-click for menu'))
            slot.onclick = (e) => {
                if (!scene || e.shiftKey) this.saveScene(i)
                else this.recallScene(i)
            }
            slot.oncontextmenu = (e) => {
                e.preventDefault()
                this.openSceneMenu(d, this.hostRootFor(slot), slot, i, scene)
            }
            this.attachSceneDrag(slot, i, !!scene)
            strip.appendChild(slot)
        })

        // + tile: the bank has no fixed size — save the current sketch into
        // a brand-new slot at the end
        const add = el(d, 'button', 'vj-scene vj-scene-add')
        add.appendChild(el(d, 'span', 'vj-scene-add-glyph', '+'))
        add.title = this.tr('panel.scene-add', 'save current sketch as a new scene (adds a slot)')
        add.onclick = () => this.addScene()
        strip.appendChild(add)

        const tools = el(d, 'div', 'vj-scenes-tools')
        const exp = el(d, 'button', 'vj-scenetool')
        exp.appendChild(el(d, 'i', 'fas fa-download'))
        exp.title = this.tr('panel.scenes-export', 'export the scene bank as a json file')
        exp.onclick = () => this.exportScenes(d)
        tools.appendChild(exp)
        const imp = el(d, 'button', 'vj-scenetool')
        imp.appendChild(el(d, 'i', 'fas fa-upload'))
        imp.title = this.tr('panel.scenes-import', 'import a scene bank json file (replaces all slots)')
        imp.onclick = () => this.importScenes(d)
        tools.appendChild(imp)
        const cyc = el(d, 'button', 'vj-scenetool vj-cycle' + (this.cycle.on ? ' vj-on' : ''))
        cyc.appendChild(el(d, 'i', 'fas ' + (this.cycle.on ? 'fa-stop' : 'fa-play')))
        cyc.title = this.tr('panel.scenes-cycle', 'auto-cycle the saved scenes') + ` (${fmtNumber(this.cycle.secs)}s — ` +
            this.tr('panel.scenes-cycle-pace', 'right-click sets the pace') + ')'
        cyc.onclick = () => this.toggleCycle()
        cyc.oncontextmenu = (e) => {
            e.preventDefault()
            this.openCyclePace(d, this.hostRootFor(cyc), cyc)
        }
        tools.appendChild(cyc)
        strip.appendChild(tools)
        return strip
    }

    // pace editor for the scene auto-cycle
    openCyclePace(d, root, anchor) {
        this.openPopover(d, root, anchor, (pop) => {
            pop.classList.add('vj-rangeform')
            const label = el(d, 'label', null, this.tr('panel.cycle-every', 'every (s)'))
            const input = el(d, 'input')
            input.type = 'number'
            input.min = '1'
            input.step = 'any'
            input.value = fmtNumber(this.cycle.secs)
            label.appendChild(input)
            pop.appendChild(label)
            const ok = el(d, 'button', 'vj-menu-item', this.tr('panel.cycle-set', 'set pace'))
            const commit = () => {
                const v = parseFloat(input.value)
                if (isFinite(v) && v >= 1) this.setCycleSecs(v)
                this.closePopover()
                this.renderAll() // refresh the tooltip
            }
            ok.onclick = commit
            input.onkeydown = (e) => {
                e.stopPropagation()
                if (e.key === 'Enter') commit()
                if (e.key === 'Escape') this.closePopover()
            }
            pop.appendChild(ok)
            setTimeout(() => input.focus(), 0)
        })
    }

    openSceneMenu(d, root, anchor, i, scene) {
        const items = []
        if (this.midi.available) {
            if (this.midi.isLearningScene(i)) {
                items.push({ label: this.tr('panel.midi-cancel', 'cancel midi learn'), fn: () => this.midi.cancelLearn() })
            } else {
                items.push({ label: this.tr('panel.midi-learn-pad', 'midi learn (hit a pad or key)'), fn: () => this.midi.startLearnScene(i) })
            }
            if (this.midi.isSceneMapped(i)) {
                items.push({ label: this.tr('panel.midi-unlearn', 'midi unlearn'), fn: () => this.midi.unlearnScene(i), danger: true })
            }
        }
        if (scene) {
            // reorder without drag & drop — the only way to reorder on touch
            if (i > 0) {
                items.push({ label: this.tr('panel.scene-move-left', 'move left'), fn: () => this.moveScene(i, i - 1) })
            }
            if (i < this.scenes.length - 1) {
                items.push({ label: this.tr('panel.scene-move-right', 'move right'), fn: () => this.moveScene(i, i + 1) })
            }
            items.push({ label: this.tr('panel.scene-clear', 'clear slot'), fn: () => this.clearScene(i), danger: true })
        }
        // added slots can be dropped again once empty (the base row stays)
        if (!scene && this.scenes.length > SLOT_COUNT) {
            items.push({ label: this.tr('panel.scene-remove', 'remove slot'), fn: () => this.removeScene(i), danger: true })
        }
        if (!items.length) return
        this.openPopover(d, root, anchor, (pop) => {
            items.forEach((item) => {
                const b = el(d, 'button', 'vj-menu-item' + (item.danger ? ' vj-danger' : ''), item.label)
                b.onclick = (e) => {
                    e.stopPropagation()
                    this.closePopover()
                    item.fn()
                }
                pop.appendChild(b)
            })
        })
    }

    // export/import create their elements in the DECK's document (dock, popup
    // or pip): a click in an aux window carries no user activation for the
    // hidden opener, so a main-document input/anchor would silently do nothing

    exportScenes(d) {
        const doc = d || document
        const data = JSON.stringify({ app: 'hydra-vj-deck', version: 1, scenes: this.scenes }, null, 2)
        const blob = new Blob([data], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const t = new Date()
        const p = (n) => String(n).padStart(2, '0')
        const stamp = `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}_${p(t.getHours())}-${p(t.getMinutes())}-${p(t.getSeconds())}`
        const a = doc.createElement('a')
        a.href = url
        a.download = `hydra-scenes-${stamp}.json`
        a.style.display = 'none'
        doc.body.appendChild(a) // firefox only downloads from in-document anchors
        a.click()
        a.remove()
        setTimeout(() => URL.revokeObjectURL(url), 5000)
    }

    importScenes(d) {
        const doc = d || document
        const input = doc.createElement('input')
        input.type = 'file'
        input.accept = '.json,application/json'
        input.style.display = 'none'
        input.onchange = () => {
            const file = input.files && input.files[0]
            input.remove()
            if (!file) return
            const reader = new FileReader()
            reader.onload = () => {
                try {
                    const parsed = JSON.parse(reader.result)
                    const arr = Array.isArray(parsed) ? parsed
                        : parsed && Array.isArray(parsed.scenes) ? parsed.scenes : null
                    if (!arr) throw new Error('not a scene bank file')
                    this.host.sceneReplaceAll(arr)
                } catch (e) {
                    if (window._reportError) window._reportError(new Error('scene bank import failed: ' + e.message))
                }
            }
            reader.readAsText(file)
        }
        input.addEventListener('cancel', () => input.remove())
        // in the document, not detached: a detached file input can be GC'd
        // while the picker is open and its onchange never fires
        doc.body.appendChild(input)
        input.click()
    }

    saveScene(i) {
        this.host.sceneSave(i)
    }

    addScene() {
        this.host.sceneAdd()
    }

    removeScene(i) {
        this.host.sceneRemove(i)
    }

    recallScene(i, opts) {
        if (!this.scenes[i]) return
        this.cycle.pos = i // manual recalls steer the auto-cycle too
        this.host.sceneRecall(i, opts)
        this.rebuild()
    }

    clearScene(i) {
        this.host.sceneClear(i)
    }

    // drag & drop reorder: the dragged scene is re-inserted at the target
    // slot and everything between shifts. keys 1-8 and midi pads stay bound
    // to slot positions, so a reorder changes what they recall — same as
    // import. works across dock/popup/pip since all decks share this instance
    attachSceneDrag(slot, i, filled) {
        const TYPE = 'application/x-hydra-scene'
        if (filled) {
            slot.draggable = true
            slot.ondragstart = (e) => {
                e.dataTransfer.setData(TYPE, String(i))
                e.dataTransfer.effectAllowed = 'move'
                slot.classList.add('vj-dragging')
            }
            slot.ondragend = () => slot.classList.remove('vj-dragging')
        }
        slot.ondragover = (e) => {
            if (!e.dataTransfer.types.includes(TYPE)) return
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            slot.classList.add('vj-dragover')
        }
        slot.ondragleave = () => slot.classList.remove('vj-dragover')
        slot.ondrop = (e) => {
            e.preventDefault()
            slot.classList.remove('vj-dragover')
            const from = parseInt(e.dataTransfer.getData(TYPE), 10)
            if (isFinite(from)) this.moveScene(from, i)
        }
    }

    moveScene(from, to) {
        this.host.sceneMove(from, to)
    }

    // ---- auto-cycle: recall the filled slots in order every N seconds

    toggleCycle() {
        if (this.cycle.on) this.stopCycle()
        else this.startCycle()
    }

    startCycle() {
        if (!this.scenes.some(Boolean)) return
        this.cycle.on = true
        this.cycleTick()
        this.cycle.timer = setInterval(() => this.cycleTick(), this.cycle.secs * 1000)
        this.renderAll()
    }

    stopCycle() {
        if (this.cycle.timer) clearInterval(this.cycle.timer)
        this.cycle.timer = null
        this.cycle.on = false
        this.renderAll()
    }

    setCycleSecs(secs) {
        this.cycle.secs = secs
        saveCycleSecs(secs)
        if (this.cycle.on) { // restart at the new pace
            clearInterval(this.cycle.timer)
            this.cycle.timer = setInterval(() => this.cycleTick(), secs * 1000)
        }
    }

    cycleTick() {
        const filled = []
        this.scenes.forEach((s, i) => { if (s) filled.push(i) })
        if (!filled.length) { this.stopCycle(); return }
        const next = filled.find((i) => i > this.cycle.pos)
        this.recallScene(next !== undefined ? next : filled[0], { replaceURL: true })
    }

    // deck-focus keys: 1-8 recall / shift+1-8 save scenes, ctrl+z / ctrl+shift+z
    // (or ctrl+y) undo/redo — only while the deck (dock or popup) has focus
    attachSceneKeys(target) {
        if (!target || target.__vjSceneKeys) return
        target.__vjSceneKeys = true
        target.addEventListener('keydown', (e) => {
            const tag = e.target && e.target.tagName
            if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
            if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.code === 'KeyZ' || e.code === 'KeyY')) {
                e.preventDefault()
                this.historyStep(e.code === 'KeyY' || e.shiftKey ? 'redo' : 'undo')
                return
            }
            const m = /^Digit([1-8])$/.exec(e.code)
            if (!m) return
            if (e.ctrlKey || e.altKey || e.metaKey) return
            e.preventDefault()
            const i = parseInt(m[1], 10) - 1
            if (e.shiftKey) this.saveScene(i)
            else this.recallScene(i)
        })
    }

    // ---------------------------------------------------------------- render

    // touch has no right-click, and iOS never fires contextmenu on its own:
    // a 500ms still-press synthesizes one on the pressed element, so every
    // right-click menu (scenes, faders, seq cells, cycle pace…) works from a
    // long-press. The browser's own long-press UI (image-save sheet, text
    // callout) is suppressed inside the panel — except on form fields,
    // where native paste matters more than our menus.
    attachTouchMenus(root) {
        if (root.__vjTouchMenus) return
        root.__vjTouchMenus = true
        const doc = root.ownerDocument
        const win = doc.defaultView
        root.addEventListener('contextmenu', (e) => {
            const tag = e.target.tagName
            if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') e.preventDefault()
        })
        root.addEventListener('pointerdown', (e) => {
            if (e.pointerType === 'mouse' || e.button !== 0) return
            const target = e.target
            const x0 = e.clientX
            const y0 = e.clientY
            const cleanup = () => {
                win.clearTimeout(timer)
                doc.removeEventListener('pointermove', move, true)
                doc.removeEventListener('pointerup', cleanup, true)
                doc.removeEventListener('pointercancel', cleanup, true)
            }
            const move = (me) => {
                if (Math.abs(me.clientX - x0) + Math.abs(me.clientY - y0) > 9) cleanup()
            }
            const timer = win.setTimeout(() => {
                cleanup()
                if (this._touchDrag) return // a lifted chip owns this gesture
                // the finger lifting off will still produce a click — eat it,
                // or the long-press on a scene pad would also recall it
                const swallow = (ce) => { ce.stopPropagation(); ce.preventDefault() }
                doc.addEventListener('click', swallow, true)
                const unswallow = () => {
                    doc.removeEventListener('pointerup', later, true)
                    doc.removeEventListener('pointercancel', later, true)
                    win.setTimeout(() => doc.removeEventListener('click', swallow, true), 60)
                }
                const later = () => unswallow()
                doc.addEventListener('pointerup', later, true)
                doc.addEventListener('pointercancel', later, true)
                // failsafe: never leave the deck eating clicks
                win.setTimeout(unswallow, 1500)
                target.dispatchEvent(new win.MouseEvent('contextmenu', {
                    bubbles: true, cancelable: true, view: win, clientX: x0, clientY: y0
                }))
            }, 500)
            doc.addEventListener('pointermove', move, true)
            doc.addEventListener('pointerup', cleanup, true)
            doc.addEventListener('pointercancel', cleanup, true)
        })
    }

    renderInto(root) {
        const d = root.ownerDocument
        this.attachTouchMenus(root)
        // every committed edit rebuilds this DOM from scratch — carry the
        // scroll offsets across the wipe so a value tweak deep in a long
        // chain doesn't fling the strip back to its start. index-keyed by
        // document order: exact for value edits (structure unchanged),
        // best-effort when a strip is added or removed
        const scrollables = '.vj-body, .vj-chips, .vj-scenes'
        const scrolled = Array.from(root.querySelectorAll(scrollables))
            .map((n) => ({ left: n.scrollLeft, top: n.scrollTop }))
        root.textContent = ''
        root.appendChild(this.renderToprail(d, root))
        if (this.previewOn && this.isAuxRoot(root)) {
            const pv = this.previewFor(root)
            if (pv) root.appendChild(pv)
        }
        root.appendChild(this.renderScenes(d))
        const body = el(d, 'div', 'vj-body')
        const model = this.model
        if (model && model.statements.length > 0) {
            if (!model.statements.some((s) => s.kind === 'setup' && s.sub === 'speed')) {
                body.appendChild(this.renderGhostSpeedRow(d))
            }
            model.statements.forEach((stmt) => body.appendChild(this.renderStatement(d, root, stmt)))
        } else {
            const empty = el(d, 'div', 'vj-empty', this.tr('panel.empty', 'no signal'))
            body.appendChild(empty)
        }
        const addRow = el(d, 'div', 'vj-addrow')
        const add = el(d, 'button', 'vj-newchain')
        add.appendChild(el(d, 'span', 'vj-pp-dot'))
        add.appendChild(el(d, 'span', null, ' ' + this.tr('panel.new-chain', 'new chain')))
        add.onclick = () => {
            const target = this.model ? freeOutput(this.model) : 'o0'
            this.apply(edits.appendChain(this.model ? this.model.text : this.host.getCode(), target))
        }
        addRow.appendChild(add)
        const freeSlot = ['s0', 's1', 's2', 's3'].find((s) => !(model && model.statements.some(
            (st) => st.kind === 'setup' && st.sub === 'sourceInit' && st.slot === s)))
        if (freeSlot) {
            const addSrc = el(d, 'button', 'vj-newchain')
            addSrc.appendChild(el(d, 'span', 'vj-pp-dot'))
            addSrc.appendChild(el(d, 'span', null, ' ' + this.tr('panel.add-source', 'source')))
            addSrc.title = this.tr('panel.add-source-hint', 'add an external source (camera / screen / video / image)')
            addSrc.onclick = () => this.apply({ from: 0, to: 0, text: `${freeSlot}.initCam(0)\n` })
            addRow.appendChild(addSrc)
        }
        body.appendChild(addRow)
        root.appendChild(body)
        if (this.outOfSync) {
            root.classList.add('vj-out-of-sync')
            const overlay = el(d, 'div', 'vj-sync-overlay')
            overlay.appendChild(el(d, 'div', 'vj-sync-msg', this.tr('panel.out-of-sync', 'out of sync — code does not parse')))
            overlay.appendChild(el(d, 'div', 'vj-sync-err', this.parseError || ''))
            root.appendChild(overlay)
        } else {
            root.classList.remove('vj-out-of-sync')
        }
        root.querySelectorAll(scrollables).forEach((n, i) => {
            const s = scrolled[i]
            if (!s) return
            if (s.left) n.scrollLeft = s.left
            if (s.top) n.scrollTop = s.top
        })
    }

    renderToprail(d, root) {
        const isAux = this.isAuxRoot(root)
        const rail = el(d, 'div', 'vj-toprail')
        rail.appendChild(el(d, 'span', 'vj-brand', 'HYDRA VJ DECK'))

        const hush = el(d, 'button', 'vj-hush', 'HUSH')
        hush.title = this.tr('panel.hush', 'stop all outputs (code stays)')
        hush.onclick = () => this.host.run('hush()')
        hush.oncontextmenu = (e) => {
            e.preventDefault()
            if (!this.midi.available) return
            const items = []
            if (this.midi.isLearningAction('hush')) {
                items.push({ label: this.tr('panel.midi-cancel', 'cancel midi learn'), fn: () => this.midi.cancelLearn() })
            } else {
                items.push({ label: this.tr('panel.midi-learn-pad', 'midi learn (hit a pad or key)'), fn: () => this.midi.startLearnAction('hush') })
            }
            if (this.midi.isActionMapped('hush')) {
                items.push({ label: this.tr('panel.midi-unlearn', 'midi unlearn'), fn: () => this.midi.unlearnAction('hush'), danger: true })
            }
            this.openItemsMenu(d, this.hostRootFor(hush), hush, items)
        }
        rail.appendChild(hush)

        const shuf = el(d, 'button', 'vj-railbtn')
        shuf.appendChild(el(d, 'i', 'fas fa-random'))
        shuf.title = this.tr('panel.shuffle', 'show a random example sketch (one undo brings the previous back)')
        shuf.onclick = () => this.deckShuffle()
        rail.appendChild(shuf)

        const dice = el(d, 'button', 'vj-railbtn')
        dice.appendChild(el(d, 'i', 'fas fa-dice'))
        dice.title = this.tr('panel.mutate', 'make a random change to one value — shift-click / right-click swaps a whole function')
        dice.disabled = this.outOfSync
        dice.onclick = (e) => this.deckMutate(e.shiftKey)
        dice.oncontextmenu = (e) => {
            e.preventDefault()
            this.deckMutate(true)
        }
        rail.appendChild(dice)

        const histSize = this.host.historySize()
        const undoBtn = el(d, 'button', 'vj-railbtn')
        undoBtn.appendChild(el(d, 'i', 'fas fa-undo'))
        undoBtn.title = this.tr('panel.undo', 'undo the last change (ctrl+z while the deck has focus)')
        undoBtn.disabled = histSize.undo === 0
        undoBtn.onclick = () => this.historyStep('undo')
        rail.appendChild(undoBtn)

        const redoBtn = el(d, 'button', 'vj-railbtn')
        redoBtn.appendChild(el(d, 'i', 'fas fa-redo'))
        redoBtn.title = this.tr('panel.redo', 'redo an undone change (ctrl+shift+z / ctrl+y)')
        redoBtn.disabled = histSize.redo === 0
        redoBtn.onclick = () => this.historyStep('redo')
        rail.appendChild(redoBtn)

        // on phone widths the rail wraps here: transport above, toggles below
        rail.appendChild(el(d, 'span', 'vj-railbreak'))

        const fft = el(d, 'button', 'vj-fft' + (this.fftShown ? ' vj-on' : ''), '∿ FFT')
        fft.title = this.tr('panel.fft', 'toggle the audio FFT monitor — right-click adds audio settings to the sketch')
        fft.onclick = () => {
            if (this.host.remote) {
                // the host's FFT canvas draws on the projector — remote decks
                // get their own little meter fed by streamed frames instead
                this.fftShown = !this.fftShown
                this.host.setFftStream(this.fftShown)
                this.renderAll()
                return
            }
            if (!this.host.audioShow(!this.fftShown)) return
            this.fftShown = !this.fftShown
            fft.classList.toggle('vj-on', this.fftShown)
        }
        fft.oncontextmenu = (e) => {
            e.preventDefault()
            this.openAudioMenu(d, this.hostRootFor(fft), fft)
        }
        rail.appendChild(fft)
        if (this.host.remote && this.fftShown) rail.appendChild(this.renderFftMeter(d))

        // stage view: drop the code/console/toolbar overlay, keep visuals + deck.
        // lit = code visible, matching the FFT button (lit = monitor visible)
        const codeBtn = el(d, 'button', 'vj-fft vj-codebtn' + (this.host.getShowCode() ? ' vj-on' : ''), 'CODE')
        codeBtn.title = this.tr('panel.hide-code', 'show/hide the code overlay (visuals and deck stay)')
        codeBtn.onclick = () => {
            this.host.toggleCode()
            codeBtn.classList.toggle('vj-on', this.host.getShowCode())
        }
        rail.appendChild(codeBtn)

        // aux windows can't see the main tab's canvas — offer a live preview
        if (isAux && this.host.canPreview()) {
            const prev = el(d, 'button', 'vj-fft' + (this.previewOn ? ' vj-on' : ''), '◉ LIVE')
            prev.title = this.tr('panel.preview', 'show the visuals live in this window (the stream pauses while the hydra tab is hidden)')
            prev.onclick = () => {
                this.previewOn = !this.previewOn
                try { localStorage.setItem('hydra-vj-preview', this.previewOn ? '1' : '0') } catch (e) { /* private mode */ }
                if (this.host.setPreview) this.host.setPreview(this.previewOn)
                this.renderAll()
            }
            rail.appendChild(prev)

            // signal-status overlay on the preview (path, fps, bandwidth)
            if (this.previewOn && this.host.toggleStats) {
                const osd = el(d, 'button', 'vj-fft' + (this.host.statsOn() ? ' vj-on' : ''), 'OSD')
                osd.title = this.tr('panel.osd', 'stream diagnostics on the preview: path, resolution, fps, bandwidth')
                osd.onclick = () => {
                    this.host.toggleStats()
                    osd.classList.toggle('vj-on', this.host.statsOn())
                }
                rail.appendChild(osd)
            }
        }

        const spacer = el(d, 'div', 'vj-spacer')
        rail.appendChild(spacer)

        // remote decks can enroll further devices: show this pairing as a QR
        // in an overlay (on the DECK screen — never on the projector)
        if (this.host.remote && this.host.requestPairUi) {
            const pair = el(d, 'button', 'vj-railbtn')
            pair.appendChild(el(d, 'i', 'fas fa-qrcode'))
            pair.title = this.tr('panel.pair', 'pair another device — shows this deck’s link as a QR code')
            pair.onclick = () => this.host.requestPairUi()
            rail.appendChild(pair)
        }

        if (!isAux) {
            const pop = el(d, 'button', 'vj-railbtn')
            pop.appendChild(el(d, 'i', 'fas fa-external-link-alt'))
            pop.title = this.tr('panel.pop-out', 'open deck in its own tab — reload-proof, and its URL works on any device on the network')
            pop.onclick = () => this.emit('panel: popout')
            rail.appendChild(pop)

            // pairing page for other devices (tablet / phone / laptop)
            if (this.state.vjRemote) {
                const pairPage = el(d, 'button', 'vj-railbtn')
                pairPage.appendChild(el(d, 'i', 'fas fa-qrcode'))
                pairPage.title = this.tr('panel.pair-page', 'pair a tablet / phone: opens the pairing page with QR code + deck link (keep it off the projector)')
                pairPage.onclick = () => window.open('deck.html', '_blank')
                rail.appendChild(pairPage)
            }

            if (window.documentPictureInPicture) {
                const pip = el(d, 'button', 'vj-railbtn')
                pip.appendChild(el(d, 'i', 'fas fa-window-restore'))
                pip.title = this.tr('panel.pip', 'float the deck in a small always-on-top window (visuals keep running)')
                pip.onclick = () => this.openPip()
                rail.appendChild(pip)
            }

            const close = el(d, 'button', 'vj-railbtn')
            close.appendChild(el(d, 'i', 'fas fa-times'))
            close.title = this.tr('panel.close', 'close panel (ctrl+shift+y)')
            close.onclick = () => this.emit('panel: toggle')
            rail.appendChild(close)
        }
        return rail
    }

    // tiny 4-band meter for remote decks (frames streamed by the host at a
    // few Hz — enough to see the beat land without touching the projector)
    renderFftMeter(d) {
        const wrap = el(d, 'div', 'vj-fftmeter')
        const bars = []
        for (let i = 0; i < 4; i++) {
            const bar = el(d, 'div', 'vj-fftbar')
            bar.appendChild(el(d, 'div', 'vj-fftbar-fill'))
            bars.push(bar)
            wrap.appendChild(bar)
        }
        if (this.host.onFftFrame) {
            this.host.onFftFrame((bins) => {
                if (!wrap.isConnected) return false // deregister after a re-render
                bins.slice(0, 4).forEach((v, i) => {
                    bars[i].firstChild.style.height = Math.round(Math.min(1, Math.max(0, v)) * 100) + '%'
                })
                return true
            })
        }
        return wrap
    }

    renderStatement(d, root, stmt) {
        if (stmt.kind === 'chain') return this.renderStrip(d, root, stmt)
        if (stmt.kind === 'render') return this.renderRenderRow(d, stmt)
        if (stmt.kind === 'setup' && (stmt.sub === 'speed' || stmt.sub === 'bpm')) return this.renderGlobalRow(d, stmt)
        if (stmt.kind === 'setup' && stmt.sub === 'audioSet' && AUDIO_SETTINGS[stmt.fn]) return this.renderAudioSetRow(d, stmt)
        if (stmt.kind === 'setup' && stmt.sub === 'sourceInit' && SOURCE_FNS[stmt.fn]) return this.renderSourceRow(d, stmt)
        return this.renderRawRow(d, stmt)
    }

    // s0.initCam()/initScreen()/initVideo(url)/initImage(url) -> editable row
    renderSourceRow(d, stmt) {
        const rowEl = el(d, 'div', 'vj-setup-row vj-source-row')
        rowEl.appendChild(el(d, 'label', 'vj-label vj-source-slot', stmt.slot))

        const rewrite = (fn, url, camIndex) => {
            let call
            if (fn === 'initCam') call = `${stmt.slot}.initCam(${camIndex || 0})`
            else if (fn === 'initScreen') call = `${stmt.slot}.initScreen()`
            else call = `${stmt.slot}.${fn}("${String(url || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}")`
            this.apply({ from: stmt.range[0], to: stmt.range[1], text: call })
        }

        const sel = el(d, 'select', 'vj-refselect')
        Object.entries(SOURCE_FNS).forEach(([fn, label]) => {
            const o = el(d, 'option', null, label)
            o.value = fn
            if (fn === stmt.fn) o.selected = true
            sel.appendChild(o)
        })
        sel.onchange = () => rewrite(sel.value, stmt.url, stmt.camIndex)
        rowEl.appendChild(sel)

        if (stmt.fn === 'initCam') {
            const idxSel = el(d, 'select', 'vj-refselect')
            for (let i = 0; i < 4; i++) {
                const o = el(d, 'option', null, 'cam ' + i)
                o.value = String(i)
                if (i === (stmt.camIndex || 0)) o.selected = true
                idxSel.appendChild(o)
            }
            idxSel.title = this.tr('panel.source-cam', 'camera device index')
            idxSel.onchange = () => rewrite('initCam', null, parseInt(idxSel.value, 10))
            rowEl.appendChild(idxSel)
        }
        if (stmt.fn === 'initVideo' || stmt.fn === 'initImage') {
            const urlIn = el(d, 'input', 'vj-src-url')
            urlIn.type = 'text'
            urlIn.placeholder = 'https://…'
            urlIn.value = stmt.url || ''
            urlIn.title = this.tr('panel.source-url', 'media url — press enter to apply')
            urlIn.onkeydown = (e) => {
                e.stopPropagation()
                if (e.key === 'Enter') rewrite(stmt.fn, urlIn.value, 0)
            }
            rowEl.appendChild(urlIn)
        }

        const spacer = el(d, 'div', 'vj-spacer')
        rowEl.appendChild(spacer)
        const rm = el(d, 'button', 'vj-source-remove')
        rm.appendChild(el(d, 'i', 'fas fa-times'))
        rm.title = this.tr('panel.remove-source', 'remove this source')
        rm.onclick = () => this.apply(edits.removeStatement(stmt, this.model.text))
        rowEl.appendChild(rm)
        return rowEl
    }

    // a.setSmooth(0.4) etc -> fader row. calling the setter previews the value
    // live, so the commit is a quiet splice like the speed/bpm rows
    renderAudioSetRow(d, stmt) {
        const meta = AUDIO_SETTINGS[stmt.fn]
        const rowEl = el(d, 'div', 'vj-setup-row vj-audioset-row')
        rowEl.appendChild(el(d, 'label', 'vj-label', 'audio ' + meta.label))
        const valueEl = el(d, 'span', 'vj-value', fmtShort(stmt.arg.value))
        let current = stmt.arg.value
        const norm = (v) => (meta.int ? Math.max(1, Math.round(v)) : v)
        const track = this.makeFader(d, {
            get: () => current,
            ref: Math.max(meta.def, 0.5),
            int: !!meta.int,
            live: (v) => {
                current = norm(v)
                valueEl.textContent = fmtShort(current)
                this.host.audioCall(stmt.fn, current)
            },
            commit: (v) => this.applyQuiet(edits.setNumber(stmt.arg, norm(v)))
        })
        this.attachValueEdit(d, valueEl, {
            get: () => current,
            set: (v) => {
                current = norm(v)
                this.host.audioCall(stmt.fn, current)
                this.applyQuiet(edits.setNumber(stmt.arg, current))
            }
        })
        rowEl.appendChild(track)
        rowEl.appendChild(valueEl)
        rowEl.appendChild(el(d, 'div', 'vj-spacer'))
        const rm = el(d, 'button', 'vj-source-remove')
        rm.appendChild(el(d, 'i', 'fas fa-times'))
        rm.title = this.tr('panel.remove-audioset', 'remove this setting (keeps its current value until reload)')
        rm.onclick = () => this.apply(edits.removeStatement(stmt, this.model.text))
        rowEl.appendChild(rm)
        return rowEl
    }

    // FFT button right-click: add audio-setting rows the sketch doesn't have yet
    openAudioMenu(d, root, anchor) {
        const stmts = (this.model && this.model.statements) || []
        const items = []
        Object.entries(AUDIO_SETTINGS).forEach(([fn, meta]) => {
            if (stmts.some((s) => s.kind === 'setup' && s.sub === 'audioSet' && s.fn === fn)) return
            items.push({
                label: this.tr('panel.audio-add-' + meta.label, '+ audio ' + meta.label),
                fn: () => this.apply({ from: 0, to: 0, text: `a.${fn}(${fmtNumber(meta.def)})\n` })
            })
        })
        if (!items.length) return
        this.openPopover(d, root, anchor, (pop) => {
            items.forEach((item) => {
                const b = el(d, 'button', 'vj-menu-item', item.label)
                b.onclick = (e) => {
                    e.stopPropagation()
                    this.closePopover()
                    item.fn()
                }
                pop.appendChild(b)
            })
        })
    }

    renderStrip(d, root, stmt) {
        const target = stmt.out ? stmt.out.target : null
        const strip = el(d, 'div', 'vj-strip ' + (CHANNEL_CLASS[target] || 'ch-none'))

        const railEl = el(d, 'div', 'vj-strip-rail')
        railEl.appendChild(el(d, 'span', 'vj-strip-out', target || '—'))
        const kill = el(d, 'button', 'vj-strip-kill')
        kill.appendChild(el(d, 'i', 'fas fa-times'))
        kill.title = this.tr('panel.remove-chain', 'remove this chain')
        kill.onclick = () => this.apply(edits.removeStatement(stmt, this.model.text))
        railEl.appendChild(kill)
        strip.appendChild(railEl)

        const row = this.renderChipsRow(d, root, stmt, { topLevel: true, stmt })
        strip.appendChild(row)
        return strip
    }

    // chainLike: {source, transforms, disabled} (+ .out when topLevel)
    renderChipsRow(d, root, chainLike, opts) {
        const row = el(d, 'div', 'vj-chips')
        const byGap = new Map()
        ;(chainLike.disabled || []).forEach((b) => {
            const list = byGap.get(b.gapIdx) || []
            list.push(b)
            byGap.set(b.gapIdx, list)
        })
        const emitDisabled = (gap) => (byGap.get(gap) || []).forEach((b) =>
            row.appendChild(this.renderBypassedChip(d, b)))
        row.appendChild(this.renderChip(d, root, chainLike.source, chainLike, -1, opts))
        row.appendChild(this.patchPoint(d, root, chainLike, 0))
        emitDisabled(0)
        chainLike.transforms.forEach((step, i) => {
            row.appendChild(this.renderChip(d, root, step, chainLike, i, opts))
            row.appendChild(this.patchPoint(d, root, chainLike, i + 1))
            emitDisabled(i + 1)
        })
        if (opts.topLevel) row.appendChild(this.renderOutChip(d, chainLike))
        return row
    }

    // a muted (commented-out) step: dim chip with re-enable + delete
    renderBypassedChip(d, byp) {
        const chip = el(d, 'div', 'vj-chip vj-bypassed')
        const head = el(d, 'div', 'vj-chip-head')
        head.appendChild(el(d, 'span', 'vj-chip-name', byp.name))
        const on = el(d, 'button', 'vj-chip-menubtn vj-byp-on')
        on.appendChild(el(d, 'i', 'fas fa-power-off'))
        on.title = this.tr('panel.bypass-on', 're-enable this function')
        on.onclick = () => this.apply(edits.enableBypassed(byp, this.model.text))
        head.appendChild(on)
        const rm = el(d, 'button', 'vj-chip-menubtn')
        rm.appendChild(el(d, 'i', 'fas fa-times'))
        rm.title = this.tr('panel.remove', 'remove')
        rm.onclick = () => this.apply(edits.removeBypassed(byp))
        head.appendChild(rm)
        chip.appendChild(head)
        const body = el(d, 'div', 'vj-chip-params')
        const argsText = byp.argsText.replace(/\s+/g, ' ')
        body.appendChild(el(d, 'span', 'vj-byp-args', argsText.length > 22 ? argsText.slice(0, 21) + '…' : argsText))
        chip.appendChild(body)
        return chip
    }

    renderChip(d, root, step, chainLike, index, opts) {
        const isSource = index === -1
        const type = step.meta ? step.meta.type : 'unknown'
        const chip = el(d, 'div', 'vj-chip type-' + type + (isSource ? ' vj-chip-src' : ''))

        const head = el(d, 'div', 'vj-chip-head')
        head.appendChild(el(d, 'span', 'vj-chip-name', step.name))
        const menuBtn = el(d, 'button', 'vj-chip-menubtn')
        menuBtn.appendChild(el(d, 'i', 'fas fa-ellipsis-v'))
        menuBtn.title = this.tr('panel.fn-menu', 'replace / duplicate / remove')
        menuBtn.onclick = (e) => {
            e.stopPropagation()
            this.openChipMenu(d, root, menuBtn, step, chainLike, index, opts)
        }
        head.appendChild(menuBtn)
        chip.appendChild(head)

        const params = el(d, 'div', 'vj-chip-params')
        const inputs = step.meta ? step.meta.inputs : step.args.map((a, i) => ({ name: 'arg' + i }))
        inputs.forEach((input, i) => {
            params.appendChild(this.renderParam(d, root, step, input, i, opts))
        })
        // extra args beyond metadata arity still shown (e.g. custom fns)
        if (step.meta && step.args.length > step.meta.inputs.length) {
            step.args.slice(step.meta.inputs.length).forEach((arg, j) => {
                params.appendChild(this.renderParam(d, root, step, { name: 'arg' + (step.meta.inputs.length + j) }, step.meta.inputs.length + j, opts))
            })
        }
        chip.appendChild(params)
        // a chip hosting a nested chain or a sequencer must grow to fit it —
        // the strip scrolls as a whole instead of the content clipping
        if (params.querySelector('.vj-subchain, .vj-seq')) chip.classList.add('vj-wide')

        if (!isSource) this.attachChipDrag(d, root, head, chip, chainLike, index)
        return chip
    }

    renderParam(d, root, step, input, argIdx, opts) {
        const rowEl = el(d, 'div', 'vj-param')
        rowEl.appendChild(el(d, 'label', 'vj-label', input.name))
        const arg = step.args[argIdx]
        if (arg && arg.path) rowEl.dataset.path = arg.path

        if (input.slot) {
            const slotEl = this.renderSlot(d, root, step, input, argIdx, arg, opts)
            // nested chains get the full chip width, label stacked above
            if (slotEl.classList.contains('vj-subchain')) rowEl.classList.add('vj-stack')
            rowEl.appendChild(slotEl)
            return rowEl
        }
        if (!arg || arg.kind === 'number') {
            this.appendFaderParam(d, rowEl, step, input, argIdx, arg)
            return rowEl
        }
        if (arg.kind === 'outRef' || arg.kind === 'srcRef') {
            rowEl.appendChild(this.makeRefSelect(d, arg.name, (name) => this.apply(edits.setRef(arg, name))))
            return rowEl
        }
        if (arg.kind === 'chain') {
            rowEl.classList.add('vj-stack')
            rowEl.appendChild(this.renderSubchain(d, root, arg, opts))
            return rowEl
        }
        if (arg.kind === 'arraySeq') {
            rowEl.appendChild(this.renderArraySeq(d, arg))
            return rowEl
        }
        if (arg.kind === 'audioBind') {
            rowEl.classList.add('vj-bindparam')
            rowEl.appendChild(this.renderAudioBind(d, input, arg))
            return rowEl
        }
        if (arg.kind === 'mouseBind') {
            rowEl.classList.add('vj-bindparam')
            rowEl.appendChild(this.renderMouseBind(d, input, arg))
            return rowEl
        }
        rowEl.appendChild(this.renderExprChip(d, arg, input))
        return rowEl
    }

    renderSlot(d, root, step, input, argIdx, arg, opts) {
        if (arg && arg.kind === 'chain') return this.renderSubchain(d, root, arg, opts)
        if (arg && (arg.kind === 'outRef' || arg.kind === 'srcRef')) {
            return this.makeRefSelect(d, arg.name, (name) => this.apply(edits.setRef(arg, name)))
        }
        if (arg) return this.renderExprChip(d, arg, input)
        // slot the code omits: pick a ref to fill it
        return this.makeRefSelect(d, '', (name) => {
            if (name) this.apply(edits.ghostArg(step, argIdx, name))
        }, true)
    }

    renderSubchain(d, root, arg, opts) {
        const sub = el(d, 'div', 'vj-subchain')
        sub.appendChild(this.renderChipsRow(d, root, arg, { topLevel: false }))
        return sub
    }

    renderExprChip(d, arg, input) {
        const wrap = el(d, 'div', 'vj-expr-wrap')
        const chipEl = el(d, 'button', 'vj-expr')
        const tags = (arg.tags || []).filter((t) => t !== 'fn').map((t) => TAG_ICONS[t]).filter(Boolean).join('')
        chipEl.appendChild(el(d, 'span', 'vj-expr-badge', 'ƒ' + (tags ? ' ' + tags : '')))
        const text = arg.text.replace(/^\(\)\s*=>\s*/, '')
        const short = text.length > 24 ? text.slice(0, 23) + '…' : text
        chipEl.appendChild(el(d, 'span', 'vj-expr-text', short))
        chipEl.title = arg.text + '\n' + this.tr('panel.expr-hint', 'live expression — click to edit it in the code')
        chipEl.onclick = () => this.jumpToRange(arg.range)
        wrap.appendChild(chipEl)

        const freeze = el(d, 'button', 'vj-expr-freeze')
        freeze.appendChild(el(d, 'i', 'fas fa-thumbtack'))
        freeze.title = this.tr('panel.freeze-expr', 'freeze to its current value — turns into a fader')
        freeze.onclick = () => this.freezeExpr(arg, input)
        wrap.appendChild(freeze)
        return wrap
    }

    // evaluate the expression once at the current time/mouse state and pin
    // the result into the code as a plain number (which renders as a fader).
    // async because a remote host round-trips the eval to the renderer.
    freezeExpr(arg, input) {
        this.host.evalExpr(arg.text, (v) => {
            if (typeof v !== 'number' || !isFinite(v)) {
                v = input && typeof input.default === 'number' && isFinite(input.default) ? input.default : 0
            }
            this.apply({ from: arg.range[0], to: arg.range[1], text: fmtNumber(v) })
        })
    }

    appendFaderParam(d, rowEl, step, input, argIdx, arg) {
        const isInt = INT_PARAMS.has(input.name)
        const initial = arg ? arg.value : (typeof input.default === 'number' && isFinite(input.default) ? input.default : 0)
        const valueEl = el(d, 'span', 'vj-value' + (arg ? '' : ' vj-ghost'), fmtShort(initial))

        let liveKey = null
        let current = initial
        const track = this.makeFader(d, {
            get: () => current,
            // anchor the fill on the function's default, NOT the current value —
            // a value-tracking ref would paint every fader at 50% forever
            ref: Math.max(Math.abs(typeof input.default === 'number' ? input.default : 0), 0.5),
            int: isInt,
            start: () => {
                if (arg && !arg.noLive && arg.path) liveKey = this.lb.ensure(this.ctx(), arg.path, arg.value)
            },
            live: (v) => {
                current = v
                valueEl.textContent = fmtShort(v)
                if (liveKey) this.lb.set(liveKey, v)
            },
            commit: (v) => {
                const edit = arg ? edits.setNumber(arg, v) : edits.ghostArg(step, argIdx, fmtNumber(v))
                if (liveKey && arg && this.lb.isLive(arg.path)) {
                    // the binding stays live for the next gesture; align the
                    // uniform with the rounded literal and splice text only
                    this.lb.set(liveKey, parseFloat(fmtNumber(v)))
                    this.applyQuiet(edit)
                } else {
                    this.apply(edit, { replaceURL: true })
                }
                liveKey = null
            },
            cancel: (v0) => {
                // scroll stole the drag: park the uniform back on the value
                // the gesture started from, not commit stray pixels of motion
                if (liveKey) this.lb.set(liveKey, v0)
                liveKey = null
            }
        })
        if (arg && arg.kind === 'number' && arg.path && !arg.noLive) {
            if (this.midi.isMapped(arg.path)) rowEl.classList.add('vj-midimapped')
            if (this.midi.isLearning(arg.path)) track.classList.add('vj-learning')
            track.oncontextmenu = (e) => {
                e.preventDefault()
                this.openParamMenu(d, this.hostRootFor(track), track, arg)
            }
        }
        this.attachValueEdit(d, valueEl, {
            get: () => current,
            set: (v) => {
                const edit = arg ? edits.setNumber(arg, v) : edits.ghostArg(step, argIdx, fmtNumber(v))
                this.apply(edit)
            }
        })
        rowEl.appendChild(track)
        rowEl.appendChild(valueEl)
    }

    // click a value readout to type an exact number; Enter or clicking away
    // (after a change) commits, Escape cancels. set(v) gets the parsed float.
    attachValueEdit(d, valueEl, opts) {
        valueEl.title = this.tr('panel.value-edit', 'click to type a value')
        valueEl.onclick = () => {
            const inp = el(d, 'input', 'vj-value-input')
            inp.type = 'text'
            inp.inputMode = 'decimal'
            inp.value = fmtNumber(opts.get())
            const initial = inp.value
            valueEl.replaceWith(inp)
            inp.focus()
            inp.select()
            let closed = false
            const done = (commit) => {
                if (closed) return
                closed = true
                const v = parseFloat(inp.value.replace(',', '.'))
                inp.replaceWith(valueEl)
                if (commit && isFinite(v)) opts.set(v)
            }
            inp.onkeydown = (e) => {
                if (e.key === 'Enter') done(true)
                if (e.key === 'Escape') done(false)
                e.stopPropagation()
            }
            inp.onblur = () => done(inp.value !== initial)
        }
    }

    // relative-drag fader. opts: get(), ref, int, start(), live(v), commit(v)
    makeFader(d, opts) {
        const track = el(d, 'div', 'vj-fader')
        track.tabIndex = 0
        track.setAttribute('role', 'slider')
        const fill = el(d, 'div', 'vj-fader-fill')
        track.appendChild(fill)

        const paint = (v) => {
            // asymptotic fill for unbounded params: 0 -> empty, the reference
            // (the function's default) -> half, beyond keeps growing toward full
            const ref = Math.max(opts.ref, 0.001)
            const pct = Math.abs(v) / (Math.abs(v) + ref) * 100
            fill.style.width = pct + '%'
            track.classList.toggle('vj-neg', v < 0)
            track.setAttribute('aria-valuenow', fmtNumber(v))
        }
        paint(opts.get())

        let dragging = false
        let moved = false
        let startX = 0
        let lastX = 0
        let startV = 0
        let acc = 0
        let slop = 0
        track.onpointerdown = (e) => {
            if (e.button !== 0) return
            dragging = true
            moved = false
            startX = lastX = e.clientX
            startV = acc = opts.get()
            // touch: a few px of slop, so taps and swipes the browser is
            // about to claim as page scrolls don't nudge the value
            slop = e.pointerType === 'mouse' ? 0 : 8
            track.setPointerCapture(e.pointerId)
            track.classList.add('vj-armed')
            if (opts.start) opts.start()
            e.preventDefault()
        }
        track.onpointermove = (e) => {
            if (!dragging) return
            if (!moved) {
                if (Math.abs(e.clientX - startX) < slop) return
                moved = true
                lastX = e.clientX
            }
            // pull-away fine adjust: the farther the finger sits above or
            // below the track, the finer the drag — down to 10%, the touch
            // stand-in for the desktop's shift+drag
            const r = track.getBoundingClientRect()
            const away = Math.max(0, Math.max(r.top - e.clientY, e.clientY - r.bottom) - 24)
            const fine = Math.max(0.1, 1 - away / 220) * (e.shiftKey ? 0.1 : 1)
            track.classList.toggle('vj-fine', fine < 0.5)
            // integrate deltas on a float accumulator: sensitivity can change
            // mid-drag, and int params must still accumulate sub-step motion
            const scale = Math.max(Math.abs(startV), opts.ref, 0.001)
            acc += (e.clientX - lastX) / 150 * scale * fine
            lastX = e.clientX
            const v = opts.int ? Math.round(acc) : parseFloat(acc.toFixed(4))
            opts.live(v)
            paint(v)
        }
        const finish = (e) => {
            if (!dragging) return
            dragging = false
            track.classList.remove('vj-armed')
            track.classList.remove('vj-fine')
            try { track.releasePointerCapture(e.pointerId) } catch (err) {}
            if (!moved) return
            if (e.type === 'pointercancel') {
                // the browser took the gesture for a page scroll — undo the
                // few px that leaked in before it decided
                opts.live(startV)
                paint(startV)
                if (opts.cancel) opts.cancel(startV)
                return
            }
            opts.commit(opts.get())
        }
        track.onpointerup = finish
        track.onpointercancel = finish
        track.onkeydown = (e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
            const dir = e.key === 'ArrowRight' ? 1 : -1
            const scale = Math.max(Math.abs(opts.get()), opts.ref, 0.001)
            let v = opts.get() + dir * scale * (e.shiftKey ? 0.01 : 0.05)
            if (opts.int) v = opts.get() + dir
            v = parseFloat(v.toFixed(4))
            if (opts.start) opts.start()
            opts.live(v)
            paint(v)
            opts.commit(v)
            e.preventDefault()
        }
        return track
    }

    makeRefSelect(d, current, onChange, allowEmpty) {
        const sel = el(d, 'select', 'vj-refselect')
        if (allowEmpty) sel.appendChild(el(d, 'option', null, '—'))
        const opts = ['o0', 'o1', 'o2', 'o3', 's0', 's1', 's2', 's3']
        opts.forEach((name) => {
            const o = el(d, 'option', null, name)
            o.value = name
            if (name === current) o.selected = true
            sel.appendChild(o)
        })
        sel.onchange = () => onChange(sel.value)
        return sel
    }

    // right-click menu on a fader: MIDI learn/unlearn/range, bind to audio/mouse
    openParamMenu(d, root, anchor, arg) {
        const items = []
        if (this.midi.available) {
            if (this.midi.isLearning(arg.path)) {
                items.push({ label: this.tr('panel.midi-cancel', 'cancel midi learn'), fn: () => this.midi.cancelLearn() })
            } else {
                items.push({ label: this.tr('panel.midi-learn', 'midi learn (move a knob)'), fn: () => this.midi.startLearn(arg.path) })
                items.push({ label: this.tr('panel.midi-learn-toggle', 'midi button: toggle (hit a pad)'), fn: () => this.midi.startLearn(arg.path, 'toggle') })
                items.push({ label: this.tr('panel.midi-learn-push', 'midi button: hold (hit a pad)'), fn: () => this.midi.startLearn(arg.path, 'push') })
            }
            if (this.midi.isMapped(arg.path)) {
                const m = this.midi.mappings.params[arg.path]
                items.push({
                    // surface the active range — hardware sweeps the whole
                    // of it, and this is where to widen it
                    label: this.tr('panel.midi-range', 'midi range…') + ` (${fmtNumber(m.min)} to ${fmtNumber(m.max)})`,
                    keepOpen: true,
                    fn: () => this.openMidiRange(d, root, anchor, arg)
                })
                items.push({ label: this.tr('panel.midi-unlearn', 'midi unlearn'), fn: () => this.midi.unlearn(arg.path), danger: true })
            }
        }
        items.push({
            label: this.tr('panel.bind-audio', 'bind to audio (fft)'),
            fn: () => {
                const scale = fmtNumber(Math.max(Math.abs(arg.value) * 2, 0.5))
                this.apply({ from: arg.range[0], to: arg.range[1], text: `() => a.fft[0] * ${scale}` })
            }
        })
        items.push({
            label: this.tr('panel.bind-mouse', 'bind to mouse'),
            fn: () => {
                const scale = fmtNumber(Math.max(Math.abs(arg.value) * 2, 0.5))
                this.apply({ from: arg.range[0], to: arg.range[1], text: `() => mouse.x / width * ${scale}` })
            }
        })
        this.openItemsMenu(d, root, anchor, items)
    }

    openItemsMenu(d, root, anchor, items) {
        this.openPopover(d, root, anchor, (pop) => {
            items.forEach((item) => {
                const b = el(d, 'button', 'vj-menu-item' + (item.danger ? ' vj-danger' : ''), item.label)
                b.onclick = (e) => {
                    e.stopPropagation()
                    if (!item.keepOpen) this.closePopover()
                    item.fn()
                }
                pop.appendChild(b)
            })
        })
    }

    // min/max editor for an existing MIDI mapping
    openMidiRange(d, root, anchor, arg) {
        const m = this.midi.mappings.params[arg.path]
        if (!m) return
        this.openPopover(d, root, anchor, (pop) => {
            pop.classList.add('vj-rangeform')
            const mkField = (labelText, value) => {
                const label = el(d, 'label', null, labelText)
                const input = el(d, 'input')
                input.type = 'number'
                input.step = 'any'
                input.value = fmtNumber(value)
                label.appendChild(input)
                pop.appendChild(label)
                return input
            }
            const minIn = mkField(this.tr('panel.midi-range-min', 'min'), m.min)
            const maxIn = mkField(this.tr('panel.midi-range-max', 'max'), m.max)
            const ok = el(d, 'button', 'vj-menu-item', this.tr('panel.midi-range-set', 'set range'))
            const commit = () => {
                this.midi.setRange(arg.path, parseFloat(minIn.value), parseFloat(maxIn.value))
                this.closePopover()
            }
            ok.onclick = commit
            ;[minIn, maxIn].forEach((input) => {
                input.onkeydown = (e) => {
                    e.stopPropagation()
                    if (e.key === 'Enter') commit()
                    if (e.key === 'Escape') this.closePopover()
                }
            })
            pop.appendChild(ok)
            setTimeout(() => minIn.focus(), 0)
        })
    }

    // vertical relative drag for sequencer cells
    attachVDrag(target, opts) {
        target.style.touchAction = 'none'
        target.onpointerdown = (e) => {
            if (e.button !== 0) return
            const startY = e.clientY
            const v0 = opts.get()
            let current = v0
            let moved = false
            target.setPointerCapture(e.pointerId)
            target.classList.add('vj-armed')
            target.onpointermove = (ev) => {
                moved = true
                let nv = v0 + (startY - ev.clientY) / 100 * opts.ref * (ev.shiftKey ? 0.1 : 1)
                nv = parseFloat(nv.toFixed(4))
                current = nv
                opts.live(nv)
            }
            const up = (ev) => {
                target.onpointermove = null
                target.onpointerup = null
                target.onpointercancel = null
                target.classList.remove('vj-armed')
                try { target.releasePointerCapture(ev.pointerId) } catch (err) {}
                if (moved) opts.commit(current)
            }
            target.onpointerup = up
            target.onpointercancel = up
            e.preventDefault()
        }
    }

    // [1, 2, 3].fast(x).smooth(y) -> step sequencer with rate + smooth controls
    renderArraySeq(d, arg) {
        const wrap = el(d, 'div', 'vj-seq')
        const cells = el(d, 'div', 'vj-seq-cells')
        arg.values.forEach((v, vi) => {
            const cell = el(d, 'button', 'vj-seq-cell')
            const val = el(d, 'span', 'vj-seq-val', fmtShort(v.value))
            cell.appendChild(val)
            cell.title = this.tr('panel.seq-cell', 'drag up/down to change — right-click removes the step')
            this.attachVDrag(cell, {
                get: () => v.value,
                ref: Math.max(Math.abs(v.value), 0.5),
                live: (nv) => { val.textContent = fmtShort(nv) },
                commit: (nv) => this.apply(edits.setNumber(v, nv), { replaceURL: true })
            })
            cell.oncontextmenu = (e) => {
                e.preventDefault()
                if (arg.values.length <= 1) return
                const edit = vi > 0
                    ? { from: arg.values[vi - 1].range[1], to: v.range[1], text: '' }
                    : { from: v.range[0], to: arg.values[1].range[0], text: '' }
                this.apply(edit)
            }
            cells.appendChild(cell)
        })
        const add = el(d, 'button', 'vj-seq-add', '+')
        add.title = this.tr('panel.seq-add', 'add a step')
        add.onclick = () => {
            const last = arg.values[arg.values.length - 1]
            this.apply({ from: arg.arrayInnerEnd, to: arg.arrayInnerEnd, text: `, ${fmtNumber(last.value)}` })
        }
        cells.appendChild(add)
        wrap.appendChild(cells)

        const mods = el(d, 'div', 'vj-seq-mods')
        // numeric modifier: label + fader when present, '+ name' button when not;
        // right-click on the fader removes the modifier again
        const numericMod = (name, addText, ref) => {
            const mod = arg.mods[name]
            if (mod && mod.arg) {
                const label = el(d, 'span', 'vj-seq-modlabel', name)
                mods.appendChild(label)
                const mval = el(d, 'span', 'vj-value', fmtShort(mod.arg.value))
                let cur = mod.arg.value
                const track = this.makeFader(d, {
                    get: () => cur,
                    ref,
                    live: (nv) => { cur = nv; mval.textContent = fmtShort(nv) },
                    commit: (nv) => this.apply(edits.setNumber(mod.arg, nv), { replaceURL: true })
                })
                track.title = this.tr('panel.seq-mod-remove', 'right-click removes this modifier')
                track.oncontextmenu = (e) => {
                    e.preventDefault()
                    this.apply({ from: mod.span[0], to: mod.span[1], text: '' })
                }
                mods.appendChild(track)
                mods.appendChild(mval)
            } else if (!mod) {
                const addBtn = el(d, 'button', 'vj-seq-mod', '+ ' + name)
                addBtn.onclick = () => this.apply({ from: arg.range[1], to: arg.range[1], text: addText })
                mods.appendChild(addBtn)
            }
        }
        numericMod('fast', '.fast(2)', 1)
        numericMod('offset', '.offset(0.5)', 0.5)

        const smoothBtn = el(d, 'button', 'vj-seq-mod' + (arg.mods.smooth ? ' vj-on' : ''), 'smooth')
        smoothBtn.onclick = () => {
            if (arg.mods.smooth) this.apply({ from: arg.mods.smooth.span[0], to: arg.mods.smooth.span[1], text: '' })
            else this.apply({ from: arg.range[1], to: arg.range[1], text: '.smooth(1)' })
        }
        mods.appendChild(smoothBtn)

        const easeSel = el(d, 'select', 'vj-refselect vj-seq-ease')
        easeSel.title = this.tr('panel.seq-ease', 'easing between steps (implies smoothing)')
        const none = el(d, 'option', null, 'ease —')
        none.value = ''
        if (!arg.mods.ease) none.selected = true
        easeSel.appendChild(none)
        EASINGS.forEach((name) => {
            const o = el(d, 'option', null, name)
            o.value = name
            if (arg.mods.ease && arg.mods.ease.str && arg.mods.ease.str.value === name) o.selected = true
            easeSel.appendChild(o)
        })
        easeSel.onchange = () => {
            const v = easeSel.value
            const mod = arg.mods.ease
            if (!v) {
                if (mod) this.apply({ from: mod.span[0], to: mod.span[1], text: '' })
            } else if (mod) {
                if (mod.str) this.apply({ from: mod.str.range[0], to: mod.str.range[1], text: `'${v}'` })
                else this.apply({ from: mod.span[0], to: mod.span[1], text: `.ease('${v}')` })
            } else {
                this.apply({ from: arg.range[1], to: arg.range[1], text: `.ease('${v}')` })
            }
        }
        mods.appendChild(easeSel)
        wrap.appendChild(mods)
        return wrap
    }

    // shared frame for audio/mouse bindings: a boxed group so everything the
    // binding owns reads as one unit — a source row (picker + unbind) on top,
    // then labeled SCALE and OFFSET fader rows. the source is normalized 0..1,
    // so param = source * scale + offset: scale sets the range, offset the base.
    buildBindBox(d, input, arg, spec) {
        const wrap = el(d, 'div', spec.cls)
        const state = spec.state
        // widget edits always rewrite the whole expression (simple + robust)
        const rewrite = () => {
            let text = spec.base(state)
            if (state.scale !== 1) text += ` * ${fmtNumber(state.scale)}`
            if (state.offset !== 0) text += state.offset < 0 ? ` + (${fmtNumber(state.offset)})` : ` + ${fmtNumber(state.offset)}`
            this.apply({ from: arg.range[0], to: arg.range[1], text }, { replaceURL: true })
        }

        const head = el(d, 'div', 'vj-bind-row vj-bind-head')
        head.appendChild(el(d, 'span', spec.iconCls, spec.icon))
        head.appendChild(spec.buildSelect(rewrite))
        head.appendChild(el(d, 'div', 'vj-spacer'))
        const unbind = el(d, 'button', 'vj-audio-unbind')
        unbind.appendChild(el(d, 'i', 'fas fa-times'))
        unbind.title = spec.unbindTitle
        unbind.onclick = () => {
            const fallback = typeof input.default === 'number' && isFinite(input.default) ? input.default : 0.5
            this.apply({ from: arg.range[0], to: arg.range[1], text: fmtNumber(fallback) })
        }
        head.appendChild(unbind)
        wrap.appendChild(head)

        const subRow = (key, label, hint, fmt, ref) => {
            const row = el(d, 'div', 'vj-bind-row')
            row.appendChild(el(d, 'label', 'vj-label vj-bind-label', label))
            const val = el(d, 'span', 'vj-value', fmt(state[key]))
            const track = this.makeFader(d, {
                get: () => state[key],
                ref,
                live: (v) => { state[key] = v; val.textContent = fmt(v) },
                commit: () => rewrite()
            })
            track.title = hint
            this.attachValueEdit(d, val, {
                get: () => state[key],
                set: (v) => { state[key] = v; val.textContent = fmt(v); rewrite() }
            })
            row.appendChild(track)
            row.appendChild(val)
            return row
        }
        wrap.appendChild(subRow('scale', this.tr('panel.audio-scale', 'scale'),
            this.tr('panel.bind-scale-hint', 'range: the 0..1 input is multiplied by this'),
            (v) => '×' + fmtShort(v), 1))
        wrap.appendChild(subRow('offset', this.tr('panel.audio-offset', 'offset'),
            this.tr('panel.bind-offset-hint', 'base value, added after scaling'),
            (v) => (v < 0 ? '' : '+') + fmtShort(v), 0.5))
        return wrap
    }

    // () => a.fft[n] * scale + offset -> boxed bin picker + scale/offset rows
    renderAudioBind(d, input, arg) {
        const state = {
            bin: arg.bin,
            scale: arg.scale ? arg.scale.value : 1,
            offset: arg.offset ? arg.offset.value : 0
        }
        return this.buildBindBox(d, input, arg, {
            cls: 'vj-audio vj-bind',
            icon: '∿',
            iconCls: 'vj-audio-icon',
            state,
            base: (s) => `() => a.fft[${s.bin}]`,
            unbindTitle: this.tr('panel.unbind-audio', 'remove the audio binding'),
            buildSelect: (rewrite) => {
                const sel = el(d, 'select', 'vj-refselect')
                for (let i = 0; i < 4; i++) {
                    const o = el(d, 'option', null, 'fft ' + i)
                    o.value = String(i)
                    if (i === arg.bin) o.selected = true
                    sel.appendChild(o)
                }
                sel.title = this.tr('panel.bind-audio-src', 'audio input: loudness of this fft band, 0..1')
                sel.onchange = () => { state.bin = parseInt(sel.value, 10); rewrite() }
                return sel
            }
        })
    }

    // () => mouse.x / width * scale + offset -> boxed axis picker + scale/offset rows
    renderMouseBind(d, input, arg) {
        const state = {
            axis: arg.axis,
            norm: arg.norm,
            scale: arg.scale ? arg.scale.value : 1,
            offset: arg.offset ? arg.offset.value : 0
        }
        return this.buildBindBox(d, input, arg, {
            cls: 'vj-audio vj-mouse vj-bind',
            icon: '☩',
            iconCls: 'vj-audio-icon vj-mouse-icon',
            state,
            base: (s) => `() => mouse.${s.axis}` +
                (s.norm ? ` / ${s.axis === 'x' ? 'width' : 'height'}` : ''),
            unbindTitle: this.tr('panel.unbind-mouse', 'remove the mouse binding'),
            buildSelect: (rewrite) => {
                const sel = el(d, 'select', 'vj-refselect')
                ;['x', 'y'].forEach((axis) => {
                    const o = el(d, 'option', null, 'mouse ' + axis)
                    o.value = axis
                    if (axis === arg.axis) o.selected = true
                    sel.appendChild(o)
                })
                sel.title = this.tr('panel.bind-mouse-src', 'mouse input: position across the screen, 0..1')
                sel.onchange = () => { state.axis = sel.value; rewrite() }
                return sel
            }
        })
    }

    renderOutChip(d, stmt) {
        const chip = el(d, 'div', 'vj-chip vj-out-chip')
        chip.appendChild(el(d, 'div', 'vj-chip-head')).appendChild(el(d, 'span', 'vj-chip-name', 'out'))
        const body = el(d, 'div', 'vj-chip-params')
        if (stmt.out) {
            const sel = el(d, 'select', 'vj-refselect')
            ;['o0', 'o1', 'o2', 'o3'].forEach((name) => {
                const o = el(d, 'option', null, name)
                o.value = name
                if (name === stmt.out.target) o.selected = true
                sel.appendChild(o)
            })
            sel.onchange = () => {
                if (stmt.out.explicit) this.apply(edits.setOutTarget(stmt.out, sel.value))
                else this.apply(edits.setOutTarget(stmt.out, sel.value)) // inserts at empty arg position
            }
            body.appendChild(sel)
        } else {
            const btn = el(d, 'button', 'vj-addout', '+ out')
            btn.onclick = () => {
                const last = stmt.transforms.length ? stmt.transforms[stmt.transforms.length - 1] : stmt.source
                this.apply(edits.appendOut(last, 'o0'))
            }
            body.appendChild(btn)
        }
        chip.appendChild(body)
        return chip
    }

    renderRenderRow(d, stmt) {
        const rowEl = el(d, 'div', 'vj-setup-row')
        rowEl.appendChild(el(d, 'label', 'vj-label', 'render'))
        const sel = el(d, 'select', 'vj-refselect')
        const quad = el(d, 'option', null, 'quad')
        quad.value = ''
        if (!stmt.target) quad.selected = true
        sel.appendChild(quad)
        ;['o0', 'o1', 'o2', 'o3'].forEach((name) => {
            const o = el(d, 'option', null, name)
            o.value = name
            if (name === stmt.target) o.selected = true
            sel.appendChild(o)
        })
        sel.onchange = () => this.apply({ from: stmt.argRange[0], to: stmt.argRange[1], text: sel.value })
        rowEl.appendChild(sel)
        return rowEl
    }

    // shown when the sketch has no speed line yet: the fader drives the live
    // global, and the first commit writes `speed = N` into the sketch (which
    // then renders as the regular setup row in the same spot)
    renderGhostSpeedRow(d) {
        const rowEl = el(d, 'div', 'vj-setup-row vj-ghostrow')
        rowEl.appendChild(el(d, 'label', 'vj-label', 'speed'))
        const global = this.host.getGlobal('speed')
        let current = typeof global === 'number' ? global : 1
        const valueEl = el(d, 'span', 'vj-value vj-ghost', fmtShort(current))
        const track = this.makeFader(d, {
            get: () => current,
            ref: 1,
            live: (v) => {
                current = v
                valueEl.textContent = fmtShort(v)
                this.host.setGlobal('speed', v)
            },
            commit: (v) => {
                this.host.setGlobal('speed', parseFloat(fmtNumber(v)))
                this.applyQuiet({ from: 0, to: 0, text: `speed = ${fmtNumber(v)}\n` })
            }
        })
        this.attachValueEdit(d, valueEl, {
            get: () => current,
            set: (v) => {
                current = v
                this.host.setGlobal('speed', parseFloat(fmtNumber(v)))
                this.applyQuiet({ from: 0, to: 0, text: `speed = ${fmtNumber(v)}\n` })
            }
        })
        rowEl.appendChild(track)
        rowEl.appendChild(valueEl)
        return rowEl
    }

    renderGlobalRow(d, stmt) {
        const rowEl = el(d, 'div', 'vj-setup-row')
        rowEl.appendChild(el(d, 'label', 'vj-label', stmt.sub))
        const valueEl = el(d, 'span', 'vj-value', fmtShort(stmt.arg.value))
        let current = stmt.arg.value
        const track = this.makeFader(d, {
            get: () => current,
            ref: stmt.sub === 'bpm' ? 30 : 1, // unity/default tempo sits mid-track
            live: (v) => {
                current = v
                valueEl.textContent = fmtShort(v)
                this.host.setGlobal(stmt.sub, v) // speed/bpm are live globals — instant preview
            },
            commit: (v) => {
                // the global already carries the value — write the text without
                // re-evaluating (keeps initCam sketches from re-prompting)
                this.host.setGlobal(stmt.sub, parseFloat(fmtNumber(v)))
                this.applyQuiet(edits.setNumber(stmt.arg, v))
            }
        })
        this.attachValueEdit(d, valueEl, {
            get: () => current,
            set: (v) => {
                current = v
                valueEl.textContent = fmtShort(v)
                this.host.setGlobal(stmt.sub, parseFloat(fmtNumber(v)))
                this.applyQuiet(edits.setNumber(stmt.arg, v))
            }
        })
        rowEl.appendChild(track)
        rowEl.appendChild(valueEl)
        return rowEl
    }

    renderRawRow(d, stmt) {
        const rowEl = el(d, 'button', 'vj-raw-row')
        const label = stmt.kind === 'setup' ? 'setup' : 'code'
        rowEl.appendChild(el(d, 'span', 'vj-label', label))
        const text = (stmt.text || '').replace(/\s+/g, ' ')
        rowEl.appendChild(el(d, 'span', 'vj-raw-text', text.length > 60 ? text.slice(0, 59) + '…' : text))
        rowEl.title = this.tr('panel.raw-hint', 'not chain-editable — click to edit in the code')
        rowEl.onclick = () => this.jumpToRange(stmt.range)
        return rowEl
    }

    jumpToRange(range) {
        this.host.jumpToRange(range)
    }

    // ------------------------------------------------------- palette + menus

    patchPoint(d, root, chainLike, gapIdx) {
        const pp = el(d, 'button', 'vj-pp')
        pp.dataset.gap = gapIdx
        pp.appendChild(el(d, 'span', 'vj-pp-dot'))
        pp.title = this.tr('panel.insert', 'insert a function here')
        pp.onclick = () => {
            const afterStep = gapIdx === 0 ? chainLike.source : chainLike.transforms[gapIdx - 1]
            this.openPalette(d, root, pp, ['coord', 'color', 'combine', 'combineCoord'], (def) => {
                this.apply(edits.insertTransform(afterStep, def))
            })
        }
        return pp
    }

    openChipMenu(d, root, anchor, step, chainLike, index, opts) {
        const isSource = index === -1
        const items = []
        items.push({
            label: this.tr('panel.replace', 'replace'),
            fn: () => {
                const cat = step.meta ? [step.meta.type] : ['src', 'coord', 'color', 'combine', 'combineCoord']
                this.openPalette(d, root, anchor, cat, (def) => {
                    this.apply(edits.replaceStep(step, def, this.model.text))
                })
            },
            keepOpen: true
        })
        if (!isSource) {
            // a step whose args contain '*/' cannot be wrapped in a comment
            const slice = this.model.text.slice(step.span[0], step.span[1])
            if (!slice.includes('*/')) {
                items.push({
                    label: this.tr('panel.bypass', 'bypass'),
                    fn: () => this.apply(edits.bypassTransform(step, this.model.text))
                })
            }
            items.push({
                label: this.tr('panel.duplicate', 'duplicate'),
                fn: () => this.apply(edits.duplicateTransform(step, this.model.text))
            })
            items.push({
                label: this.tr('panel.remove', 'remove'),
                fn: () => this.apply(edits.removeTransform(step)),
                danger: true
            })
        } else if (opts.topLevel && opts.stmt) {
            items.push({
                label: this.tr('panel.remove-chain', 'remove chain'),
                fn: () => this.apply(edits.removeStatement(opts.stmt, this.model.text)),
                danger: true
            })
        }
        this.openPopover(d, root, anchor, (pop) => {
            items.forEach((item) => {
                const b = el(d, 'button', 'vj-menu-item' + (item.danger ? ' vj-danger' : ''), item.label)
                b.onclick = (e) => {
                    e.stopPropagation()
                    if (!item.keepOpen) this.closePopover()
                    item.fn()
                }
                pop.appendChild(b)
            })
        })
    }

    openPalette(d, root, anchor, types, onPick) {
        const groups = grouped(this.transforms).filter((g) => types.includes(g.type))
        this.openPopover(d, root, anchor, (pop) => {
            pop.classList.add('vj-palette')
            const search = el(d, 'input', 'vj-palette-search')
            search.placeholder = this.tr('panel.search', 'search…')
            pop.appendChild(search)
            const list = el(d, 'div', 'vj-palette-list')
            const buttons = []
            groups.forEach((g) => {
                if (!g.fns.length) return
                const cat = el(d, 'div', 'vj-palette-cat type-' + g.type)
                cat.appendChild(el(d, 'div', 'vj-palette-cat-label', g.label))
                g.fns.forEach((def) => {
                    const b = el(d, 'button', 'vj-palette-fn', def.name)
                    b.onclick = (e) => {
                        e.stopPropagation()
                        this.closePopover()
                        onPick(def)
                    }
                    buttons.push({ el: b, name: def.name, cat })
                    cat.appendChild(b)
                })
                list.appendChild(cat)
            })
            pop.appendChild(list)
            search.oninput = () => {
                const q = search.value.toLowerCase()
                buttons.forEach((b) => { b.el.style.display = b.name.toLowerCase().includes(q) ? '' : 'none' })
                list.querySelectorAll('.vj-palette-cat').forEach((c) => {
                    const any = Array.from(c.querySelectorAll('.vj-palette-fn')).some((b) => b.style.display !== 'none')
                    c.style.display = any ? '' : 'none'
                })
            }
            search.onkeydown = (e) => {
                e.stopPropagation()
                if (e.key === 'Escape') this.closePopover()
                if (e.key === 'Enter') {
                    const first = buttons.find((b) => b.el.style.display !== 'none')
                    if (first) first.el.click()
                }
            }
            setTimeout(() => search.focus(), 0)
        })
    }

    openPopover(d, root, anchor, fill) {
        this.closePopover()
        const pop = el(d, 'div', 'vj-popover')
        fill(pop)
        root.appendChild(pop)
        const a = anchor.getBoundingClientRect()
        const r = root.getBoundingClientRect()
        pop.style.left = Math.max(6, Math.min(a.left - r.left, r.width - pop.offsetWidth - 6)) + 'px'
        let top = a.bottom - r.top + 4
        if (top + pop.offsetHeight > r.height - 6) top = Math.max(6, a.top - r.top - pop.offsetHeight - 4)
        pop.style.top = top + 'px'
        this._popover = pop
        this._popoverCloser = (e) => {
            if (!pop.contains(e.target) && e.target !== anchor) this.closePopover()
        }
        d.addEventListener('pointerdown', this._popoverCloser, true)
        this._popoverDoc = d
    }

    closePopover() {
        if (this._popover) {
            this._popover.remove()
            this._popoverDoc.removeEventListener('pointerdown', this._popoverCloser, true)
            this._popover = null
        }
    }

    // -------------------------------------------------------- chip reorder

    attachChipDrag(d, root, handle, chip, chainLike, index) {
        handle.onpointerdown = (e) => {
            if (e.button !== 0 || e.target.closest('.vj-chip-menubtn')) return
            const touch = e.pointerType !== 'mouse'
            const strip = chip.closest('.vj-chips')
            const startX = e.clientX
            const startY = e.clientY
            let lastX = e.clientX
            let ghost = null
            let pps = []
            let targetGap = -1
            let liftTimer = null
            handle.setPointerCapture(e.pointerId)

            const lift = (ev) => {
                ghost = chip.cloneNode(true)
                ghost.className = chip.className + ' vj-drag-ghost'
                ghost.style.width = chip.offsetWidth + 'px'
                ghost.style.left = ev.clientX + 8 + 'px'
                ghost.style.top = ev.clientY + 8 + 'px'
                d.body.appendChild(ghost)
                chip.classList.add('vj-lifting')
                pps = Array.from(chip.parentNode.querySelectorAll(':scope > .vj-pp'))
                chip.parentNode.classList.add('vj-dragging')
                if (touch) {
                    this._touchDrag = true // the long-press menu stands down
                    try { if (navigator.vibrate) navigator.vibrate(15) } catch (err) {}
                }
            }
            // touch: the chip head is the chain's one wide scroll surface, so
            // a plain drag pans the strip — reordering starts from a 350ms
            // hold (the lift), mirroring every mobile list-reorder
            if (touch) {
                liftTimer = setTimeout(() => {
                    liftTimer = null
                    lift(e)
                }, 350)
            }

            const onMove = (ev) => {
                if (!ghost) {
                    if (touch) {
                        if (liftTimer && Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) > 9) {
                            clearTimeout(liftTimer)
                            liftTimer = null
                        }
                        if (!liftTimer && strip) strip.scrollLeft -= ev.clientX - lastX
                        lastX = ev.clientX
                        return
                    }
                    if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < 7) return
                    lift(ev)
                }
                ghost.style.left = ev.clientX + 8 + 'px'
                ghost.style.top = ev.clientY + 8 + 'px'
                let best = -1
                let bestDist = Infinity
                pps.forEach((pp, g) => {
                    const rect = pp.getBoundingClientRect()
                    const dist = Math.abs(ev.clientX - (rect.left + rect.width / 2))
                    if (dist < bestDist) { bestDist = dist; best = g }
                })
                pps.forEach((pp, g) => pp.classList.toggle('vj-pp-target', g === best))
                targetGap = best
            }
            const onUp = () => {
                handle.onpointermove = null
                handle.onpointerup = null
                handle.onpointercancel = null
                if (liftTimer) clearTimeout(liftTimer)
                this._touchDrag = false
                if (ghost) {
                    ghost.remove()
                    chip.classList.remove('vj-lifting')
                    chip.parentNode.classList.remove('vj-dragging')
                    pps.forEach((pp) => pp.classList.remove('vj-pp-target'))
                    if (targetGap >= 0) {
                        const toIdx = targetGap > index ? targetGap - 1 : targetGap
                        if (toIdx !== index) {
                            this.apply(edits.moveTransform(chainLike, index, toIdx, this.model.text))
                        }
                    }
                }
            }
            handle.onpointermove = onMove
            handle.onpointerup = onUp
            handle.onpointercancel = onUp
        }
    }
}
