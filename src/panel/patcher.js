// Applies panel edits to the CodeMirror buffer as single surgical text splices,
// preserving the user's formatting, comments, cursor and undo history.
// Every edit: guard (model must match the buffer) -> splice -> eval -> revert on error.
import { fmtNumber, defaultArgText, defaultArgsText } from './metadata.js'

export const edits = {
    setNumber(arg, value) {
        return { from: arg.range[0], to: arg.range[1], text: fmtNumber(value) }
    },

    setRef(arg, name) {
        return { from: arg.range[0], to: arg.range[1], text: name }
    },

    insertTransform(afterStep, def) {
        return { from: afterStep.callEnd, to: afterStep.callEnd, text: `.${def.name}(${defaultArgsText(def)})` }
    },

    removeTransform(step) {
        return { from: step.span[0], to: step.span[1], text: '' }
    },

    // mute a step in place by commenting it out; the model re-reads the
    // comment as a bypassed step (caller must reject slices containing '*/')
    bypassTransform(step, text) {
        return { from: step.span[0], to: step.span[1], text: '/*' + text.slice(step.span[0], step.span[1]) + '*/' }
    },

    enableBypassed(byp, text) {
        return { from: byp.range[0], to: byp.range[1], text: text.slice(byp.range[0] + 2, byp.range[1] - 2) }
    },

    removeBypassed(byp) {
        return { from: byp.range[0], to: byp.range[1], text: '' }
    },

    duplicateTransform(step, text) {
        // a step's span can start with a bypassed-step comment — don't clone it
        const slice = text.slice(step.span[0], step.span[1]).replace(/^\s*(\/\*[^]*?\*\/\s*)+/, '')
        return { from: step.callEnd, to: step.callEnd, text: slice.startsWith('.') ? slice : '.' + slice.replace(/^\s*\./, '') }
    },

    moveTransform(stmt, fromIdx, toIdx, text) {
        const steps = stmt.transforms
        const region = [steps[0].span[0], steps[steps.length - 1].span[1]]
        const pieces = steps.map((s) => text.slice(s.span[0], s.span[1]))
        const [moved] = pieces.splice(fromIdx, 1)
        pieces.splice(toIdx, 0, moved)
        return { from: region[0], to: region[1], text: pieces.join('') }
    },

    replaceStep(step, newDef, text) {
        const args = newDef.inputs.map((input, i) => {
            const old = step.args[i]
            return old ? text.slice(old.range[0], old.range[1]) : defaultArgText(input)
        })
        return { from: step.nameRange[0], to: step.callEnd, text: `${newDef.name}(${args.join(', ')})` }
    },

    setOutTarget(out, target) {
        return { from: out.argRange[0], to: out.argRange[1], text: target }
    },

    appendOut(lastStep, target) {
        return { from: lastStep.callEnd, to: lastStep.callEnd, text: `.out(${target})` }
    },

    // editing a parameter the code omits: fill defaults up to it, then the value
    ghostArg(step, argIdx, valueText) {
        const meta = step.meta
        const parts = []
        for (let i = step.args.length; i <= argIdx; i++) {
            parts.push(i === argIdx ? valueText : defaultArgText(meta.inputs[i]))
        }
        const text = (step.args.length > 0 ? ', ' : '') + parts.join(', ')
        return { from: step.argsInnerEnd, to: step.argsInnerEnd, text }
    },

    appendChain(text, target) {
        const sep = text.length === 0 ? '' : (text.endsWith('\n') ? '\n' : '\n\n')
        return { from: text.length, to: text.length, text: `${sep}osc(60, 0.1, 0)\n  .out(${target})\n` }
    },

    removeStatement(stmt, text) {
        let to = stmt.range[1]
        while (to < text.length && (text[to] === ';' || text[to] === ' ' || text[to] === '\t')) to++
        if (text[to] === '\n') to++
        return { from: stmt.range[0], to, text: '' }
    }
}

// Returns true when the edit was applied and evaluated cleanly.
export function applyEdit(ctx, edit, opts = {}) {
    const { cm, emit } = ctx
    const model = ctx.getModel()
    if (!model || !model.ok || cm.getValue() !== model.text) {
        ctx.rebuild()
        return false
    }
    const removed = model.text.slice(edit.from, edit.to)
    cm.replaceRange(edit.text, cm.posFromIndex(edit.from), cm.posFromIndex(edit.to), '+vjpanel')
    const code = cm.getValue()
    let failed = false
    emit('repl: eval', code, (s, err) => { failed = !!err })
    if (failed) {
        // precise inverse splice (cm.undo could swallow a prior merged '+vjpanel' event)
        cm.replaceRange(removed, cm.posFromIndex(edit.from), cm.posFromIndex(edit.from + edit.text.length), '+vjpanel')
        ctx.rebuild()
        return false
    }
    // structural edits get their own undo step (CM merges rapid same-origin
    // changes into one history event otherwise); fader commits may merge
    if (!opts.replaceURL) cm.changeGeneration(true)
    emit('gallery: save to URL', code, { replace: !!opts.replaceURL })
    armRuntimeRevert(ctx, edit, removed, code)
    ctx.rebuild()
    return true
}

// Commit a splice WITHOUT re-evaluating: valid only while the change is
// already live on screen through a LiveBind uniform (fader/MIDI commits) or
// a live global (speed/bpm). Skipping the eval keeps side-effectful setups
// (s0.initCam() and friends) from re-running on every committed gesture.
export function applyQuietEdit(ctx, edit) {
    const { cm, emit } = ctx
    const model = ctx.getModel()
    if (!model || !model.ok || cm.getValue() !== model.text) {
        ctx.rebuild()
        return false
    }
    cm.replaceRange(edit.text, cm.posFromIndex(edit.from), cm.posFromIndex(edit.to), '+vjpanel')
    emit('gallery: save to URL', cm.getValue(), { replace: true })
    ctx.rebuild()
    return true
}

// The synchronous eval only surfaces syntax errors — runtime errors arrive a
// beat later via window._reportError (see src/stores/repl-v2.js). For a short
// window after each panel edit, treat such an error as caused by the edit and
// roll it back, so a broken insert never strands the performer.
const REVERT_WINDOW_MS = 500
let runtimeGuard = null

function armRuntimeRevert(ctx, edit, removed, code) {
    const { cm, emit } = ctx
    if (typeof window === 'undefined' || !window._reportError) return
    if (!window.__vjOrigReport) {
        window.__vjOrigReport = window._reportError
        window._reportError = (err) => {
            const g = runtimeGuard
            runtimeGuard = null
            if (g) {
                clearTimeout(g.timer)
                g.revert()
            }
            window.__vjOrigReport(err)
        }
    }
    const guard = {
        timer: setTimeout(() => { if (runtimeGuard === guard) runtimeGuard = null }, REVERT_WINDOW_MS),
        revert: () => {
            if (cm.getValue() !== code) return // something else edited since
            cm.replaceRange(removed, cm.posFromIndex(edit.from), cm.posFromIndex(edit.from + edit.text.length), '+vjpanel')
            const back = cm.getValue()
            emit('repl: eval', back, () => {})
            emit('gallery: save to URL', back, { replace: true })
            ctx.rebuild()
        }
    }
    runtimeGuard = guard
}
