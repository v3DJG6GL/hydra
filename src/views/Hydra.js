import html from 'choo/html'
import Component from 'choo/component'
// import Hydra from 'hydra-synth'
// const HydraSynth = require('./../../../../../hydra-synth')
import P5 from './../lib/p5-wrapper.js'
import PatchBay from './../lib/patch-bay/pb-live.js'
import { isDisplay } from './../lib/display-mode.js'

let pb

// const SERVER_URL = process.env['SERVER_URL']

export default class HydraCanvas extends Component {
  constructor(id, state, emit) {
    super(id)
    this.local = state.components[id] = {}
    state.hydra = this // hacky
    this.state = state
    this.emit = emit
  }

  load(element) {
    let isIOS =
      (/iPad|iPhone|iPod/.test(navigator.platform) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) &&
      !window.MSStream;
    let precisionValue = isIOS ? 'highp' : 'mediump'


    // display mode (TV/projector kiosk): no local mic — a.fft comes from the
    // fft-bus (deck stream or the app shell's native capture) instead
    const hydraOptions = { detectAudio: !isDisplay(), canvas: element.querySelector("canvas"), precision: precisionValue }

    // a hydra boot failure (no WebGL context: GPU driver hiccup, context
    // exhaustion) must not propagate — the load hooks of sibling components
    // (editor!) run in the same observer callback and would never fire
    try {
      if (this.state.serverURL === null) {
        console.log('LOCAL ONLY, WILL NOT INIT webRTC and gallery')
        this.hydra = new Hydra(hydraOptions)
      } else {
        this.pb = new PatchBay()
        hydraOptions.pb = this.pb
        this.hydra = new Hydra(hydraOptions)
        this.pb.init(this.hydra.captureStream, {
          // server: window.location.origin,
          server: this.state.serverURL,
          room: 'iclc'
        })
        window.pb = this.pb
      }
    } catch (e) {
      console.error('hydra failed to boot', e)
      setTimeout(() => { if (window._reportError) window._reportError(e) }, 0)
      return
    }

    window.hydraSynth = this.hydra
    //  if(environment !== 'local') {
    // osc().out()

    // }

    window.P5 = P5
    // window.pb = pb
    this.emit('hydra loaded')
  }

  update(center) {
    return false
  }

  createElement({ width = window.innerWidth, height = window.innerHeight } = {}) {

    return html`<div style="width:100%;height:100%;">
        <canvas id="hydra-canvas" class="bg-black" style="image-rendering:pixelated; width:100%;height:100%" width="${width}" height="${height}"></canvas></div>`
  }
}
