import VJPanel from '../panel/panel.js'

export default function panelStore(state, emitter) {
    state.panel = { open: false, popup: false, pip: false }

    // realm token: after a page reload the popup's bootstrap sees a new gen
    // on window.opener and asks to be re-adopted (see src/panel/popup.js)
    window.__vjGen = 'g' + Math.random().toString(36).slice(2)

    const ensure = () => {
        if (!state.vjPanel) {
            state.vjPanel = new VJPanel(state, (...args) => emitter.emit(...args))
            window.vjPanel = state.vjPanel // console access, in hydra tradition
        }
        wireCm()
        return state.vjPanel
    }

    // rebuild the model when the user edits code by hand (panel splices are
    // tagged '+vjpanel' and already rebuild themselves)
    let debounce = null
    const wireCm = () => {
        const cm = state.editor && state.editor.editor && state.editor.editor.cm
        if (!cm || cm.__vjWired) return
        cm.__vjWired = true
        cm.on('changes', (instance, changes) => {
            if (changes.every((ch) => ch.origin === '+vjpanel')) return
            clearTimeout(debounce)
            debounce = setTimeout(() => {
                if ((state.panel.open || state.panel.popup) && state.vjPanel) state.vjPanel.rebuild()
            }, 250)
        })
    }

    emitter.on('panel: toggle', () => {
        const panel = ensure()
        if (state.panel.popup) {
            // the panel lives in the popup — bring it to front instead
            panel.focusPopup()
            return
        }
        if (state.panel.pip && panel.pipWin) {
            try { panel.pipWin.focus() } catch (e) { /* best effort */ }
            return
        }
        state.panel.open = !state.panel.open
        if (state.panel.open) panel.rebuild()
        emitter.emit('render')
    })

    emitter.on('panel: popout', () => {
        ensure().popout()
    })

    // remote intents need the panel alive even while the dock is closed
    emitter.on('panel: ensure', () => {
        ensure()
    })

    // any eval that is not our own shadow replaces the running program with
    // one that reads literals again — live bindings must re-arm lazily
    emitter.on('repl: eval', () => {
        const panel = state.vjPanel
        if (panel && !panel.lb.evaling) panel.lb.invalidate()
    })

    // re-adoption hook for an orphaned popup after this page (re)loads
    window.__vjAdopt = (win) => {
        const panel = ensure()
        panel.rebuild()
        panel.adopt(win)
    }

    // hotkey also works when the editor is not focused (the CodeMirror keymap
    // handles it when it is — skip to avoid double-firing)
    document.addEventListener('keydown', (e) => {
        if (!e.ctrlKey || !e.shiftKey || (e.key !== 'y' && e.key !== 'Y')) return
        if (e.target && e.target.closest && e.target.closest('.CodeMirror')) return
        e.preventDefault()
        emitter.emit('panel: toggle')
    })
}
