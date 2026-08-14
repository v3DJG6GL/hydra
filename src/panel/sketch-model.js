// Parses the editor buffer into a structured model of the sketch, keeping the
// source offsets of every editable piece so the panel can patch the original
// text surgically (never regenerating it — the buffer stays the source of truth).
import { Parser } from 'acorn'

export function buildModel(text, transforms) {
    let ast
    // block comments matching '.name(args)' are bypassed (muted) chain steps
    const comments = []
    try {
        ast = Parser.parse(text, {
            ecmaVersion: 'latest',
            allowAwaitOutsideFunction: true,
            onComment: (block, ctext, start, end) => {
                if (block) comments.push({ text: ctext, start, end, claimed: false })
            }
        })
    } catch (err) {
        return { ok: false, text, error: (err && err.message) || String(err) }
    }
    const statements = ast.body.map((node, i) => classifyStatement(node, text, transforms, i, comments))
    const pathIndex = assignPaths(statements)
    return { ok: true, text, statements, pathIndex }
}

// Stable addresses for every editable arg, so live bindings (faders, MIDI)
// can be re-resolved against a freshly parsed model. Includes the function
// name so a mapping dies when the function at that position changes.
function assignPaths(statements) {
    const index = new Map()
    const walkStep = (step, prefix) => {
        step.path = prefix
        step.args.forEach((arg, ai) => {
            arg.path = `${prefix}.a${ai}`
            index.set(arg.path, arg)
            if (arg.kind === 'chain') {
                walkStep(arg.source, `${arg.path}.src(${arg.source.name})`)
                arg.transforms.forEach((st, ti) => walkStep(st, `${arg.path}.t${ti}(${st.name})`))
            }
            if (arg.kind === 'arraySeq') {
                arg.values.forEach((v, vi) => {
                    v.path = `${arg.path}.v${vi}`
                    index.set(v.path, v)
                })
            }
            // the scale/offset literals of a () => a.fft[0] * s + o widget
            // are addressable (and MIDI-drivable: the arrow re-reads its
            // uniform every frame, see LiveBind)
            if (arg.kind === 'audioBind' || arg.kind === 'mouseBind') {
                for (const k of ['scale', 'offset']) {
                    if (arg[k]) {
                        arg[k].path = `${arg.path}.${k}`
                        index.set(arg[k].path, arg[k])
                    }
                }
            }
            // numbers inside a free-form expression: each becomes a small
            // addressable arg of its own (matching the panel's mini-faders).
            // Non-function expressions carry fnWrap — the shadow eval must
            // wrap them in an arrow to make the substituted uniform live.
            // Arrays are excluded: wrapping would defeat hydra's sequencing.
            if (arg.kind === 'expr' && !(arg.tags || []).includes('array')) {
                const fn = (arg.tags || []).includes('fn')
                arg.lits = exprLiterals(arg.text).map((l, li) => {
                    const lit = {
                        kind: 'number',
                        value: l.value,
                        range: [arg.range[0] + l.start, arg.range[0] + l.start + l.len],
                        inExpr: true,
                        fnWrap: fn ? null : arg.range,
                        path: `${arg.path}.l${li}`
                    }
                    index.set(lit.path, lit)
                    return lit
                })
            }
        })
    }
    statements.forEach((stmt, si) => {
        if (stmt.kind === 'chain') {
            walkStep(stmt.source, `s${si}.src(${stmt.source.name})`)
            stmt.transforms.forEach((st, ti) => walkStep(st, `s${si}.t${ti}(${st.name})`))
        } else if (stmt.kind === 'setup' && stmt.sub === 'update') {
            // name-keyed (not index-keyed) so a mapping on speed's scale
            // survives another global joining or leaving the block
            stmt.binds.forEach((b) => {
                b.arg.path = `s${si}.up.${b.name}`
                index.set(b.arg.path, b.arg)
                for (const k of ['scale', 'offset']) {
                    if (b.arg[k]) {
                        b.arg[k].path = `${b.arg.path}.${k}`
                        index.set(b.arg[k].path, b.arg[k])
                    }
                }
            })
        } else if (stmt.kind === 'setup' && stmt.arg) {
            stmt.arg.path = `s${si}.${stmt.sub}`
            index.set(stmt.arg.path, stmt.arg)
        }
    })
    return index
}

