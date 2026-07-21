import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { snippetCompletion } from '@codemirror/autocomplete'
import { syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import type { DocEntry } from '../docs/dsl-docs'
import { docsOfKind } from '../docs/dsl-docs'
import { SCALES } from '@rondocode/pattern'

/* ------------------------------------------------------------------------- *
 * Context-aware completions for the rondocode DSL, driven entirely by the
 * dsl-docs data. Three syntactic contexts, resolved with the CodeMirror
 * syntax tree (the javascript() language is always installed):
 *
 * - inside a string literal → NOTHING. Strings are mini-notation; JS
 *   completions there would be pure noise (mini docs surface via hover).
 * - inside a synth(...) call → the builder vocabulary: ctx members bare,
 *   ctx members + Sig methods after '.'.
 * - anywhere else → scope globals bare; Pattern methods after '.' when the
 *   receiver plausibly is a pattern.
 *
 * "Plausibly a pattern" (documented heuristic, deliberately loose — a
 * false positive shows an ignorable list, a false negative hides the API):
 * the token before the '.' is ')' or ']' (a call chain / index), OR an
 * identifier that is a known pattern-producing global (entry points,
 * constructors, signals), OR any identifier of 1–2 characters (the lambda
 * parameter idiom: every(4, x => x.rev())). Longer unknown identifiers get
 * no options — `Math.` and friends stay clean.
 * ------------------------------------------------------------------------- */

/** Globals whose value IS a pattern or returns one — plausible '.' receivers. */
const PATTERN_PRODUCERS = new Set([
  'n', 'note', 'sound', 's', 'mini', 'm',
  'cat', 'fastcat', 'stack', 'timecat', 'silence', 'reify',
  'sine', 'sine2', 'cosine', 'saw', 'isaw', 'tri', 'square',
  'saw2', 'tri2', 'square2', 'rand', 'perlin', 'irand',
])

/** Globals that are plain values (no call parens on insert). */
const VALUE_GLOBALS = new Set([
  'silence',
  'sine', 'sine2', 'cosine', 'saw', 'isaw', 'tri', 'square',
  'saw2', 'tri2', 'square2', 'rand', 'perlin',
])

export type SyntacticContext = 'string' | 'synth' | 'top'

/**
 * Classify a document position: inside a string/template literal, inside a
 * synth(...) call's arguments, or ordinary top-level code. Tree-based; if
 * the parse tree does not reach `pos` (never the case for the small docs a
 * live-coding editor holds, but cheap to guard), everything reads as 'top'.
 */
export const syntacticContext = (state: EditorState, pos: number): SyntacticContext => {
  const tree = syntaxTree(state)
  for (let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(pos, -1); node !== null; node = node.parent) {
    if (node.name === 'String' || node.name === 'TemplateString') return 'string'
    if (node.name === 'CallExpression') {
      const callee = node.firstChild
      if (callee !== null && state.sliceDoc(callee.from, callee.to) === 'synth') return 'synth'
    }
  }
  return 'top'
}

/** When `pos` sits inside a string, the name of the call whose argument that
 *  string is — the bare callee (`chord`, `note`, `s`) or the member method
 *  (`.scale`, `.sound`). null if not inside a call's string argument. */
export const stringCallName = (state: EditorState, pos: number): string | null => {
  const tree = syntaxTree(state)
  for (
    let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(pos, -1);
    node !== null;
    node = node.parent
  ) {
    if (node.name === 'CallExpression') {
      const callee = node.firstChild
      if (callee === null) return null
      if (callee.name === 'VariableName') return state.sliceDoc(callee.from, callee.to)
      if (callee.name === 'MemberExpression') {
        const prop = callee.lastChild // the .method name
        if (prop !== null) return state.sliceDoc(prop.from, prop.to)
      }
      return null
    }
  }
  return null
}

/** The token ending at `pos` (exclusive), skipping trailing whitespace:
 *  ')' / ']' / '`' (tagged-template result, e.g. m`bd sn`.) / an
 *  identifier / undefined. */
const receiverToken = (state: EditorState, pos: number): string | undefined => {
  const text = state.sliceDoc(Math.max(0, pos - 64), pos)
  const m = /([A-Za-z_$][\w$]*|\)|\]|`)\s*$/.exec(text)
  return m?.[1]
}

const plausiblePatternReceiver = (state: EditorState, dotPos: number): boolean => {
  const tok = receiverToken(state, dotPos)
  if (tok === undefined) return false
  if (tok === ')' || tok === ']' || tok === '`') return true
  return PATTERN_PRODUCERS.has(tok) || tok.length <= 2
}

