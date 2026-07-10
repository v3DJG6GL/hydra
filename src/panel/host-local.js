// The same-context host adapter: VJPanel talks to the sketch/synth ONLY
// through this interface, so a deck rendered in the dock, the pop-out or the
// PiP window (all sharing the main window's JS context) uses this class,
// while a remote deck on another device swaps in host-remote.js and every
// call below becomes a websocket intent instead.
//
// Everything here is a straight extraction of what panel.js used to do
// inline — CodeMirror buffer, choo events, LiveBind shadow evals, hydra
// audio/captureStream, speed/bpm globals, localStorage scenes.
import { applyEdit, applyQuietEdit } from './patcher.js'
import LiveBind from './live-bind.js'
import { getTransforms } from './metadata.js'
import { loadScenes, saveScenes, captureThumb, normalizeScenes, SLOT_COUNT } from './scenes.js'

export default class LocalHost {
    constructor(state, emit) {
        this.remote = false
        this.state = state
        this.emit = emit
        this.lb = new LiveBind()
        this.scenes = loadScenes()
        this.panel = null
        this._subs = {}
    }

    bind(panel) {
        this.panel = panel
    }

    // minimal event hookup so the websocket bridge (and the panel) can react
    // to host-side changes without the adapter knowing either of them
    on(evt, fn) {
        (this._subs[evt] = this._subs[evt] || []).push(fn)
    }

    _fire(evt, ...args) {
        (this._subs[evt] || []).forEach((fn) => {
            try { fn(...args) } catch (e) { console.warn('vj host handler failed', e) }
        })
    }

    get cm() {
        return this.state.editor && this.state.editor.editor && this.state.editor.editor.cm
    }

    hasBuffer() {
        return !!this.cm
    }

    ctx() {
        return {
            cm: this.cm,
            emit: this.emit,
            getModel: () => (this.panel && !this.panel.outOfSync ? this.panel.model : null),
            rebuild: () => this.panel && this.panel.rebuild()
        }
    }

    // ------------------------------------------------------------- buffer

    getCode() {
        const cm = this.cm
        return cm ? cm.getValue() : ''
    }

    historySize() {
        const cm = this.cm
        return cm ? cm.historySize() : { undo: 0, redo: 0 }
    }

    // Every deck edit is a CodeMirror buffer splice, so undo/redo simply step
    // the shared editor history and re-evaluate the result. Deck and editor
    // changes form one timeline — undoing past a manual code edit is intended.
    historyStep(dir) {
        const cm = this.cm
        if (!cm) return
        const size = cm.historySize()
        if (!(dir === 'undo' ? size.undo : size.redo)) return
        dir === 'undo' ? cm.undo() : cm.redo()
        const code = cm.getValue()
        this.emit('repl: eval', code)
        this.emit('gallery: save to URL', code, { replace: true })
    }

    applyEdit(edit, opts) {
        return applyEdit(this.ctx(), edit, opts)
    }

    applyQuietEdit(edit) {
        return applyQuietEdit(this.ctx(), edit)
    }

    // Both random actions reuse the editor's own flows (same as the toolbar
    // icons), which write the buffer in several history events (shuffle:
    // clear + setValue, mutate: setValue per eval retry + format pass).
    // The collapse makes ONE deck undo press restore the previous sketch.
    runRandom(kind, changeTransform) {
        const cm = this.cm
        if (!cm) return
        const fn = kind === 'shuffle'
            ? () => this.emit('gallery:showExample')
            // deck semantics: modifier = swap a transform. The editor handler
            // reads metaKey for that (shiftKey there means mutator-undo)
            : () => this.emit('editor: randomize', { metaKey: !!changeTransform })
        const before = cm.getValue()
        const undoBefore = cm.historySize().undo
        fn()
        const after = cm.getValue()
        const added = cm.historySize().undo - undoBefore
        if (after !== before && added > 1) {
            for (let i = 0; i < added; i++) cm.undo()
            if (cm.getValue() === before) {
                cm.replaceRange(after, cm.posFromIndex(0), cm.posFromIndex(before.length), '+vjrandom')
                cm.changeGeneration(true)
            } else {
                // unexpected history shape — put it back, accept multi-step undo
                for (let i = 0; i < added; i++) cm.redo()
            }
        }
    }

    jumpToRange(range) {
        const cm = this.cm
        if (!cm) return
        const from = cm.posFromIndex(range[0])
        const to = cm.posFromIndex(range[1])
        cm.setSelection(from, to)
        cm.focus()
        const editor = this.state.editor && this.state.editor.editor
        if (editor && editor.flashCode) editor.flashCode(from, to)
    }