function classifyStatement(node, text, transforms, index, comments) {
    const base = { index, range: [node.start, node.end] }
    if (node.type === 'ExpressionStatement') {
        const expr = node.expression
        if (expr.type === 'CallExpression') {
            const links = flattenChain(expr)
            const first = links[0]
            // render(oN)
            if (links.length === 1 && first.kind === 'root' && first.name === 'render') {
                const arg = expr.arguments[0]
                return {
                    ...base,
                    kind: 'render',
                    target: arg && arg.type === 'Identifier' ? arg.name : null,
                    argRange: arg ? [arg.start, arg.end] : [expr.end - 1, expr.end - 1]
                }
            }
            // s0.initCam() and friends
            if (first.kind === 'ident' && /^s[0-3]$/.test(first.name)) {
                const setup = { ...base, kind: 'setup', sub: 'sourceInit', text: text.slice(node.start, node.end) }
                // single init call with at most a literal arg -> editable source row
                if (links.length === 2 && links[1].kind === 'method' && /^init[A-Z]/.test(links[1].name)) {
                    const a0 = links[1].node.arguments[0]
                    setup.slot = first.name
                    setup.fn = links[1].name
                    setup.url = a0 && a0.type === 'Literal' && typeof a0.value === 'string' ? a0.value : null
                    setup.camIndex = a0 && a0.type === 'Literal' && typeof a0.value === 'number' ? a0.value : 0
                }
                return setup
            }
            // a.setSmooth(0.4) and friends — audio fft response settings
            if (first.kind === 'ident' && first.name === 'a' && links.length === 2 &&
                links[1].kind === 'method' && /^set(Smooth|Scale|Bins|Cutoff)$/.test(links[1].name) &&
                links[1].node.arguments.length === 1) {
                const arg = classifyArg(links[1].node.arguments[0], text, transforms, comments)
                if (arg.kind === 'number') {
                    return { ...base, kind: 'setup', sub: 'audioSet', fn: links[1].name, arg }
                }
            }
            const chain = buildChain(links, text, transforms, false, comments)
            if (chain) return { ...base, kind: 'chain', ...chain }
        }
        if (expr.type === 'AssignmentExpression' && expr.operator === '=' && expr.left.type === 'Identifier') {
            // speed = 0.8 / bpm = 120 / fps = 30
            if (BIND_GLOBALS.includes(expr.left.name)) {
                const arg = classifyArg(expr.right, text, transforms)
                if (arg.kind === 'number') {
                    return { ...base, kind: 'setup', sub: expr.left.name, arg }
                }
            }
            // update = () => { speed = a.fft[0] * 2 … } — hydra runs the update
            // hook once per frame, which is the only way a GLOBAL can follow
            // audio or mouse (the synth copies speed/bpm/fps over as plain
            // numbers every tick, so an arrow in their place breaks the clock)
            if (expr.left.name === 'update' && expr.right.type === 'ArrowFunctionExpression' &&
                expr.right.body.type === 'BlockStatement') {
                const binds = classifyUpdateBinds(expr.right.body)
                if (binds) {
                    return { ...base, kind: 'setup', sub: 'update', binds, bodyInnerEnd: expr.right.body.end - 1 }
                }
            }
        }
    }
    return { ...base, kind: 'raw', text: text.slice(node.start, node.end) }
}

// Unrolls a method-call chain into links, outermost call last.
function flattenChain(call) {
    const links = []
    let n = call
    while (n) {
        if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' &&
            !n.callee.computed && n.callee.property.type === 'Identifier') {
            links.unshift({
                kind: 'method',
                name: n.callee.property.name,
                node: n,
                prevEnd: n.callee.object.end,
                nameRange: [n.callee.property.start, n.callee.property.end]
            })
            n = n.callee.object
        } else if (n.type === 'CallExpression' && n.callee.type === 'Identifier') {
            links.unshift({
                kind: 'root',
                name: n.callee.name,
                node: n,
                nameRange: [n.callee.start, n.callee.end]
            })
            n = null
        } else if (n.type === 'Identifier') {
            links.unshift({ kind: 'ident', name: n.name, node: n })
            n = null
        } else {
            links.unshift({ kind: 'other', node: n })
            n = null
        }
    }
    return links
}

function makeStep(link, text, transforms, comments) {
    return {
        name: link.name,
        meta: transforms[link.name] || null,
        // span covers '.name(args)' incl. any whitespace before the dot (for method steps)
        span: [link.kind === 'method' ? link.prevEnd : link.node.start, link.node.end],
        nameRange: link.nameRange,
        callEnd: link.node.end,          // insertion boundary after this step
        argsInnerEnd: link.node.end - 1, // just before the closing paren
        args: link.node.arguments.map((a) => classifyArg(a, text, transforms, comments))
    }
}

