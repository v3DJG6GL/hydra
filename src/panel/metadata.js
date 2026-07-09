// Function metadata for the VJ panel.
// Primary source is the running synth (window.hydraSynth.generator.glslTransforms):
// it reflects the hydra-synth build actually loaded from CDN plus any functions the
// user adds at runtime via setFunction(). The vendored randomizer snapshot is only
// the fallback for the moment before hydra has booted.
import vendored from '../views/editor/randomizer/glslTransforms.js'

export const CATEGORIES = [
    { type: 'src', label: 'source' },
    { type: 'coord', label: 'geometry' },
    { type: 'color', label: 'color' },
    { type: 'combine', label: 'blend' },
    { type: 'combineCoord', label: 'modulate' }
]

const CHAIN_TYPES = new Set(CATEGORIES.map((c) => c.type))

// params that are semantically integers although typed float in glsl
export const INT_PARAMS = new Set(['sides', 'nSides', 'bins', 'pixelX', 'pixelY'])

// The first input of combine/combineCoord functions is the texture/chain slot.
// At runtime hydra prepends it synthetically and its NAME varies between builds
// ('color', '_c0', '_c1'...), so it is detected by position + type, never by name.
function normalize(def) {
    let inputs = def.inputs.map((i) => ({ name: i.name, type: i.type, default: i.default }))
    if (def.type === 'combine' || def.type === 'combineCoord') {
        const first = inputs[0]
        if (first && (first.type === 'vec4' || first.type === 'sampler2D')) {
            inputs[0] = { name: 'source', type: first.type, slot: true }
        } else {
            inputs.unshift({ name: 'source', type: 'vec4', slot: true })
        }
    }
    inputs.forEach((i) => { if (i.type === 'sampler2D') i.slot = true })
    return { name: def.name, type: def.type, inputs }
}

// name -> normalized definition. Rebuilt on demand so runtime extensions appear.
export function getTransforms() {
    const map = {}
    vendored.forEach((def) => { map[def.name] = normalize(def) })
    const live = window.hydraSynth && window.hydraSynth.generator && window.hydraSynth.generator.glslTransforms
    if (live) {
        Object.values(live).forEach((def) => {
            if (def && def.name && CHAIN_TYPES.has(def.type) && Array.isArray(def.inputs)) {
                map[def.name] = normalize(def)
            }
        })
    }
    return map
}

export function grouped(transforms) {
    return CATEGORIES.map((cat) => ({
        type: cat.type,
        label: cat.label,
        fns: Object.values(transforms).filter((def) => def.type === cat.type)
    }))
}

export function fmtNumber(v) {
    if (typeof v !== 'number' || !isFinite(v)) return '0'
    return String(parseFloat(v.toFixed(3)))
}

// compact form for value readouts: the code keeps full precision, the
// display sheds decimals as the magnitude grows so long numbers don't
// blow up tight rows
export function fmtShort(v) {
    if (typeof v !== 'number' || !isFinite(v)) return '0'
    const a = Math.abs(v)
    if (a >= 1000) return String(Math.round(v))
    if (a >= 100) return String(parseFloat(v.toFixed(1)))
    return fmtNumber(v)
}

export function defaultArgText(input) {
    if (input.slot) return input.type === 'sampler2D' ? 'o0' : 'osc(60, 0.1, 0)'
    return fmtNumber(typeof input.default === 'number' && isFinite(input.default) ? input.default : 0)
}

export function defaultArgsText(def) {
    return def.inputs.map(defaultArgText).join(', ')
}
