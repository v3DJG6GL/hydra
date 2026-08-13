// MIDI-learn: right-click a fader, move a controller knob, bound. Buttons
// work too: a param can learn a note as a *toggle* (each hit flips between
// the mapping's min/max) or as *hold* (max while pressed, min on release),
// scene slots learn note-ons from their menu, and HUSH learns a pad from
// its right-click menu. A mapped CC drives the same live-uniform table the
// faders use (LiveBind), so hardware control never recompiles shaders; the
// value is committed into the code after ~600ms of controller silence — as
// a quiet text splice while the binding is live, so a knob burst costs at
// most one eval. A learned knob has NO range: it drives the value the same
// way the on-screen fader does — relative, unbounded, sensitivity scaled to
// the value's magnitude at the start of each burst. "midi range…" in the
// fader menu optionally pins an absolute min/max (the knob position then
// maps straight onto that span); clearing it goes back to unlimited.
// Mappings persist
// in localStorage, keyed by the arg's stable path (which embeds the function
// name, so a mapping deactivates when the sketch structure changes under it).
import { edits } from './patcher.js'
import { fmtNumber } from './metadata.js'

const KEY = 'hydra-vj-midi'
const COMMIT_IDLE_MS = 600

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

// the identity of the hardware control behind a mapping: a short scribble
// label ("CC21", "D#2·2" — channel suffix only off channel 1) and one of 8
// palette slots, so the same knob/pad wears the same color everywhere
export function controlInfo(m) {
    if (!m) return null
    const isCC = m.cc !== undefined
    const num = isCC ? m.cc : m.note
    if (typeof num !== 'number') return null
    const ch = m.ch || 0
    const name = isCC ? 'CC' + num : NOTE_NAMES[num % 12] + (Math.floor(num / 12) - 2)
    return { label: name + (ch ? '·' + (ch + 1) : ''), color: ((isCC ? num : num + 128) + ch * 37) % 8 }
}

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
        // params: path -> {cc, ch [, min, max]} (knob — min/max only if set)
        //               | {note, ch, mode:'toggle'|'push', on} (button)
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
            this.error = (e && e.name) || 'denied'
            return false
        }
        this.error = null
        const attach = () => {
            this.access.inputs.forEach((input) => { input.onmidimessage = (e) => this.onMessage(e.data) })
        }
        attach()
        this.access.onstatechange = attach
        return true
    }

    _toast(msg, kind) {
        if (this.c.host && this.c.host._fire) this.c.host._fire('toast', msg, kind)
    }

    // arm a learn — with feedback, since a silently failing "midi learn"
    // click is indistinguishable from a dead button: the browser may refuse
    // access (permission prompt dismissed, Firefox without its Web MIDI
    // site permission), or grant it with no controller plugged in
    async _arm(learning) {
        if (!(await this.enable())) {
            this._toast(this.c.tr('panel.midi-denied',
                'midi access refused by the browser') + (this.error ? ` (${this.error})` : '') +
                ' — ' + this.c.tr('panel.midi-denied-hint', 'allow MIDI for this site and retry'), 'error')
            return false
        }
        let inputs = 0
        this.access.inputs.forEach(() => inputs++)
        if (!inputs) {
            this._toast(this.c.tr('panel.midi-no-inputs',
                'no midi device found — connect a controller (it is picked up automatically)'), 'error')
        }
        this.learning = learning
        this.c.renderAll()
        return true
    }

    isMapped(path) {
        return !!this.mappings.params[path]
    }

    paramControl(path) {
        return controlInfo(this.mappings.params[path])
    }

    _keyControl(key) {
        const m = /^n(\d+)c(\d+)$/.exec(key)
        return m ? controlInfo({ note: +m[1], ch: +m[2] }) : null
    }

    sceneControl(slot) {
        for (const [k, v] of Object.entries(this.mappings.scenes)) {
            if (v === slot) return this._keyControl(k)
        }
        return null
    }

    actionControl(action) {
        for (const [k, v] of Object.entries(this.mappings.actions)) {
            if (v === action) return this._keyControl(k)
        }
        return null
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

    // hint: the value a pad's on-level derives from when the arg isn't in the
    // model yet (a ghost default still being materialized on a remote deck).
    // Default mode 'auto': the first thing the hardware sends decides — a CC
    // becomes a knob mapping, a note-on becomes a toggle pad.
    startLearn(path, mode, hint) {
        return this._arm({ path, mode: mode || 'auto', hint })
    }

    startLearnScene(slot) {
        return this._arm({ scene: slot })
    }

    startLearnAction(action) {
        return this._arm({ action })
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

    // pin an absolute range onto a knob mapping — from then on the knob
    // position maps straight onto min..max instead of moving relatively
    setRange(path, min, max) {
        const m = this.mappings.params[path]
        if (!m || !isFinite(min) || !isFinite(max)) return
        m.min = min
        m.max = max
        this.persist()
    }

    // back to the default: unlimited, relative
    clearRange(path) {
        const m = this.mappings.params[path]
        if (!m) return
        delete m.min
        delete m.max
        delete m.custom
        this.persist()
    }

    // one hardware control drives one thing: a fresh learn steals the knob or
    // pad from whatever held it before — params, scene pads and actions alike
    _releaseControl(ctl, ch) {
        for (const [path, m] of Object.entries(this.mappings.params)) {
            if (m.ch !== ch) continue
            if ((ctl.cc !== undefined && m.cc === ctl.cc) ||
                (ctl.note !== undefined && m.note === ctl.note)) {
                delete this.mappings.params[path]
            }
        }
        if (ctl.note !== undefined) {
            const key = `n${ctl.note}c${ch}`
            delete this.mappings.scenes[key]
            delete this.mappings.actions[key]
        }
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
                this._releaseControl({ note: d1 }, ch)
                if (l.scene != null) this.mappings.scenes[key] = l.scene
                else if (l.action) this.mappings.actions[key] = l.action
                else if (l.path != null) {
                    // pads carry no range: they mute/unmute the param. `on` is
                    // the fallback level for a param that is 0 at first press
                    const model = this.c.ctx().getModel()
                    const arg = model && model.pathIndex.get(l.path)
                    const v0 = arg ? arg.value : (isFinite(l.hint) ? l.hint : 0)
                    const mode = l.mode === 'auto' ? 'toggle' : l.mode
                    this.mappings.params[l.path] = { note: d1, ch, mode, on: v0 || 1 }
                }
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
                // hold buttons release back to silence
                if (m.note === d1 && m.ch === ch && m.mode === 'push') this.applyValue(path, m, 0)
            }
            return
        }
        if (kind !== 0xb0) return // control change from here on
        if (this.learning && this.learning.path != null &&
            (this.learning.mode === 'auto' || this.learning.mode === 'cc')) {
            const { path } = this.learning
            this.learning = null
            this._releaseControl({ cc: d1 }, ch)
            // no range — the knob drives the value relatively, like the fader
            this.mappings.params[path] = { cc: d1, ch }
            this.persist()
            this.c.renderAll()
        }
        for (const [path, m] of Object.entries(this.mappings.params)) {
            if (m.cc === d1 && m.ch === ch) this.applyCC(path, m, d2)
        }
    }

    // a knob message. With a pinned range the position maps onto min..max;
    // without one it moves the value like the on-screen fader: relative and
    // unbounded, one full knob sweep ≈ 2× the value's magnitude at the start
    // of the burst (a burst ends after the commit idle, so re-grabbing the
    // knob recalibrates the sensitivity — same as re-grabbing the fader)
    applyCC(path, m, d2) {
        if (isFinite(m.min) && isFinite(m.max)) {
            return this.applyValue(path, m, m.min + (d2 / 127) * (m.max - m.min))
        }
        let a = this.active.get(path)
        if (!a || a.last === undefined) {
            const model = this.c.ctx().getModel()
            const arg = model && model.pathIndex.get(path)
            const cur = a && a.value !== undefined ? a.value : (arg && isFinite(arg.value) ? arg.value : 0)
            this.applyValue(path, m, cur) // arms the live bind + commit timer
            a = this.active.get(path)
            if (!a) return // param can't be driven (missing, noLive, …)
            a.acc = cur
            a.scale = Math.max(Math.abs(cur), 0.5)
            a.last = d2
            return
        }
        a.acc += ((d2 - a.last) / 127) * 2 * a.scale
        a.last = d2
        this.applyValue(path, m, a.acc)
    }

    runAction(action) {
        if (action === 'hush') this.c.host.run('hush()')
    }

    // pads mute/unmute — no range involved. Toggle: a non-zero param
    // remembers its level and snaps to 0; a zero param comes back to the
    // remembered level (or the level it had at learn time). Hold: the on
    // level while pressed, 0 on release. A knob moving the same param
    // updates what "on" means — whatever value the pad silenced, it restores.
    _onLevel(m) {
        // m.max covers pad mappings persisted by older builds (ranged pads)
        const v = m.prev !== undefined ? m.prev : (m.on !== undefined ? m.on : m.max)
        return isFinite(v) && v !== 0 ? v : 1
    }

    pressButton(path, m) {
        const a = this.active.get(path)
        let cur = a && a.value !== undefined ? a.value : null
        if (cur === null) {
            const model = this.c.ctx().getModel()
            const arg = model && model.pathIndex.get(path)
            cur = arg ? arg.value : 0
        }
        if (cur) {
            m.prev = cur
            this.persist()
        }
        if (m.mode === 'push') return this.applyValue(path, m, this._onLevel(m))
        this.applyValue(path, m, cur ? 0 : this._onLevel(m))
    }

    // setup rows (speed = / bpm = / a.setSmooth() …) are globals, not shader
    // uniforms — LiveBind can't drive them (a shadow eval would turn `speed`
    // into a function). Their fader's live() path is a direct setter call;
    // MIDI takes the same road.
    _setupStmtFor(model, arg) {
        return (model.statements || []).find((s) => s.kind === 'setup' && s.arg === arg) || null
    }

    applyValue(path, m, raw) {
        const ctx = this.c.ctx()
        const model = ctx.getModel()
        if (!model) return
        const arg = model.pathIndex.get(path)
        if (!arg || arg.kind !== 'number' || arg.noLive) return
        let value = parseFloat(raw.toFixed(4))
        let a = this.active.get(path)
        if (!a) {
            a = {}
            this.active.set(path, a)
        }
        const setup = this._setupStmtFor(model, arg)
        if (setup) {
            if (setup.sub === 'audioSet') {
                if (setup.fn === 'setBins') value = Math.max(1, Math.round(value))
                this.c.host.audioCall(setup.fn, value)
            } else {
                this.c.host.setGlobal(setup.sub, value)
            }
            a.setup = true
            a.value = value
            this.c.flashParamValue(path, value)
            this.c.revealParam(path)
            clearTimeout(a.timer)
            a.timer = setTimeout(() => this.commit(path), COMMIT_IDLE_MS)
            return
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
        this.c.revealParam(path)
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
        if (a.setup) {
            // the live global/setter already carries the value (applyValue) —
            // text splice only, same as the setup fader's commit
            const setup = this._setupStmtFor(model, arg)
            if (setup && setup.sub !== 'audioSet') this.c.host.setGlobal(setup.sub, parseFloat(fmtNumber(a.value)))
            this.c.applyQuiet(edits.setNumber(arg, a.value))
            return
        }
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