// a bypassed step is a block comment shaped like '.name(args)' sitting in a
// gap between chain links (see the bypass edit in patcher.js)
const BYPASSED_RE = /^\s*\.([A-Za-z_$][\w$]*)\(([^]*)\)\s*$/

// links -> { source, transforms, out, disabled } | null. Used for top-level
// chains (out expected/optional) and for nested chains as arguments (no out).
function buildChain(links, text, transforms, nested = false, comments = null) {
    const first = links[0]
    if (!first || first.kind !== 'root') return null
    const rootMeta = transforms[first.name]
    if (rootMeta) {
        if (rootMeta.type !== 'src') return null
    } else {
        // a user-defined generator (pat()…) may head a chain: accept it as an
        // opaque source when every following call is a known transform — its
        // .diff(…).mult(…) tail then decomposes into editable steps instead
        // of collapsing into one frozen expression
        if (links.length < 2) return null
        if (!links.slice(1).every((l) => l.kind === 'method' && (transforms[l.name] || l.name === 'out'))) return null
    }

    const source = makeStep(first, text, transforms, comments)
    const steps = []
    const disabled = []
    let out = null
    const claimGap = (fromPos, toPos, gapIdx) => {
        if (!comments) return
        for (const c of comments) {
            if (c.claimed || c.start < fromPos || c.end > toPos) continue
            const m = BYPASSED_RE.exec(c.text)
            if (!m) continue
            c.claimed = true
            disabled.push({ name: m[1], argsText: m[2], range: [c.start, c.end], gapIdx })
        }
    }
    for (let i = 1; i < links.length; i++) {
        const link = links[i]
        if (link.kind !== 'method') return null
        claimGap(links[i - 1].node.end, link.nameRange[0], steps.length)
        if (link.name === 'out') {
            if (nested || i !== links.length - 1) return null
            const arg = link.node.arguments[0]
            out = {
                target: arg && arg.type === 'Identifier' ? arg.name : 'o0',
                explicit: !!arg,
                argRange: arg ? [arg.start, arg.end] : [link.node.end - 1, link.node.end - 1],
                span: [link.prevEnd, link.node.end]
            }
        } else {
            steps.push(makeStep(link, text, transforms, comments))
        }
    }
    if (nested && out) return null
    // a comment directly after a nested chain's last call is its trailing
    // bypassed step (top level would misclaim comments between statements)
    if (nested && comments) {
        let pos = links[links.length - 1].node.end
        for (;;) {
            while (pos < text.length && /\s/.test(text[pos])) pos++
            const c = comments.find((x) => !x.claimed && x.start === pos && BYPASSED_RE.test(x.text))
            if (!c) break
            const m = BYPASSED_RE.exec(c.text)
            c.claimed = true
            disabled.push({ name: m[1], argsText: m[2], range: [c.start, c.end], gapIdx: steps.length })
            pos = c.end
        }
    }
    return { source, transforms: steps, out, disabled }
}

function classifyArg(a, text, transforms, comments) {
    if (a.type === 'Literal' && typeof a.value === 'number') {
        return { kind: 'number', value: a.value, range: [a.start, a.end] }
    }
    // the minus sign of a negative number lives in a wrapping UnaryExpression;
    // the numeric leaf is the full unary range
    if (a.type === 'UnaryExpression' && (a.operator === '-' || a.operator === '+') &&
        a.argument.type === 'Literal' && typeof a.argument.value === 'number') {
        return {
            kind: 'number',
            value: a.operator === '-' ? -a.argument.value : a.argument.value,
            range: [a.start, a.end]
        }
    }
    if (a.type === 'Identifier') {
        if (/^o[0-3]$/.test(a.name)) return { kind: 'outRef', name: a.name, range: [a.start, a.end] }
        if (/^s[0-3]$/.test(a.name)) return { kind: 'srcRef', name: a.name, range: [a.start, a.end] }
    }
    if (a.type === 'CallExpression') {
        const chain = buildChain(flattenChain(a), text, transforms, true, comments)
        if (chain) {
            return {
                kind: 'chain',
                range: [a.start, a.end],
                source: chain.source,
                transforms: chain.transforms,
                disabled: chain.disabled
            }
        }
    }
    const seq = classifyArraySeq(a)
    if (seq) return seq
    const audio = classifyAudioBind(a)
    if (audio) return audio
    const mouse = classifyMouseBind(a)
    if (mouse) return mouse
    const slice = text.slice(a.start, a.end)
    return { kind: 'expr', text: slice, range: [a.start, a.end], tags: detectTags(slice, a) }
}

