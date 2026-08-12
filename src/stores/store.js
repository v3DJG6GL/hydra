import repl from './repl-v2.js'
import { isDisplay } from '../lib/display-mode.js'
// console.log('ENVIRONMENT IS', process.env.NODE_ENV)

function initialShowCode() {
  try {
    const p = new URLSearchParams(window.location.search)
    const param = p.get('showCode') || p.get('show-code')
    if (param !== null) return param !== 'false'
    // remembered toggle (deck CODE button / ui: toggle code) wins…
    const stored = localStorage.getItem('hydra-show-code')
    if (stored !== null) return stored === '1'
    // …otherwise a normal browser boots editor-first; only display kiosks
    // (?display=1 — the TV app / projector) default to bare visuals
    return true
  } catch (e) {
    return true
  }
}

export default function store(state, emitter) {
  state.showInfo = false
  state.showUI = true
  // code overlay: ON by default in a normal browser (editor + header usable
  // out of the box); the CODE toggle persists per-browser and a showCode URL
  // param overrides both. TV/projector kiosks (?display=1) always boot bare.
  state.showCode = !isDisplay() && initialShowCode()
  state.showExtensions = false
  state.errorMessage = ''
  state.isError = false

  // if backend gallery endpoint supplied, then enable gallery functionality
  const SERVER_URL = import.meta.env.VITE_SERVER_URL
  state.serverURL = SERVER_URL !== undefined ? SERVER_URL : null

  window._reportError = (err) => {
    state.errorMessage = err.message
    state.isError = true
    emitter.emit('render')
  }

  emitter.on('load and eval code', (code, shouldUpdateURL = true) => {
    emitter.emit('editor: load code', code)
    emitter.emit('repl: eval', code)
    if(shouldUpdateURL) emitter.emit('gallery: save to URL', code)
  })

  emitter.on('repl: eval', (code = '', callback) => {
    repl.eval(code, (info) => {
      state.errorMessage = info.errorMessage
      state.isError = info.isError
      if(callback) callback(info.codeString, info.isError)
      emitter.emit('render')
    })

  })

  emitter.on('screencap', () => {
    screencap()
    const editor = state.editor.editor
    const text = editor.getValue()
    const data = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a')
    a.style.display = 'none'
    let d = new Date()
    a.download = `hydra-${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}-${d.getHours()}.${d.getMinutes()}.${d.getSeconds()}.js`
    a.href = URL.createObjectURL(data)
    a.click()

    setTimeout(() => {
      window.URL.revokeObjectURL(a.href);
    }, 300);
  })

  function clearAll() {
    const editor = state.editor.editor
    hush()
    speed = 1
    emitter.emit('gallery: clear')
    editor.clear()
  }

  emitter.on('clear all', () => {
    clearAll()
  })


  emitter.on('ui: hide all', function () {
    state.showUI = !state.showUI
    emitter.emit('render')
  })

  // hides the editor overlay (code, console, header) but keeps the vj deck
  emitter.on('ui: toggle code', function () {
    state.showCode = !state.showCode
    // the boot-time gallery load leaves showInfo latched true (invisible while
    // code is off) — showing code must not drag the intro window along; the
    // ? toolbar button reopens it deliberately
    if (state.showCode) {
      state.showInfo = false
      state.showExtensions = false
    }
    try { localStorage.setItem('hydra-show-code', state.showCode ? '1' : '0') } catch (e) { /* private mode */ }
    emitter.emit('render')
  })

  emitter.on('ui: toggle info', function (count) {
    if (state.showInfo) {
      // state.showInfo = false
      // state.showExtensions = false
      emitter.emit('ui: hide info')
    } else {
      emitter.emit('ui: show info')
    }
    // state.showInfo = !state.showInfo
    //emitter.emit('render')
  })

  emitter.on('ui: show info', () => {
    state.showInfo = true
    emitter.emit('render')
  })

  emitter.on('ui: hide info', () => {
    state.showInfo = false
    state.showExtensions = false
    emitter.emit('render')
  })

  // emitter.on('hide info', function (count) {
  //   state.showInfo = false
  //   state.showExtensions = false
  //   emitter.emit('render')
  // })

  emitter.on('ui: show extensions', () => {
    state.showExtensions = true
    state.showInfo = true
    emitter.emit('extensions: select category')
    emitter.emit('render')
  })

  emitter.on('ui: hide extensions', () => {
    state.showExtensions = false
    emitter.emit('render')
  })



  // emitter.on('mutate sketch', function () {

  // })
}

