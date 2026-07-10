// MIDI-learn: right-click a fader, move a controller knob, bound. Buttons
// work too: a param can learn a note as a *toggle* (each hit flips between
// the mapping's min/max) or as *hold* (max while pressed, min on release),
// scene slots learn note-ons from their menu, and HUSH learns a pad from
// its right-click menu. A mapped CC drives the same live-uniform table the
// faders use (LiveBind), so hardware control never recompiles shaders; the
// value is committed into the code after ~600ms of controller silence — as
// a quiet text splice while the binding is live, so a knob burst costs at
// most one eval. Every param mapping carries a min/max range (edited via
// "midi range…" in the fader menu; the default derives from the value at
// learn time, and a custom range survives re-learning). Mappings persist
// in localStorage, keyed by the arg's stable path (which embeds the function
// name, so a mapping deactivates when the sketch structure changes under it).
import { edits } from './patcher.js'
import { fmtNumber } from './metadata.js'

const KEY = 'hydra-vj-midi'
const COMMIT_IDLE_MS = 600

function loadMappings() {
    try {
        const m = JSON.parse(localStorage.getItem(KEY))
        if (m && typeof m === 'object') {
            if (m.params || m.scenes || m.actions) {
                return { params: m.params || {}, scenes: m.scenes || {}, actions: m.actions || {} }
            }
            return { params: m, scenes: {}, actions: {} } // pre-scene flat format
        }
    } catch (e) { /* fresh */ }
    return { params: {}, scenes: {}, actions: {} }
}

export default class MidiControl {
    constructor(controller) {
        this.c = controller
        this.access = null
        this.learning = null // {path, mode:'cc'|'toggle'|'push'} | {scene} | {action}
        // params: path -> {cc, ch, min, max} (knob)
        //               | {note, ch, mode:'toggle'|'push', min, max} (button)
        // scenes: 'n<note>c<ch>' -> slot     actions: 'n<note>c<ch>' -> 'hush'
        this.mappings = loadMappings()
        this.active = new Map() // path -> {key, value, timer}
        this.available = typeof navigator !== 'undefined' && !!navigator.requestMIDIAccess
    }

    persist() {
        try { localStorage.setItem(KEY, JSON.stringify(this.mappings)) } catch (e) { /* ignore */ }
    }

    hasMappings() {
        return Object.keys(this.mappings.params).length > 0 ||
            Object.keys(this.mappings.scenes).length > 0 ||
            Object.keys(this.mappings.actions).length > 0
    }

    async enable() {
        if (this.access) return true
        if (!this.available) return false
        try {
            this.access = await navigator.requestMIDIAccess()
        } catch (e) {
            console.warn('vj panel: MIDI access denied', e)
            return false
        }
        const attach = () => {
            this.access.inputs.forEach((input) => { input.onmidimessage = (e) => this.onMessage(e.data) })
        }
        attach()
        this.access.onstatechange = attach
        return true
    }

    isMapped(path) {
        return !!this.mappings.params[path]
    }

    isLearning(path) {
        return !!this.learning && this.learning.path === path
    }

    isSceneMapped(slot) {
        return Object.values(this.mappings.scenes).includes(slot)
    }

    isLearningScene(slot) {
        return !!this.learning && this.learning.scene === slot
    }

    async startLearn(path, mode) {
        if (!(await this.enable())) return false
        this.learning = { path, mode: mode || 'cc' }
        this.c.renderAll()
        return true
    }

    async startLearnScene(slot) {
        if (!(await this.enable())) return false
        this.learning = { scene: slot }
        this.c.renderAll()
        return true
    }

    async startLearnAction(action) {
        if (!(await this.enable())) return false
        this.learning = { action }
        this.c.renderAll()
        return true
    }

    isActionMapped(action) {
        return Object.values(this.mappings.actions).includes(action)
    }

    isLearningAction(action) {
        return !!this.learning && this.learning.action === action
    }

    unlearnAction(action) {
        for (const [k, v] of Object.entries(this.mappings.actions)) {
            if (v === action) delete this.mappings.actions[k]
        }
        this.persist()
        this.c.renderAll()
    }

    cancelLearn() {
        this.learning = null
        this.c.renderAll()
    }

    unlearn(path) {
        delete this.mappings.params[path]
        this.persist()
        const a = this.active.get(path)
        if (a) {
            clearTimeout(a.timer)
            this.active.delete(path)
        }
        this.c.lb.drop(path)
        this.c.renderAll()
    }

    unlearnScene(slot) {
        for (const [k, v] of Object.entries(this.mappings.scenes)) {
            if (v === slot) delete this.mappings.scenes[k]
        }
        this.persist()
        this.c.renderAll()
    }

    setRange(path, min, max) {
        const m = this.mappings.params[path]
        if (!m || !isFinite(min) || !isFinite(max)) return
        m.min = min
        m.max = max
        m.custom = true
        this.persist()
    }