// numeric literals inside an expression's text, with the char offsets to
// splice them back. Identifier tails (x2), property names and array indices
// (a.fft[0]) are skipped; a unary minus is folded into the literal so a
// drag can cross zero. Shared with the panel's expression mini-faders so
// the lit paths assigned above line up 1:1 with the rendered rows.
export function exprLiterals(text) {
    const out = []
    const re = /\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi
    let m
    while ((m = re.exec(text))) {
        const before = text.slice(0, m.index)
        const after = text.slice(m.index + m[0].length)
        if (/[\w$.]$/.test(before)) continue
        if (/^\s*\]/.test(after)) continue
        let start = m.index
        const sign = /-\s*$/.exec(before)
        if (sign) {
            const prev = before.slice(0, sign.index).trimEnd().slice(-1)
            if (!prev || '(,*+-/%=<>&|?:'.includes(prev)) start = sign.index
        }
        const str = text.slice(start, m.index + m[0].length).replace(/\s+/g, '')
        const value = parseFloat(str)
        if (isFinite(value)) out.push({ start, len: m.index + m[0].length - start, value })
    }
    return out
}

function numLeaf(node) {
    if (node.type === 'Literal' && typeof node.value === 'number') {
        return { value: node.value, range: [node.start, node.end] }
    }
    if (node.type === 'UnaryExpression' && (node.operator === '-' || node.operator === '+') &&
        node.argument.type === 'Literal' && typeof node.argument.value === 'number') {
        return { value: node.operator === '-' ? -node.argument.value : node.argument.value, range: [node.start, node.end] }
    }
    return null
}

const ARRAY_MODS = new Set(['fast', 'smooth', 'ease', 'offset', 'fit'])

// [1, 2, 3] with optional .fast(x)/.smooth(y)/... modifiers -> step sequencer
function classifyArraySeq(a) {
    const mods = {}
    let n = a
    while (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' &&
        !n.callee.computed && n.callee.property.type === 'Identifier' &&
        ARRAY_MODS.has(n.callee.property.name)) {
        const name = n.callee.property.name
        if (n.arguments.length > 1) return null
        const entry = { span: [n.callee.object.end, n.end], arg: null, str: null, argsInnerEnd: n.end - 1 }
        if (n.arguments.length === 1) {
            const a0 = n.arguments[0]
            const leaf = numLeaf(a0)
            if (leaf) {
                entry.arg = { kind: 'number', value: leaf.value, range: leaf.range, noLive: true }
            } else if (name === 'ease' && a0.type === 'Literal' && typeof a0.value === 'string') {
                entry.str = { value: a0.value, range: [a0.start, a0.end] }
            } else {
                return null
            }
        }
        mods[name] = entry
        n = n.callee.object
    }
    if (n.type !== 'ArrayExpression' || n.elements.length === 0) return null
    const values = []
    for (const elNode of n.elements) {
        if (!elNode) return null
        const leaf = numLeaf(elNode)
        if (!leaf) return null
        values.push({ kind: 'number', value: leaf.value, range: leaf.range, noLive: true })
    }
    return {
        kind: 'arraySeq',
        range: [a.start, a.end],
        values,
        mods,
        arrayInnerEnd: n.end - 1, // before ']'
        tags: ['array'],
        noLive: true
    }
}

// the trailing [* scale] [+ offset] of a binding expression; null when a
// present factor isn't a plain numeric leaf (then it's not a widget shape)
function peelScaleOffset(node) {
    let body = node
    let offset = null
    let scale = null
    if (body.type === 'BinaryExpression' && body.operator === '+') {
        const leaf = numLeaf(body.right)
        if (!leaf) return null
        offset = { kind: 'number', value: leaf.value, range: leaf.range, inExpr: true }
        body = body.left
    }
    if (body.type === 'BinaryExpression' && body.operator === '*') {
        const leaf = numLeaf(body.right)
        if (!leaf) return null
        scale = { kind: 'number', value: leaf.value, range: leaf.range, inExpr: true }
        body = body.left
    }
    return { body, scale, offset }
}