// ------------------------------------------------------------ option build

/** Signature "name(...)" with actual arguments → snippet with the cursor
 *  between the parens; "name()" → insert the empty call; bare value → name. */
const toCompletion = (e: DocEntry, boost?: number): Completion => {
  const paren = e.signature.indexOf('(')
  const info = (): Node => renderInfo(e)
  const base = { label: e.name, detail: signatureDetail(e), info, ...(boost !== undefined ? { boost } : {}) }
  if (paren === -1 || (e.kind === 'global' && VALUE_GLOBALS.has(e.name))) {
    return { ...base, type: 'variable' }
  }
  const zeroArg = /\(\s*\)/.test(e.signature.slice(paren))
  if (zeroArg) return { ...base, type: 'function', apply: `${e.name}()` }
  return snippetCompletion(`${e.name}(#{})`, { ...base, type: 'function' })
}

/** The parameter list portion of the signature, shown dimmed next to the label. */
const signatureDetail = (e: DocEntry): string => {
  const paren = e.signature.indexOf('(')
  return paren === -1 ? '' : e.signature.slice(paren)
}

/** The one DOM-touching part: a small info panel (summary + example). */
const renderInfo = (e: DocEntry): Node => {
  const root = document.createElement('div')
  root.className = 'cm-dsl-doc'
  const sig = document.createElement('div')
  sig.className = 'cm-dsl-doc-signature'
  sig.textContent = e.signature
  const summary = document.createElement('div')
  summary.className = 'cm-dsl-doc-summary'
  summary.textContent = e.summary
  root.append(sig, summary)
  if (e.example !== undefined) {
    const ex = document.createElement('code')
    ex.className = 'cm-dsl-doc-example'
    ex.textContent = e.example
    root.append(ex)
  }
  return root
}

// Option lists are static — build each once.
const build = (kinds: DocEntry['kind'][], boost?: (e: DocEntry) => number | undefined): Completion[] =>
  kinds.flatMap((k) => docsOfKind(k).map((e) => toCompletion(e, boost?.(e))))

// ---- in-string vocab: notes, chords, scales, sounds -----------------------
// Inside the argument string of note()/chord()/.scale()/.sound(), the useful
// completions are DOMAIN values, not JS. (Every other string stays quiet.)

const NOTE_LETTERS = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b']
const CHORD_ROOTS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const CHORD_SUFFIXES = [
  '', 'm', '7', 'maj7', 'm7', 'm7b5', 'dim', 'dim7', 'aug',
  'sus2', 'sus4', '6', 'm6', 'add9', '9', 'maj9', 'm9', '11', '13',
]

// note names c1..b7 (the register a live-coder actually reaches for)
const NOTE_OPTIONS: Completion[] = []
for (let oct = 1; oct <= 7; oct++) {
  for (const l of NOTE_LETTERS) NOTE_OPTIONS.push({ label: `${l}${oct}`, type: 'constant' })
}

// root × quality. boost the plain triads so they sort above the extensions.
const CHORD_OPTIONS: Completion[] = CHORD_ROOTS.flatMap((root) =>
  CHORD_SUFFIXES.map((suf) => ({
    label: `${root}${suf}`,
    detail: suf === '' ? 'major' : suf === 'm' ? 'minor' : suf,
    type: 'class',
    boost: suf === '' || suf === 'm' || suf === '7' ? 1 : 0,
  })),
)

