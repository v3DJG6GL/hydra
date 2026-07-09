// to add:
// flash block, flash line, format code

export default function editorStore(state, emitter) {
    // evt may be a mouse event (toolbar click) or absent (keyboard shortcut)
    emitter.on('editor: randomize', function (evt = {}) {
        const editor = state.editor.editor
        if (evt.shiftKey) {
            editor.mutator.doUndo();
        } else {
            try {
                editor.mutator.mutate({ reroll: false, changeTransform: evt.metaKey });
            } catch (e) {
                // Mutator parses before its own try/catch — a buffer that
                // doesn't parse must not blow up the handler
                console.warn('randomize skipped: ' + (e.message || e))
                return
            }
            editor.formatCode()
            emitter.emit('gallery: save to URL', editor.getValue())
        }
        // Mutator evals through the editor's own repl, not the emitter's
        // 'repl: eval', so the live-bind invalidation hook in panel-store
        // never hears about it — previously-driven faders would keep writing
        // uniforms nothing reads. Bindings re-arm on the next gesture.
        if (state.vjPanel) state.vjPanel.lb.invalidate()
    })

    emitter.on('editor: add code to top', (code) => {
        state.editor.editor.addCodeToTop(code)
    })

    // emitter.on('editor: eval all', () => {
    //     const code = editor.getValue()
    //     state.editor.editor.flashCode()
    // })

    emitter.on('editor: format code', () => {
        state.editor.editor.formatCode()
    })

    emitter.on('editor: load code', (code) => {
        const editor = state.editor.editor
        editor.setValue(code)
    })

    emitter.on('editor: eval all', function () {
        const editor = state.editor.editor
        const code = editor.getValue()
        // repl.eval(code, (string, err) => {
        //     editor.flashCode()
        //     if (!err) sketches.saveLocally(code)
        // })
        emitter.emit('repl: eval', code, (string, err) => {
            editor.flashCode()
            if (!err) emitter.emit('gallery: save to URL', code)
            // sketches.saveLocally(code)
        })
    })

}