// a.fft[n] [* scale] [+ offset] — the bare expression shape, shared by the
// arrow-arg widget and the update-hook global bindings
function audioBindShape(node) {
    const peeled = peelScaleOffset(node)
    if (!peeled) return null
    const { body, scale, offset } = peeled
    // a.fft[<int literal>]
    if (body.type !== 'MemberExpression' || !body.computed) return null
    const bin = body.property && body.property.type === 'Literal' && typeof body.property.value === 'number'
        ? body.property : null
    const obj = body.object
    const isFft = obj && obj.type === 'MemberExpression' && !obj.computed &&
        obj.object.type === 'Identifier' && obj.object.name === 'a' &&
        obj.property.type === 'Identifier' && obj.property.name === 'fft'
    if (!bin || !isFft) return null
    return { bin: bin.value, binRange: [bin.start, bin.end], scale, offset }
}

// mouse.x [/ width] [* scale] [+ offset] — the bare expression shape
function mouseBindShape(node) {
    const peeled = peelScaleOffset(node)
    if (!peeled) return null
    let { body } = peeled
    let norm = false // divided by the canvas dimension -> 0..1
    if (body.type === 'BinaryExpression' && body.operator === '/' &&
        body.right.type === 'Identifier' && (body.right.name === 'width' || body.right.name === 'height')) {
        norm = true
        body = body.left
    }
    if (body.type !== 'MemberExpression' || body.computed) return null
    if (!(body.object.type === 'Identifier' && body.object.name === 'mouse')) return null
    if (!(body.property.type === 'Identifier' && (body.property.name === 'x' || body.property.name === 'y'))) return null
    return { axis: body.property.name, norm, scale: peeled.scale, offset: peeled.offset }
}

// () => a.fft[n] [* scale] [+ offset] -> audio-reactive binding widget
function classifyAudioBind(a) {
    if (a.type !== 'ArrowFunctionExpression' || a.body.type === 'BlockStatement') return null
    const shape = audioBindShape(a.body)
    if (!shape) return null
    return { kind: 'audioBind', range: [a.start, a.end], ...shape, tags: ['audio'], noLive: true }
}

// () => mouse.x [/ width] [* scale] [+ offset] -> mouse-reactive binding widget
function classifyMouseBind(a) {
    if (a.type !== 'ArrowFunctionExpression' || a.body.type === 'BlockStatement') return null
    const shape = mouseBindShape(a.body)
    if (!shape) return null
    return { kind: 'mouseBind', range: [a.start, a.end], ...shape, tags: ['mouse'], noLive: true }
}

// the synth globals a setup row can hold; also the only names allowed on the
// left of an update-hook binding
export const BIND_GLOBALS = ['speed', 'bpm', 'fps']

// every statement of the update body must be `<global> = <audio|mouse shape>`
// for the block to decompose into bound setup rows; anything else stays raw
function classifyUpdateBinds(block) {
    const binds = []
    for (const s of block.body) {
        if (s.type !== 'ExpressionStatement') return null
        const e = s.expression
        if (e.type !== 'AssignmentExpression' || e.operator !== '=' ||
            e.left.type !== 'Identifier' || !BIND_GLOBALS.includes(e.left.name)) return null
        const audio = audioBindShape(e.right)
        const mouse = audio ? null : mouseBindShape(e.right)
        if (!audio && !mouse) return null
        binds.push({
            name: e.left.name,
            stmtRange: [s.start, s.end],
            arg: {
                kind: audio ? 'audioBind' : 'mouseBind',
                bare: true,
                range: [e.right.start, e.right.end],
                ...(audio || mouse),
                tags: [audio ? 'audio' : 'mouse'],
                noLive: true
            }
        })
    }
    return binds.length ? binds : null
}

function detectTags(slice, node) {
    const tags = []
    if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') tags.push('fn')
    if (node.type === 'ArrayExpression' || /^\[/.test(slice) || /\.(fast|smooth|ease|offset|fit)\s*\(/.test(slice)) tags.push('array')
    if (/\btime\b/.test(slice)) tags.push('time')
    if (/\bmouse\b/.test(slice)) tags.push('mouse')
    if (/\ba\.fft\b/.test(slice)) tags.push('audio')
    if (/\bMath\./.test(slice)) tags.push('math')
    return tags
}

// first output not already taken by a chain, for the "+ new chain" action
export function freeOutput(model) {
    const used = new Set()
    model.statements.forEach((s) => { if (s.kind === 'chain' && s.out) used.add(s.out.target) })
    for (const o of ['o0', 'o1', 'o2', 'o3']) if (!used.has(o)) return o
    return 'o0'
}