    // a hand-set range survives re-learning; auto-derived ones re-derive
    // from the value at learn time (0..2× for positives, symmetric for
    // negatives)
    _rangeFor(path) {
        const prev = this.mappings.params[path]
        if (prev && prev.custom && isFinite(prev.min) && isFinite(prev.max)) {
            return { min: prev.min, max: prev.max, custom: true }
        }
        const model = this.c.ctx().getModel()
        const arg = model && model.pathIndex.get(path)
        const v0 = arg ? arg.value : 0
        const ref = Math.max(Math.abs(v0), 0.5)
        return { min: v0 < 0 ? -2 * ref : 0, max: 2 * ref }
    }

    // exported separately from the event plumbing so it can be driven in tests
    onMessage(data) {
        const [status, d1, d2] = data
        const kind = status & 0xf0
        const ch = status & 0x0f
        if (kind === 0x90 && d2 > 0) { // note on: pads and buttons
            const key = `n${d1}c${ch}`
            if (this.learning) {
                const l = this.learning
                if (l.scene != null) this.mappings.scenes[key] = l.scene
                else if (l.action) this.mappings.actions[key] = l.action
                else if (l.path != null && l.mode !== 'cc') {
                    this.mappings.params[l.path] = { note: d1, ch, mode: l.mode, ...this._rangeFor(l.path) }
                } else return // knob learn armed — pads don't complete it
                this.learning = null
                this.persist()
                this.c.renderAll()
                return
            }
            const slot = this.mappings.scenes[key]
            if (slot != null) this.c.recallScene(slot)
            const action = this.mappings.actions[key]
            if (action) this.runAction(action)
            for (const [path, m] of Object.entries(this.mappings.params)) {
                if (m.note === d1 && m.ch === ch) this.pressButton(path, m)
            }
            return
        }
        if (kind === 0x80 || (kind === 0x90 && d2 === 0)) { // note off
            for (const [path, m] of Object.entries(this.mappings.params)) {
                // hold buttons release back to their min
                if (m.note === d1 && m.ch === ch && m.mode === 'push') this.applyValue(path, m, m.min)
            }
            return
        }
        if (kind !== 0xb0) return // control change from here on
        if (this.learning && this.learning.path != null && this.learning.mode === 'cc') {
            const path = this.learning.path
            this.learning = null
            this.mappings.params[path] = { cc: d1, ch, ...this._rangeFor(path) }
            this.persist()
            this.c.renderAll()
        }
        for (const [path, m] of Object.entries(this.mappings.params)) {
            if (m.cc === d1 && m.ch === ch) this.applyValue(path, m, m.min + (d2 / 127) * (m.max - m.min))
        }
    }

    runAction(action) {
        if (action === 'hush') this.c.host.run('hush()')
    }

    pressButton(path, m) {
        if (m.mode === 'push') return this.applyValue(path, m, m.max)
        // toggle: flip to whichever end of the range the param is not at
        const a = this.active.get(path)
        let cur = a && a.value !== undefined ? a.value : null
        if (cur === null) {
            const model = this.c.ctx().getModel()
            const arg = model && model.pathIndex.get(path)
            cur = arg ? arg.value : m.min
        }
        this.applyValue(path, m, cur >= (m.min + m.max) / 2 ? m.min : m.max)
    }

    applyValue(path, m, raw) {
        const ctx = this.c.ctx()
        const model = ctx.getModel()
        if (!model) return
        const arg = model.pathIndex.get(path)
        if (!arg || arg.kind !== 'number' || arg.noLive) return
        const value = parseFloat(raw.toFixed(4))
        let a = this.active.get(path)
        if (!a) {
            a = {}
            this.active.set(path, a)
        }
        if (!a.key || !this.c.lb.isLive(path)) {
            const key = this.c.lb.ensure(ctx, path, value)
            if (!key) {
                this.active.delete(path)
                return
            }
            a.key = key
        }
        a.value = value
        this.c.lb.set(a.key, value)
        this.c.flashParamValue(path, value)
        clearTimeout(a.timer)
        a.timer = setTimeout(() => this.commit(path), COMMIT_IDLE_MS)
    }

    commit(path) {
        const a = this.active.get(path)
        if (!a) return
        this.active.delete(path)
        const ctx = this.c.ctx()
        const model = ctx.getModel()
        const arg = model && model.pathIndex.get(path)
        if (!arg || arg.kind !== 'number') return
        if (a.key && this.c.lb.isLive(path)) {
            // the program already shows this value through its uniform —
            // write the text only (no eval, no setup side effects)
            this.c.lb.set(a.key, parseFloat(fmtNumber(a.value)))
            this.c.applyQuiet(edits.setNumber(arg, a.value))
        } else {
            this.c.apply(edits.setNumber(arg, a.value), { replaceURL: true })
        }
    }
}