    // ------------------------------------------------------ synth / runtime

    run(code) {
        this.emit('repl: eval', code)
    }

    // evaluate a live expression once at the current time/mouse state
    // (freeze-to-fader); cb gets a finite number or null
    evalExpr(src, cb) {
        let v = null
        try {
            const fn = window.eval('(' + src + ')')
            if (typeof fn === 'function') v = fn({ time: window.time || 0, bpm: window.bpm || 30 })
            else if (typeof fn === 'number') v = fn
        } catch (e) { /* fall through to null */ }
        cb(typeof v === 'number' && isFinite(v) ? v : null)
    }

    getTransforms() {
        return getTransforms()
    }

    // the synth's own audio reference — survives sketches that assign to the
    // bare global `a` (repl restores the global too, but don't depend on it)
    audio() {
        const h = window.hydraSynth
        return (h && h.synth && h.synth.a) || window.a || null
    }

    audioCall(fn, value) {
        const audio = this.audio()
        if (audio && typeof audio[fn] === 'function') {
            try { audio[fn](value) } catch (e) { /* audio not ready */ }
        }
    }

    // FFT monitor canvas on this screen; returns false when audio isn't up
    audioShow(on) {
        const audio = this.audio()
        if (!audio || typeof audio.show !== 'function') return false
        try { on ? audio.show() : audio.hide() } catch (e) { /* audio not ready */ }
        return true
    }

    // hydra's canvas capture stream (feeds the pop-out/PiP ◉ LIVE preview);
    // null on browsers without captureStream support
    captureStream() {
        const h = window.hydraSynth
        return (h && h.captureStream) || null
    }

    canPreview() {
        return !!this.captureStream()
    }

    getGlobal(name) {
        return window[name]
    }

    setGlobal(name, value) {
        window[name] = value
    }

    getShowCode() {
        return this.state.showCode !== false
    }

    toggleCode() {
        this.emit('ui: toggle code')
    }

    // -------------------------------------------------------------- scenes

    sceneSave(i) {
        const cm = this.cm
        if (!cm) return
        const code = cm.getValue()
        this.scenes[i] = { code, thumb: null, savedAt: Date.now() }
        saveScenes(this.scenes)
        this._fire('scenes-changed')
        const hydra = this.state.hydra && this.state.hydra.hydra
        captureThumb(hydra, (thumb) => {
            if (thumb && this.scenes[i] && this.scenes[i].code === code) {
                this.scenes[i].thumb = thumb
                saveScenes(this.scenes)
                this._fire('scenes-changed')
            }
        })
    }

    sceneRecall(i, opts) {
        const scene = this.scenes[i]
        if (!scene) return
        if (opts && opts.replaceURL) {
            // auto-cycle recalls must not flood the browser history
            this.emit('editor: load code', scene.code)
            this.emit('repl: eval', scene.code)
            this.emit('gallery: save to URL', scene.code, { replace: true })
        } else {
            this.emit('load and eval code', scene.code, true)
        }
    }

    sceneClear(i) {
        this.scenes[i] = null
        saveScenes(this.scenes)
        this._fire('scenes-changed')
    }

    sceneMove(from, to) {
        if (from === to || from < 0 || from >= this.scenes.length || !this.scenes[from]) return
        const [moved] = this.scenes.splice(from, 1)
        this.scenes.splice(to, 0, moved)
        saveScenes(this.scenes)
        this._fire('scenes-changed')
    }

    // the + tile: grow the bank by one slot and save the current sketch there
    sceneAdd() {
        if (!this.cm) return
        this.scenes.push(null)
        this.sceneSave(this.scenes.length - 1)
    }

    // drop a slot entirely (empty slots only, and never below the base row)
    sceneRemove(i) {
        if (this.scenes.length <= SLOT_COUNT || this.scenes[i] || i < 0 || i >= this.scenes.length) return
        this.scenes.splice(i, 1)
        saveScenes(this.scenes)
        this._fire('scenes-changed')
    }

    // replaces the whole bank (import); accepts anything json-shaped and
    // normalizes it to {code, thumb, savedAt} slots (at least SLOT_COUNT)
    sceneReplaceAll(arr) {
        this.scenes = normalizeScenes(arr)
        saveScenes(this.scenes)
        this._fire('scenes-changed')
    }
}
