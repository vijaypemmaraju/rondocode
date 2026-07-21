import { Decoration, ViewPlugin } from '@codemirror/view'
import type { DecorationSet, EditorView, ViewUpdate } from '@codemirror/view'
import { EditorState, Prec, RangeSetBuilder } from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import { snippetCompletion } from '@codemirror/autocomplete'
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { stringCallName } from './complete'

/* ------------------------------------------------------------------------- *
 * Inline WGSL support inside visual(`…`): the template argument of a visual()
 * call is shader code, not a mini-notation string. We (a) overlay WGSL syntax
 * highlighting on those ranges (the JS grammar only sees "a string"), and (b)
 * offer WGSL + rondocode-audio-API completions when the cursor is inside one.
 * ------------------------------------------------------------------------- */

// ---- vocabulary ----------------------------------------------------------

const KEYWORDS = new Set([
  'fn', 'let', 'var', 'const', 'return', 'if', 'else', 'for', 'loop', 'while',
  'break', 'continue', 'switch', 'case', 'default', 'discard', 'struct', 'true',
  'false', 'override', 'alias',
])
const TYPES = new Set([
  'f32', 'i32', 'u32', 'f16', 'bool', 'void', 'atomic', 'array', 'ptr', 'sampler',
  'sampler_comparison',
  'vec2f', 'vec3f', 'vec4f', 'vec2i', 'vec3i', 'vec4i', 'vec2u', 'vec3u', 'vec4u',
  'vec2', 'vec3', 'vec4', 'mat2x2f', 'mat3x3f', 'mat4x4f', 'mat2x2', 'mat3x3', 'mat4x4',
])
// the rondocode audio API injected into every shader (see shaderviz PRELUDE)
const API_VARS = new Set(['time', 'res', 'level', 'bass', 'mid', 'treble', 'cps', 'phase', 'hit', 'beat', 'uv'])
const API_FNS = new Set(['spectrum', 'waveform', 'render'])
const BUILTINS = new Set([
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'pow', 'exp', 'exp2', 'log',
  'log2', 'sqrt', 'inverseSqrt', 'abs', 'sign', 'floor', 'ceil', 'round', 'trunc',
  'fract', 'min', 'max', 'clamp', 'mix', 'step', 'smoothstep', 'length', 'distance',
  'dot', 'cross', 'normalize', 'reflect', 'refract', 'select', 'radians', 'degrees',
  'modf', 'fma', 'saturate', 'textureSample', 'textureSampleLevel', 'textureLoad',
])
const isType = (id: string): boolean =>
  TYPES.has(id) || /^(vec[234]|mat[234]x[234])[fiu]?$/.test(id) || id.startsWith('texture_')

// ---- tokenizer -----------------------------------------------------------

interface Tok {
  from: number
  to: number
  cls: string
}

const TOKEN_RE =
  /(\/\*[\s\S]*?\*\/)|(\/\/[^\n]*)|(@[A-Za-z_]\w*)|(0x[0-9a-fA-F]+|\d+\.?\d*(?:[eE][+-]?\d+)?[fhiu]?)|([A-Za-z_]\w*)|(\s+)|([^\sA-Za-z_@]+)/g

/** Classify WGSL over `text`, yielding one token per visible run (whitespace
 *  produces none). Identifiers are keyword / type / audio-API / builtin / call
 *  (followed by `(`) / plain. */
function tokenizeWgsl(text: string): Tok[] {
  const out: Tok[] = []
  TOKEN_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TOKEN_RE.exec(text)) !== null) {
    const from = m.index
    const to = from + m[0].length
    if (m[1] !== undefined || m[2] !== undefined) out.push({ from, to, cls: 'wgsl-com' })
    else if (m[3] !== undefined) out.push({ from, to, cls: 'wgsl-attr' })
    else if (m[4] !== undefined) out.push({ from, to, cls: 'wgsl-num' })
    else if (m[5] !== undefined) {
      const id = m[5]
      let cls = 'wgsl-id'
      if (KEYWORDS.has(id)) cls = 'wgsl-kw'
      else if (isType(id)) cls = 'wgsl-type'
      else if (API_VARS.has(id) || /^hit_[A-Za-z0-9_]+$/.test(id)) cls = 'wgsl-api'
      else if (API_FNS.has(id) || BUILTINS.has(id)) cls = 'wgsl-fn'
      else if (/^\s*\(/.test(text.slice(to))) cls = 'wgsl-fn' // user-defined call
      out.push({ from, to, cls })
    } else if (m[7] !== undefined) out.push({ from, to, cls: 'wgsl-punct' })
    // m[6] = whitespace → skip
  }
  return out
}

// ---- visual() template ranges (from the JS syntax tree) ------------------

/** Content ranges (inside the backticks) of every visual(`…`) template. */
function visualTemplateRanges(state: EditorState): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = []
  const tree = syntaxTree(state)
  tree.iterate({
    enter(node) {
      if (node.name !== 'TemplateString' && node.name !== 'String') return
      // walk up to the enclosing CallExpression; its callee must be `visual`
      for (let p = node.node.parent; p !== null; p = p.parent) {
        if (p.name === 'CallExpression') {
          const callee = p.firstChild
          if (callee !== null && state.sliceDoc(callee.from, callee.to) === 'visual') {
            // strip the delimiters (backtick / quote)
            if (node.to - node.from >= 2) out.push({ from: node.from + 1, to: node.to - 1 })
          }
          return
        }
        if (p.name === 'ArgList') continue
        // stop climbing once we leave the immediate argument position
        if (p.name === 'TemplateString' || p.name === 'String') continue
        break
      }
    },
  })
  return out
}

