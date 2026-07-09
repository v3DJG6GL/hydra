// MIDI-learn: right-click a fader, move a controller knob, bound. Scene slots
// learn note-on messages the same way (right-click a slot, hit a pad).
// A mapped CC drives the same live-uniform table the faders use (LiveBind),
// so hardware control never recompiles shaders; the value is committed into
// the code after ~600ms of knob silence — as a quiet text splice while the
// binding is live, so a knob burst costs at most one eval. Mappings persist
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
            if (m.params || m.scenes) return { params: m.params || {}, scenes: m.scenes || {} }
            return { params: m, scenes: {} } // pre-scene flat format
        }
    } catch (e) { /* fresh */ }
    return { params: {}, scenes: {} }
}

export default class MidiControl {
    constructor(controller) {
        this.c = controller
        this.access = null
        this.learning = null // {path} | {scene}
        this.mappings = loadMappings() // {params: path -> {cc, ch, min, max}, scenes: 'n<note>c<ch>' -> slot}
        this.active = new Map() // path -> {key, value, timer}
        this.available = typeof navigator !== 'undefined' && !!navigator.requestMIDIAccess
    }

    persist() {
        try { localStorage.setItem(KEY, JSON.stringify(this.mappings)) } catch (e) { /* ignore */ }
    }

    hasMappings() {
        return Object.keys(this.mappings.params).length > 0 || Object.keys(this.mappings.scenes).length > 0
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

    async startLearn(path) {
        if (!(await this.enable())) return false
        this.learning = { path }
        this.c.renderAll()
        return true
    }

    async startLearnScene(slot) {
        if (!(await this.enable())) return false
        this.learning = { scene: slot }
        this.c.renderAll()
        return true
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
        this.persist()
    }

    // exported separately from the event plumbing so it can be driven in tests
    onMessage(data) {
        const [status, d1, d2] = data
        const kind = status & 0xf0
        const ch = status & 0x0f
        if (kind === 0x90 && d2 > 0) { // note on -> scene pads
            if (this.learning && this.learning.scene != null) {
                this.mappings.scenes[`n${d1}c${ch}`] = this.learning.scene
                this.learning = null
                this.persist()
                this.c.renderAll()
                return
            }
            const slot = this.mappings.scenes[`n${d1}c${ch}`]
            if (slot != null) this.c.recallScene(slot)
            return
        }
        if (kind !== 0xb0) return // control change from here on
        if (this.learning && this.learning.path != null) {
            const path = this.learning.path
            this.learning = null
            const model = this.c.ctx().getModel()
            const arg = model && model.pathIndex.get(path)
            const v0 = arg ? arg.value : 0
            const ref = Math.max(Math.abs(v0), 0.5)
            this.mappings.params[path] = { cc: d1, ch, min: v0 < 0 ? -2 * ref : 0, max: 2 * ref }
            this.persist()
            this.c.renderAll()
        }
        for (const [path, m] of Object.entries(this.mappings.params)) {
            if (m.cc === d1 && m.ch === ch) this.apply(path, m, d2)
        }
    }

    apply(path, m, ccValue) {
        const ctx = this.c.ctx()
        const model = ctx.getModel()
        if (!model) return
        const arg = model.pathIndex.get(path)
        if (!arg || arg.kind !== 'number' || arg.noLive) return
        const value = parseFloat((m.min + (ccValue / 127) * (m.max - m.min)).toFixed(4))
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