const SCALE_OPTIONS: Completion[] = Object.keys(SCALES).map((name) => ({
  label: name.toLowerCase(),
  type: 'keyword',
}))

/** Synth names defined in the current doc (`const X = synth(...)`) plus the
 *  built-in demo samples — the plausible arguments to .sound()/s(). */
const soundOptions = (doc: string): Completion[] => {
  const names = new Set<string>(['vox', 'riser', 'pad'])
  const re = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*synth\b/g
  for (let m = re.exec(doc); m !== null; m = re.exec(doc)) names.add(m[1]!)
  return [...names].map((label) => ({ label, type: 'variable' }))
}

/** For an in-string completion request, which vocabulary applies here — the
 *  matchBefore regex to find the token, and the option list — or null. */
const stringVocab = (
  fn: string,
  doc: string,
): { re: RegExp; options: Completion[] } | null => {
  switch (fn) {
    case 'chord':
      return { re: /[A-Ga-g][\w#/]*$/, options: CHORD_OPTIONS }
    case 'note':
      return { re: /[a-gA-G][#b]?\d*$/, options: NOTE_OPTIONS }
    case 'scale':
      return { re: /[A-Za-z]+$/, options: SCALE_OPTIONS }
    case 'sound':
    case 's':
      return { re: /[\w]+$/, options: soundOptions(doc) }
    default:
      return null
  }
}

const PATTERN_OPTIONS = build(['pattern-method'])
// After '.' inside synth(): Sig methods are the common case (chaining);
// ctx members cover the non-destructured ctx.sine(...) style. Rank Sig
// methods first.
const SYNTH_DOT_OPTIONS = build(['sig-method', 'synth-ctx'], (e) => (e.kind === 'sig-method' ? 1 : -1))
const SYNTH_BARE_OPTIONS = build(['synth-ctx'])
const GLOBAL_OPTIONS = build(['global'])

// ----------------------------------------------------------------- source

/**
 * The completion source wired into autocompletion({ override }). Returns
 * null (no completions) inside strings, after '.' on an implausible
 * receiver, and on bare positions with no typed prefix unless explicitly
 * invoked (Ctrl-Space).
 */
export const rondocodeCompletionSource = (
  context: CompletionContext,
): CompletionResult | null => {
  const kind = syntacticContext(context.state, context.pos)
  if (kind === 'string') {
    // Domain completions for the strings that carry musical vocabulary:
    // chord('Cmaj7'), note('c4'), .scale('c major'), .sound('acid'). Every
    // other string (mini-notation degrees, m`…`) stays quiet.
    const fn = stringCallName(context.state, context.pos)
    const vocab = fn === null ? null : stringVocab(fn, context.state.doc.toString())
    if (vocab === null) return null
    const tok = context.matchBefore(vocab.re)
    if (tok === null && !context.explicit) return null
    return { from: tok?.from ?? context.pos, options: vocab.options, validFor: vocab.re }
  }

  const dot = context.matchBefore(/\.[\w$]*$/)
  if (dot !== null) {
    // Guard against numeric literals: `0.` must not complete (receiverToken
    // only matches identifiers/'()'/'[]', so `0` fails the check).
    const options = kind === 'synth' ? SYNTH_DOT_OPTIONS : PATTERN_OPTIONS
    if (kind !== 'synth' && !plausiblePatternReceiver(context.state, dot.from)) return null
    if (kind === 'synth' && receiverToken(context.state, dot.from) === undefined) return null
    return { from: dot.from + 1, options, validFor: /^[\w$]*$/ }
  }

  const word = context.matchBefore(/[\w$]+$/)
  if (word === null && !context.explicit) return null
  const from = word?.from ?? context.pos
  return {
    from,
    options: kind === 'synth' ? SYNTH_BARE_OPTIONS : GLOBAL_OPTIONS,
    validFor: /^[\w$]*$/,
  }
}
