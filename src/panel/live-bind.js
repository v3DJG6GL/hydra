// Zero-recompile scrubbing. Hydra inlines plain numbers into the fragment shader
// (every change would recompile it and leak regl programs), but a function-valued
// argument becomes a regl uniform re-read every frame. So while params are being
// driven (fader drag, MIDI) we evaluate ONE shadow copy of the sketch with every
// driven literal replaced by `() => window.__vj.<key>`; moving a control only
// assigns that global. The buffer is untouched until each control commits.
//
// Bindings are keyed by the arg's stable PATH (assigned in sketch-model) and are
// PERSISTENT: once a param has been driven, its binding stays in the shadow, so
// the next gesture on it needs no eval at all — and its commits can be "quiet"
// (text splice only, see applyQuietEdit). That matters for sketches with
// side-effectful setup (s0.initCam() would otherwise re-prompt per gesture).
// `clean` tracks whether the RUNNING program is the shadow that reads every
// binding; any real eval elsewhere invalidates it and bindings re-arm lazily.
let counter = 0

export default class LiveBind {
    constructor() {
        window.__vj = window.__vj || {}
        this.bindings = new Map() // path -> key
        this.clean = false        // running program reads every binding
        this.evaling = false      // true during our own shadow evals
    }

    hasBindings() {
        return this.bindings.size > 0
    }

    // true when an eval-free commit is safe for this path: what's on screen
    // already reads this arg through its uniform
    isLive(path) {
        return this.clean && this.bindings.has(path)
    }

    // Ensure `path` is driven per-frame. Returns the key, or null (caller
    // falls back to commit-on-release). Reuses the running shadow when it
    // already contains the binding — no eval, no re-run of setup side effects.
    ensure(ctx, path, initialValue) {
        let key = this.bindings.get(path)
        if (key !== undefined && this.clean) return key
        const created = key === undefined
        if (created) {
            key = 'p' + (counter++)
            this.bindings.set(path, key)
            window.__vj[key] = initialValue
        }
        if (!this.evalShadow(ctx)) {
            if (created) {
                this.bindings.delete(path)
                delete window.__vj[key]
            }
            return null
        }
        // resolution may have dropped it (arg vanished from the model)
        return this.bindings.get(path) === key ? key : null
    }

    set(key, value) {
        window.__vj[key] = value
    }

    // a real eval replaced the running program — bindings are no longer wired
    // to what's on screen; they re-arm on the next gesture/message
    invalidate() {
        this.clean = false
    }

    // forget a binding; its last value stays in window.__vj because a shadow
    // program may still read it until the next real eval
    drop(path) {
        this.bindings.delete(path)
    }

    // Evaluate one shadow program with every binding substituted for its uniform.
    evalShadow(ctx) {
        const model = ctx.getModel()
        if (!model || !model.ok || ctx.cm.getValue() !== model.text) return false
        const items = []
        for (const [path, key] of this.bindings) {
            const arg = model.pathIndex && model.pathIndex.get(path)
            if (!arg || arg.noLive || arg.kind !== 'number') {
                // the code changed under this binding — drop it
                this.bindings.delete(path)
                continue
            }
            items.push({ key, arg })
        }
        if (!items.length) {
            this.clean = false
            return true
        }
        items.sort((a, b) => b.arg.range[0] - a.arg.range[0])
        let text = model.text
        for (const it of items) {
            text = text.slice(0, it.arg.range[0]) +
                `(() => window.__vj.${it.key})` +
                text.slice(it.arg.range[1])
        }
        let failed = false
        this.evaling = true
        try {
            ctx.emit('repl: eval', text, (code, err) => { failed = !!err })
        } finally {
            this.evaling = false
        }
        this.clean = !failed
        return !failed
    }
}
