import html from 'choo/html'
import Component from 'choo/component'

// Thin choo wrapper around the in-page dock host. The panel controller
// (state.vjPanel, created by panel-store) owns all rendering; this component
// only provides the mount element and mirrors visibility from app state.
export default class VJDock extends Component {
    constructor(id, state, emit) {
        super(id)
        this.state = state
        this.emit = emit
        state.components[id] = {}
    }

    load(element) {
        this.root = element
        this.sync()
    }

    sync() {
        if (!this.root) return
        const s = this.state
        const visible = !!(s.panel && s.panel.open && !s.panel.popup && !s.panel.pip && s.showUI)
        this.root.classList.toggle('vj-hidden', !visible)
        if (visible && s.vjPanel) {
            s.vjPanel.attachDock(this.root)
            if (!this.root.hasChildNodes()) s.vjPanel.renderAll()
        }
    }

    update() {
        this.sync()
        return false
    }

    createElement() {
        return html`<div id="vj-dock" class="vj-panel vj-dock vj-hidden"></div>`
    }
}