// ---- highlight ViewPlugin ------------------------------------------------

const decoCache = new Map<string, Decoration>()
const tokenDeco = (cls: string): Decoration => {
  let d = decoCache.get(cls)
  if (!d) {
    d = Decoration.mark({ class: cls })
    decoCache.set(cls, d)
  }
  return d
}

const wgslHighlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = this.build(view)
    }
    update(u: ViewUpdate): void {
      if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) {
        this.decorations = this.build(u.view)
      }
    }
    build(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>()
      const ranges = visualTemplateRanges(view.state).sort((a, b) => a.from - b.from)
      const { from: vpFrom, to: vpTo } = view.viewport
      for (const r of ranges) {
        const from = Math.max(r.from, vpFrom)
        const to = Math.min(r.to, vpTo)
        if (from >= to) continue
        const text = view.state.sliceDoc(from, to)
        for (const tok of tokenizeWgsl(text)) {
          builder.add(from + tok.from, from + tok.to, tokenDeco(tok.cls))
        }
      }
      return builder.finish()
    }
  },
  { decorations: (v) => v.decorations },
)

/** WGSL highlighting overlaid on visual(`…`) templates. Highest precedence so
 *  its per-token marks nest inside the JS grammar's whole-string coloring. */
export function wgslHighlight(): Extension {
  return Prec.highest(wgslHighlighter)
}

// ---- completions ---------------------------------------------------------

const kw = (label: string): Completion => ({ label, type: 'keyword' })
const ty = (label: string): Completion => ({ label, type: 'type' })
const fnSnippet = (label: string, detail: string): Completion =>
  snippetCompletion(`${label}(\${})`, { label, type: 'function', detail })
const apiVar = (label: string, detail: string): Completion => ({ label, type: 'variable', detail })

const WGSL_COMPLETIONS: Completion[] = [
  // rondocode audio API (surfaced first via boost)
  { ...apiVar('level', 'audio: overall loudness 0..1'), boost: 90 },
  { ...apiVar('bass', 'audio: low-band energy 0..1'), boost: 89 },
  { ...apiVar('mid', 'audio: mid-band energy 0..1'), boost: 88 },
  { ...apiVar('treble', 'audio: high-band energy 0..1'), boost: 87 },
  { ...apiVar('beat', 'audio: bass-driven pulse 0..1'), boost: 86 },
  { ...apiVar('hit', 'audio: note-onset envelope 0..1'), boost: 85 },
  { ...apiVar('time', 'audio clock, seconds'), boost: 84 },
  { ...apiVar('phase', 'cycle position 0..1'), boost: 83 },
  { ...apiVar('cps', 'tempo, cycles/sec'), boost: 82 },
  { ...apiVar('res', 'vec2f canvas resolution (px)'), boost: 81 },
  { ...apiVar('uv', 'vec2f pixel coord 0..1 (render arg)'), boost: 80 },
  { ...fnSnippet('spectrum', 'FFT magnitude 0..1 at x(0..1)'), boost: 79 },
  { ...fnSnippet('waveform', 'waveform sample -1..1 at x(0..1)'), boost: 78 },
  snippetCompletion('fn render(uv: vec2f) -> vec4f {\n\t${}\n\treturn vec4f(0.0, 0.0, 0.0, 1.0);\n}', {
    label: 'render',
    type: 'function',
    detail: 'shader entry point',
    boost: 77,
  }),
  // keywords
  ...['fn', 'let', 'var', 'const', 'return', 'if', 'else', 'for', 'loop', 'while', 'break', 'continue', 'struct', 'true', 'false'].map(kw),
  // types
  ...['f32', 'i32', 'u32', 'bool', 'vec2f', 'vec3f', 'vec4f', 'vec2i', 'vec3i', 'vec4i', 'mat2x2f', 'mat3x3f', 'mat4x4f', 'array'].map(ty),
  // builtins
  ...['sin', 'cos', 'tan', 'atan2', 'pow', 'exp', 'log', 'sqrt', 'abs', 'sign', 'floor', 'ceil', 'round', 'fract', 'min', 'max', 'clamp', 'mix', 'step', 'smoothstep', 'length', 'distance', 'dot', 'cross', 'normalize', 'reflect', 'select', 'radians', 'degrees'].map((l) =>
    fnSnippet(l, 'wgsl builtin'),
  ),
]

/** Completions inside a visual(`…`) template: WGSL + the rondocode audio API.
 *  Returns null everywhere else (so mini-notation strings stay clean). */
export const wgslCompletionSource = (context: CompletionContext): CompletionResult | null => {
  if (stringCallName(context.state, context.pos) !== 'visual') return null
  const word = context.matchBefore(/[A-Za-z_]\w*/)
  if (word === null && !context.explicit) return null
  return {
    from: word ? word.from : context.pos,
    options: WGSL_COMPLETIONS,
    validFor: /^[A-Za-z_]\w*$/,
  }
}
