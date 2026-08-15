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
// name, so a mapping deactivates when the sketch structure changes under it —
// and wakes up again when a scene with that structure comes back). Ownership
// is scene-scoped: the reassign prompt, control stealing and the LED ring only
// consider mappings whose path resolves in the CURRENT sketch, so every scene
// can reuse the same knobs without trampling the others' assignments.
import { edits } from './patcher.js'
import { fmtNumber } from './metadata.js'

const KEY = 'hydra-vj-midi'
const LED_KEY = 'hydra-vj-midi-led'
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
            if (m.params || m.scenes || m.actions || m.slots) {
                return { params: m.params || {}, scenes: m.scenes || {}, actions: m.actions || {}, slots: m.slots || {} }
            }
            return { params: m, scenes: {}, actions: {}, slots: {} } // pre-scene flat format
        }
    } catch (e) { /* fresh */ }
    return { params: {}, scenes: {}, actions: {}, slots: {} }
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
        this.syncLeds() // diff-based: no-op unless assignments changed
    }

    // ---- controller LED feedback (opt-in, ⚡ MAP right-click) ------------
    // Light only the ASSIGNED knobs/pads. We can only speak generic MIDI:
    // echoing a control's own message back (note-on vel 127 / CC value 127)
    // lights it on most pad and knob controllers, 0 darkens it. Opt-in
    // because unsolicited note-ons would PLAY notes on a synth that happens
    // to be connected too. Devices whose LEDs are driven internally (Korg
    // nano* default mode) need their editor set to 'external' LED mode.

    ledEnabled() {
        try { return localStorage.getItem(LED_KEY) === '1' } catch (e) { return false }
    }

    async setLed(on) {
        try {
            if (on) localStorage.setItem(LED_KEY, '1')
            else localStorage.removeItem(LED_KEY)
        } catch (e) { /* private mode */ }
        if (on) {
            if (!(await this.enable())) return false
            this.syncLeds(true)
        } else {
            this._ledOff()
        }
        return true
    }

    // DAW/handshake ports must NEVER receive LED echoes: they speak DAW
    // protocols, and stray notes/CCs there read as a DAW connecting (the
    // Launch Control XL 3 answered ours with its HUI mode-select screen).
    // 'MIDIIN2/MIDIOUT2' covers Windows' naming of second ports.
    _isDawPort(name) {
        return /\bDAW\b|MIDIIN2|MIDIOUT2/i.test(name || '')
    }

    // Launch Control XL 3: custom-mode LEDs are internally driven, echoes on
    // its MIDI port don't stick — it gets its own driver over the DAW port
    _isXl3(name) {
        return /LCXL3|launch\s*control\s*xl\s*3/i.test(name || '')
    }

    // the controller's own output port usually carries the same name as its
    // input — prefer those, so we don't blast a second, output-only device
    _ledOuts() {
        const outs = []
        const all = []
        if (!this.access || !this.access.outputs) return outs
        const inNames = new Set()
        this.access.inputs.forEach((i) => inNames.add(i.name))
        this.access.outputs.forEach((o) => {
            if (this._isDawPort(o.name) || this._isXl3(o.name)) return
            all.push(o)
            if (inNames.has(o.name)) outs.push(o)
        })
        return outs.length ? outs : all
    }

    _litSet() {
        const lit = new Set()
        for (const [path, m] of Object.entries(this.mappings.params)) {
            if (!this._resolves(path)) continue // parked on another scene's sketch
            const ch = m.ch || 0
            if (m.note !== undefined) lit.add(`n${m.note}c${ch}`)
            else if (m.cc !== undefined) lit.add(`c${m.cc}c${ch}`)
        }
        Object.keys(this.mappings.scenes).forEach((k) => lit.add(k))
        Object.keys(this.mappings.actions).forEach((k) => lit.add(k))
        return lit
    }

    _ledMsg(key, on) {
        let m = /^n(\d+)c(\d+)$/.exec(key)
        if (m) return [(on ? 0x90 : 0x80) | +m[2], +m[1], on ? 127 : 0]
        m = /^c(\d+)c(\d+)$/.exec(key)
        if (m) return [0xb0 | +m[2], +m[1], on ? 127 : 0]
        return null
    }

    // `full` also darkens every note/CC first (on the channels involved),
    // so a device that woke up fully lit starts from black
    syncLeds(full) {
        if (!this.ledEnabled() || !this.access) return
        const outs = this._ledOuts()
        if (!outs.length) return
        const send = (msg) => outs.forEach((o) => { try { o.send(msg) } catch (e) { /* port closed */ } })
        const lit = this._litSet()
        if (full) {
            const chans = new Set([0])
            lit.forEach((k) => { const m = /c(\d+)$/.exec(k); if (m) chans.add(+m[1]) })
            for (const ch of chans) {
                for (let n = 0; n < 128; n++) {
                    send([0x80 | ch, n, 0])
                    // CC 120-127 are channel-mode messages (all notes off,
                    // omni/mono/poly) — "clearing" them RESETS some devices,
                    // which snaps their LEDs back to the all-bright default
                    if (n < 120) send([0xb0 | ch, n, 0])
                }
            }
            this._lit = new Set()
        }
        const prev = this._lit || new Set()
        for (const k of prev) {
            if (!lit.has(k)) {
                const msg = this._ledMsg(k, false)
                if (msg) send(msg)
            }
        }
        for (const k of lit) {
            if (!prev.has(k)) {
                const msg = this._ledMsg(k, true)
                if (msg) send(msg)
            }
        }
        this._lit = lit
        // the Launch Control XL 3 rides its own driver — start it on the
        // first full sync, diff it along afterwards
        if (this._xl3State().on) this._xl3Sync(full)
        else if (full && this._xl3DawOuts().length) this._xl3Setup()
    }

    _ledOff() {
        if (!this.access) return
        const outs = this._ledOuts()
        const prev = this._lit || this._litSet()
        for (const k of prev) {
            const msg = this._ledMsg(k, false)
            if (msg) outs.forEach((o) => { try { o.send(msg) } catch (e) { /* port closed */ } })
        }
        this._lit = new Set()
        this._xl3Exit()
    }

    // ---- Launch Control XL 3 LED driver (over its DAW port) --------------
    // In standalone custom modes the XL3 drives its own LEDs and ignores
    // echoes on the MIDI port; LED control only exists in DAW mode. And
    // DAW mode (9F 0C 7F on the DAW port; 9F 0C 00 exits) changes what
    // the hardware IS: the whole surface reports as plain CCs on the DAW
    // port — encoders/faders on ch 16, buttons on ch 1 — while the custom
    // mode goes silent (programmer's reference, "The surface in DAW
    // mode"). So with LEDs enabled the deck speaks DAW surface: those CCs
    // feed the normal learn/drive path, and a control's CC number doubles
    // as its LED index — B0 <index> <palette colour> (faders 5-12,
    // encoders 13-36, button rows 37-52) — so a control learned over the
    // DAW port lights the moment it's learned, no discovery dance (m.xd
    // marks such mappings; touch-tied m.pi remains for anything else).
    // Surface-mode reports (B6 1E) are followed, never sent: flipping the
    // device's Mode button to a custom surface (6+) pauses painting (the
    // device owns its LEDs there) and the user's standalone mappings
    // stream again; back on a DAW surface (1/2) the deck repaints.
    //
    // NEVER send a surface select (B6 1E) while the DAW-mode note-on is
    // latched — the reference suggests it, but on real hardware it
    // half-exits DAW mode: LED writes stop painting and 9F 0C 7F is
    // refused until the device is power-cycled (probe P2 vs the
    // P2-skipped run, 2026-08).

    _xl3DawOuts() {
        const outs = []
        if (!this.access || !this.access.outputs) return outs
        this.access.outputs.forEach((o) => {
            if (this._isXl3(o.name) && this._isDawPort(o.name)) outs.push(o)
        })
        return outs
    }

    _xl3State() {
        if (!this._xl3) this._xl3 = { on: false, surface: 1, touch: null, lit: new Map() }
        return this._xl3
    }

    // DAW-port traffic. Handshake/report messages are consumed here (mode
    // ACKs are note-ons on ch 16 — those must never complete a pad learn),
    // touch and surface reports update driver state, and the DAW surface's
    // own CC stream is handed to the normal learn/drive path.
    _onXl3Daw(data) {
        const [status, d1, d2] = data
        const x = this._xl3State()
        // BE <index> <127|0>: encoder/fader touch on channel 15
        if (status === 0xbe) {
            if (d2 > 0) x.touch = { idx: d1, t: Date.now() }
            return
        }
        // B6 1E <mode>: surface-mode report — follow the user's Mode
        // button. On a custom surface the device drives its own LEDs, so
        // painting pauses; back on a DAW surface (1/2) repaint in full.
        if (status === 0xb6) {
            if (d1 === 0x1e && d2 > 0) {
                const back = d2 < 6 && x.surface >= 6
                x.surface = d2
                if (back && x.on) setTimeout(() => this._xl3Sync(true), 500)
            }
            return // remaining ch-7 traffic: feature ACKs, shift button
        }
        // the DAW surface reports as plain CCs (encoders/faders ch 16,
        // buttons ch 1): that IS the hardware while LEDs are on, so it
        // learns and drives like any controller. Only the CC family passes
        // — the ch-16 note-ons (DAW-mode ACKs) never reach a learn.
        if ((status & 0xf0) === 0xb0 && x.on) this.onMessage(data, { xl3daw: true })
    }

    // a control message arrived for this mapping while a finger is (just)
    // on a physical encoder/fader: that's the physical LED for it
    _xl3Tag(m) {
        const x = this._xl3
        const t = x && x.touch
        if (!m || !t || !x.on) return
        if (Date.now() - t.t > 1500 || m.pi === t.idx) return
        m.pi = t.idx
        this.persist() // diff-syncs the LED into its deck colour
    }

    async _xl3Setup() {
        const outs = this._xl3DawOuts()
        if (!outs.length || this._xl3State().on) return
        const send = (msg) => outs.forEach((o) => { try { o.send(msg) } catch (e) { /* closed */ } })
        const pause = (ms) => new Promise((r) => setTimeout(r, ms))
        const x = this._xl3State()
        x.on = true
        x.surface = 1 // DAW-mode entry lands on the DAW Mixer surface
        // hand the LEDs back if the deck goes away mid-session
        if (typeof window !== 'undefined' && !this._xl3Bye) {
            this._xl3Bye = true
            window.addEventListener('pagehide', () => this._xl3Exit())
        }
        send([0x9f, 0x0c, 0x7f]) // enter DAW mode (surface swaps to DAW Mixer, LEDs dark)
        send([0xb6, 0x47, 0x7f]) // touch events on
        await pause(500) // let the surface swap settle before painting
        this._xl3Sync(true)
        setTimeout(() => this._xl3Sync(true), 2500) // beat any late redraw
    }

    _xl3Exit() {
        const x = this._xl3
        if (!x || !x.on) return
        const outs = this._xl3DawOuts()
        const send = (msg) => outs.forEach((o) => { try { o.send(msg) } catch (e) { /* closed */ } })
        send([0xb6, 0x47, 0x00]) // touch events off
        send([0x9f, 0x0c, 0x00]) // exit DAW mode — the device repaints itself
        x.on = false
        x.lit = new Map()
    }

    // deck palette (vj-mc-0..7) → nearest Novation palette indices
    static get XL3_COLORS() { return [57, 33, 41, 9, 49, 37, 17, 60] }

    _xl3Sync(full) {
        const x = this._xl3
        if (!x || !x.on) return
        if (x.surface >= 6) return // custom surface up: the device owns its LEDs
        const outs = this._xl3DawOuts()
        if (!outs.length) return
        const send = (msg) => outs.forEach((o) => { try { o.send(msg) } catch (e) { /* closed */ } })
        const want = new Map()
        for (const [path, m] of Object.entries(this.mappings.params)) {
            // a mapping learned over the DAW port (m.xd): its CC number IS
            // the LED index. Anything else needs the touch-tied index.
            const pi = m.xd ? m.cc : m.pi
            if (pi === undefined || !this._resolves(path)) continue
            const info = controlInfo(m)
            want.set(pi, MidiControl.XL3_COLORS[(info ? info.color : 0)] || 3)
        }
        if (full) {
            // physical controls only (faders 5-12, encoders 13-36, button
            // rows 37-52); side/transport buttons are left alone
            for (let i = 5; i <= 52; i++) send([0xb0, i, 0])
            x.lit = new Map()
        }
        for (const [pi, col] of x.lit) {
            if (!want.has(pi)) send([0xb0, pi, 0])
            else if (want.get(pi) !== col) send([0xb0, pi, want.get(pi)])
        }
        for (const [pi, col] of want) {
            if (!x.lit.has(pi)) send([0xb0, pi, col])
        }
        x.lit = want
    }

    hasMappings() {
        return Object.keys(this.mappings.params).length > 0 ||
            Object.keys(this.mappings.scenes).length > 0 ||
            Object.keys(this.mappings.actions).length > 0 ||
            Object.values(this.mappings.slots).some((s) => s && Object.keys(s).length > 0)
    }

    // ---- per-scene knob layouts --------------------------------------
    // Param assignments belong to the SCENE they were made on: recalling a
    // scene swaps the active mapping table for the layout parked on that
    // slot (a never-mapped scene starts clean), and leaving a scene parks
    // the current layout back on its slot. Scene pads and HUSH stay
    // global. Slot-keyed like the pads: reordering scenes moves the code,
    // not the knob layouts (documented drag&drop behavior).

    sceneSwitch(from, to) {
        if (from === to) return
        if (Number.isInteger(from) && from >= 0) this.mappings.slots[from] = { ...this.mappings.params }
        this.mappings.params = { ...(this.mappings.slots[to] || {}) }
        // pending commits from the old scene must not splice into the new
        // sketch (paths can match structurally across scenes)
        for (const a of this.active.values()) clearTimeout(a.timer)
        this.active.clear()
        if (this.learning && this.learning.path != null) this.learning = null
        this.persist()
    }

    sceneSaved(i) {
        if (!Number.isInteger(i) || i < 0) return
        this.mappings.slots[i] = { ...this.mappings.params }
        this.persist()
    }

    sceneCleared(i) {
        delete this.mappings.slots[i]
        this.persist()
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
            this.access.inputs.forEach((input) => {
                // DAW ports get the XL3 driver's handler: it consumes the
                // handshake/report traffic (mode ACKs are note-ons!) and
                // forwards only the DAW surface's CC stream to learn/drive
                if (this._isDawPort(input.name)) {
                    input.onmidimessage = this._isXl3(input.name)
                        ? (e) => this._onXl3Daw(e.data)
                        : () => {}
                    return
                }
                input.onmidimessage = (e) => this.onMessage(e.data)
            })
        }
        attach()
        this.access.onstatechange = () => {
            attach()
            // full LED re-sync only when the set of INPUT devices actually
            // changed (a controller was plugged in / came back). Output
            // ports also fire statechange — merely opening one on our first
            // LED send would loop into another full sweep.
            const sig = []
            this.access.inputs.forEach((i) => sig.push(i.id))
            const s = sig.sort().join(',')
            if (s !== this._inputSig) {
                this._inputSig = s
                this.syncLeds(true)
            }
        }
        this._inputSig = (() => {
            const sig = []
            this.access.inputs.forEach((i) => sig.push(i.id))
            return sig.sort().join(',')
        })()
        this.syncLeds(true)
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

    // "keep it" on the reassign question: stay armed for the same target,
    // but ignore the declined control — its knob burst is still streaming
    // and would re-open the very question that was just answered
    rearm(l, ctl) {
        this.learning = { ...l, skip: ctl }
        this.c.renderAll()
    }

    _skipsLearn(l, ctl, ch) {
        if (!l || !l.skip) return false
        if ((l.skip.ch || 0) !== ch) return false
        if (ctl.cc !== undefined) return l.skip.cc === ctl.cc
        return l.skip.note === ctl.note
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

    // does this mapping's param exist in the sketch that's loaded right now?
    // Mappings from other scenes stay persisted but dormant — they must not
    // trigger the reassign prompt, get stolen, or light LEDs.
    _resolves(path) {
        try {
            const model = this.c.ctx().getModel()
            if (!model || !model.pathIndex) return true // no sketch yet — don't guess
            return model.pathIndex.has(path)
        } catch (e) {
            return true
        }
    }

    // who holds this hardware control right now (for the reassign prompt)?
    // Returns a short human description, or null when it's free — or held
    // by the very target being learned (silent re-learn). Mappings parked on
    // params of OTHER scenes don't count: the control is free here.
    _controlOwner(ctl, ch, l) {
        for (const [path, m] of Object.entries(this.mappings.params)) {
            if (m.ch !== ch) continue
            if ((ctl.cc !== undefined && m.cc === ctl.cc) ||
                (ctl.note !== undefined && m.note === ctl.note)) {
                if (l.path === path) return null
                if (!this._resolves(path)) continue
                return this._pathDesc(path)
            }
        }
        if (ctl.note !== undefined) {
            const key = `n${ctl.note}c${ch}`
            const slot = this.mappings.scenes[key]
            if (slot !== undefined) return l.scene === slot ? null : 'scene ' + (slot + 1)
            const action = this.mappings.actions[key]
            if (action) return l.action === action ? null : action.toUpperCase()
        }
        return null
    }

    // 's0.t1(modulateScale).a0.t0(rotate).a0.l0' -> 'rotate · arg 1 · ƒ1'
    _pathDesc(path) {
        const paren = path.lastIndexOf(')')
        if (paren === -1) {
            let m
            // 's0.up.speed.scale' -> 'speed · scale' (update-hook binding)
            if ((m = /^s\d+\.up\.(\w+)(?:\.(\w+))?$/.exec(path))) return [m[1], m[2]].filter(Boolean).join(' · ')
            const s = /^s\d+\.(\w+)$/.exec(path)
            return s ? s[1] : path
        }
        const fn = /\(([^)]*)\)$/.exec(path.slice(0, paren + 1).replace(/^.*\(/, '('))
        const name = fn ? fn[1] : ''
        const parts = path.slice(paren + 1).split('.').filter(Boolean).map((p) => {
            let m
            if ((m = /^a(\d+)$/.exec(p))) return 'arg ' + (+m[1] + 1)
            if ((m = /^l(\d+)$/.exec(p))) return 'ƒ' + (+m[1] + 1)
            if ((m = /^v(\d+)$/.exec(p))) return 'step ' + (+m[1] + 1)
            return p
        })
        return [name, ...parts].filter(Boolean).join(' · ')
    }

    // finish a learn, asking first when the control already drives something
    // else — a controller full of assignments shouldn't lose one to a slip
    _finishLearn(l, ctl, ch, finish) {
        this.learning = null
        const owner = this._controlOwner(ctl, ch, l)
        if (owner && this.c.confirmReassign) {
            const info = controlInfo(ctl.cc !== undefined ? { cc: ctl.cc, ch } : { note: ctl.note, ch }) || { label: '?', color: 0 }
            this.c.confirmReassign(info, owner, () => {
                finish()
                if (l.path != null) this._xl3Tag(this.mappings.params[l.path])
                this.persist()
                this.c.renderAll()
            }, { l, ctl: { ...ctl, ch } })
            return
        }
        finish()
        if (l.path != null) this._xl3Tag(this.mappings.params[l.path])
        this.persist()
        this.c.renderAll()
    }

    // one hardware control drives one thing IN THE CURRENT SKETCH: a fresh
    // learn steals the knob or pad from whatever resolvable mapping held it —
    // params, scene pads and actions alike. Assignments parked on other
    // scenes' params are left alone; they resolve again when that scene
    // returns, so every scene keeps its own layout on the same controller.
    _releaseControl(ctl, ch) {
        for (const [path, m] of Object.entries(this.mappings.params)) {
            if (m.ch !== ch) continue
            if ((ctl.cc !== undefined && m.cc === ctl.cc) ||
                (ctl.note !== undefined && m.note === ctl.note)) {
                if (this._resolves(path)) delete this.mappings.params[path]
            }
        }
        if (ctl.note !== undefined) {
            const key = `n${ctl.note}c${ch}`
            delete this.mappings.scenes[key]
            delete this.mappings.actions[key]
        }
    }

    // exported separately from the event plumbing so it can be driven in
    // tests. src.xl3daw marks messages from the XL3's DAW surface, whose
    // CC numbers double as LED indices (see the XL3 driver notes).
    onMessage(data, src) {
        const [status, d1, d2] = data
        const kind = status & 0xf0
        const ch = status & 0x0f
        const xd = src && src.xl3daw ? { xd: 1 } : {}
        if (kind === 0x90 && d2 > 0) { // note on: pads and buttons
            const key = `n${d1}c${ch}`
            if (this.learning && !this._skipsLearn(this.learning, { note: d1 }, ch)) {
                const l = this.learning
                this._finishLearn(l, { note: d1 }, ch, () => {
                    this._releaseControl({ note: d1 }, ch)
                    if (l.scene != null) this.mappings.scenes[key] = l.scene
                    else if (l.action) this.mappings.actions[key] = l.action
                    else if (l.path != null) {
                        // pads carry no range: they mute/unmute the param.
                        // `on` is the fallback level for a param learned at 0
                        const model = this.c.ctx().getModel()
                        const arg = model && model.pathIndex.get(l.path)
                        const v0 = arg ? arg.value : (isFinite(l.hint) ? l.hint : 0)
                        const mode = l.mode === 'auto' ? 'toggle' : l.mode
                        this.mappings.params[l.path] = { note: d1, ch, mode, on: v0 || 1 }
                    }
                })
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
                // hold buttons mute while held: release brings the value back
                if (m.note === d1 && m.ch === ch && m.mode === 'push') {
                    this.applyValue(path, m, this._onLevel(m))
                }
            }
            return
        }
        if (kind !== 0xb0) return // control change from here on
        if (this.learning && this.learning.path != null && !this._skipsLearn(this.learning, { cc: d1 }, ch)) {
            const l = this.learning
            if (l.mode === 'auto' || l.mode === 'cc') {
                this._finishLearn(l, { cc: d1 }, ch, () => {
                    this._releaseControl({ cc: d1 }, ch)
                    // no range — the knob drives the value relatively, like the fader
                    this.mappings.params[l.path] = { cc: d1, ch, ...xd }
                })
            } else if (d2 > 0) {
                // an explicit button learn (mute/unmute, mute-while-held)
                // also accepts a CC press — many keyboards' buttons send CC
                // (value 127 down / 0 up), not notes
                const model = this.c.ctx().getModel()
                const arg = model && model.pathIndex.get(l.path)
                const v0 = arg ? arg.value : (isFinite(l.hint) ? l.hint : 0)
                this._finishLearn(l, { cc: d1 }, ch, () => {
                    this._releaseControl({ cc: d1 }, ch)
                    this.mappings.params[l.path] = { cc: d1, ch, mode: l.mode, on: v0 || 1, ...xd }
                })
            }
            return
        }
        for (const [path, m] of Object.entries(this.mappings.params)) {
            if (m.cc !== d1 || m.ch !== ch) continue
            this._xl3Tag(m) // a finger on a physical control names its LED
            if (m.mode === 'toggle' || m.mode === 'push') {
                // a CC button: value > 0 is the press, 0 the release
                if (d2 > 0) this.pressButton(path, m)
                else if (m.mode === 'push') this.applyValue(path, m, this._onLevel(m))
            } else {
                this.applyCC(path, m, d2)
            }
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

    // pads mute — no range involved, and pressing always goes TOWARD 0.
    // Toggle: one hit snaps the param to 0 (remembering its level), the
    // next brings the remembered level back. Hold: 0 while the pad is
    // pressed, the previous level returns on release. A knob moving the
    // same param updates what comes back — whatever value the pad
    // silenced, it restores.
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
        if (m.mode === 'push') return this.applyValue(path, m, 0)
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
