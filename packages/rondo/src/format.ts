/* rondo auto-formatter — conservative, token-preserving, pure.
 *
 * The contract (pinned by test/format.test.ts):
 *   1. compile(format(src)).code === compile(src).code for every valid program
 *   2. format(format(src)) === format(src)  (idempotence)
 *   3. js escape hatches (js{ … } inline spans, js/visual/mask block bodies) are
 *      byte-preserved — the compiler treats them (near-)verbatim, so the
 *      formatter never touches a byte inside them.
 *
 * To guarantee (1) the formatter only rewrites whitespace the COMPILER also
 * treats as insignificant. Everything the compiler reads from raw line text
 * (play/beat notation, sing lyric/melody pairs, modifier values, bare
 * combinator lines, js/visual/mask bodies) is left byte-for-byte alone; only
 * token-parsed lines (synth spines, bindings, headers, top-level statements)
 * get their interior spacing tidied, and only in ways that cannot change the
 * token stream. Line CLASSIFICATION reuses the real lexer + the parser's own
 * isModifierLine, so the formatter can never disagree with the compiler about
 * what a line is.
 *
 * The rules:
 *   - block indentation: 2 per level (synth/play/beat/bus/sing bodies at 2;
 *     section-nested play/beat headers at 2, their bodies at 4; a synth/sing
 *     `post` sub-block body nests +2 under the `post` line)
 *   - trailing whitespace stripped everywhere except js/visual/mask block bodies
 *   - exactly one blank line between top-level blocks (inserted when missing,
 *     runs collapsed), none at file start, single trailing newline; a comment
 *     group directly above a block sticks to it (the blank goes above the
 *     comments)
 *   - runs of 3+ interior spaces collapse to one on token-parsed lines
 *     (2-space runs survive — they are the light-alignment style the shipped
 *     examples use). The run before a binding `=` is exempt entirely, so
 *     `amp  = …` / `cutoff = …` name-alignment columns survive.
 *   - binding lines normalize to `name = expr` (at least one space each side)
 *   - modifier lines get one space after the head colon (`gain: .8`,
 *     `every 4: rev`); the VALUE side is untouched (it may be mini notation,
 *     which the compiler emits verbatim). Inline `scale:a-min` and named args
 *     (`res:.5`) stay glued — that is their canonical spelling.
 *   - play-notation lines keep their interior spacing verbatim, except the
 *     gap before an inline `scale:…` normalizes to the conventional two
 *     spaces
 *   - comments are preserved verbatim; own-line comments re-indent with their
 *     block, trailing comments keep their gap and text untouched
 *
 * Whole-doc formatting only runs on programs that COMPILE (prettier-style:
 * broken code comes back unchanged). formatRondoLine — the format-on-newline
 * path — works on any doc and falls back to leaving unclassifiable lines
 * alone. */

import { compile } from './compile'
import { lex, scanBalanced, stripComment } from './lexer'
import type { Line } from './lexer'
import { FN_COMBS, STATEMENT_KEYWORDS, isModifierLine } from './parser'

/* ---- per-line plans -------------------------------------------------------- */

/** How one source line gets rendered.
 *  - expr:     token-parsed line — collapse 3+ space runs (js{ } protected)
 *  - binding:  expr + `name = rhs` spacing (alignment before `=` preserved)
 *  - mod:      head-colon spacing only; the value side is verbatim
 *  - notation: verbatim interior except the two-space inline-scale gap
 *  - raw:      verbatim interior (beat rows, sing pairs, unknown lines) */
type Role = 'expr' | 'binding' | 'mod' | 'notation' | 'raw'

type Plan =
  | { kind: 'blank' }
  | { kind: 'comment' }
  | { kind: 'keep' } // js/visual/mask block body: byte-identical, not even a trim
  | { kind: 'code'; role: Role; indent: number | null } // null = keep original

/** Imported, not retyped: a one-line statement the parser accepts but the
 *  formatter does not know about keeps whatever indent it was written with,
 *  which for a top-level line is a parse error the formatter exists to fix. */
const STATEMENTS = STATEMENT_KEYWORDS

const isBinding = (ln: Line): boolean =>
  ln.toks.length >= 2 && ln.toks[0]!.k === 'ident' && ln.toks[1]!.k === 'eq'

const isPostLine = (ln: Line): boolean =>
  ln.toks.length === 1 && ln.toks[0]!.k === 'ident' && ln.toks[0]!.v === 'post'

/** Classify every source line, mirroring the parser's block walk. */
function analyze(src: string): { lines: string[]; plans: Plan[] } {
  const lines = src.split('\n')
  const plans: Plan[] = lines.map((full) => {
    if (full.trim() === '') return { kind: 'blank' }
    if (stripComment(full).trim() === '') return { kind: 'comment' }
    // default: untouched interior, untouched indent (orphans / unknown blocks)
    return { kind: 'code', role: 'raw', indent: null }
  })
  const { lines: LL } = lex(src)
  const setPlan = (ln: Line, role: Role, indent: number | null): void => {
    plans[ln.line - 1] = { kind: 'code', role, indent }
  }
  /** play/beat body: leading non-modifier lines are notation voices, the rest
   *  are modifiers — the parser's exact split. */
  const planPlayBody = (body: Line[], kind: 'play' | 'beat', indent: number): void => {
    let inMods = false
    for (const b of body) {
      if (!inMods && !isModifierLine(b, kind)) setPlan(b, kind === 'play' ? 'notation' : 'raw', indent)
      else {
        inMods = true
        setPlan(b, 'mod', indent)
      }
    }
  }
  /** A synth or sing body at `base`: its lines at `base`, an optional trailing
   *  `post` sub-block with the keyword at `base` and its lines at `base + 2`. */
  const planVoiceBody = (body: Line[], kw: 'synth' | 'sing', base: number): void => {
    const pIdx = body.findIndex(isPostLine)
    const voice = pIdx >= 0 ? body.slice(0, pIdx) : body
    const post = pIdx >= 0 ? body.slice(pIdx + 1) : []
    // `post must be the last section` — anything at or above its indent
    // after it is a parse error; leave such a block's body untouched
    if (pIdx >= 0 && post.some((b) => b.indent <= body[pIdx]!.indent)) return
    if (kw === 'synth') {
      for (const b of voice) setPlan(b, isBinding(b) ? 'binding' : 'expr', base)
    } else {
      let inMods = false
      for (const b of voice) {
        if (!inMods && !isModifierLine(b)) setPlan(b, 'raw', base) // lyric/melody pair
        else {
          inMods = true
          setPlan(b, 'mod', base)
        }
      }
    }
    if (pIdx >= 0) {
      setPlan(body[pIdx]!, 'expr', base)
      for (const b of post) setPlan(b, isBinding(b) ? 'binding' : 'expr', base + 2)
    }
  }

  let k = 0
  while (k < LL.length) {
    const ln = LL[k]!
    if (ln.indent !== 0) {
      k++ // an orphan indented line (parse error) — leave it alone
      continue
    }
    const head = ln.toks[0]
    if (head === undefined) {
      k++
      continue
    }
    if (head.k === 'jsexpr') {
      setPlan(ln, 'expr', 0) // top-level js{ … } one-liner (fully protected)
      k++
      continue
    }
    if (head.k !== 'ident') {
      k++
      continue
    }
    const kw = head.v
    if (STATEMENTS.has(kw)) {
      setPlan(ln, 'expr', 0)
      k++
      continue
    }
    const isBlock =
      kw === 'synth' || kw === 'sing' || kw === 'play' || kw === 'beat' || kw === 'bus' ||
      kw === 'section' || ((kw === 'js' || kw === 'visual') && ln.toks.length === 1) ||
      ((kw === 'mask' || kw === 'draw') && ln.toks.length === 2)
    if (!isBlock) {
      k++ // unknown block keyword — leave the line (and its body) alone
      continue
    }
    // collect the block body: following lexed lines at indent > 0
    let j = k + 1
    while (j < LL.length && LL[j]!.indent > 0) j++
    const body = LL.slice(k + 1, j)
    setPlan(ln, 'expr', 0)

    if (kw === 'js' || kw === 'visual' || kw === 'mask' || kw === 'draw') {
      // escape hatches are verbatim-with-indent in the compiler; the formatter
      // goes one further and keeps every byte, blank lines included
      if (body.length > 0) {
        const lastSrc = body[body.length - 1]!.line - 1
        for (let s = ln.line; s <= lastSrc; s++) plans[s] = { kind: 'keep' }
      }
    } else if (kw === 'synth' || kw === 'sing') {
      planVoiceBody(body, kw, 2)
    } else if (kw === 'play' || kw === 'beat') {
      planPlayBody(body, kw, 2)
    } else if (kw === 'bus') {
      for (const b of body) setPlan(b, isBinding(b) ? 'binding' : 'expr', 2)
    } else {
      // section: nested play/beat/sing headers at 2, their bodies at 4 (a
      // nested sing's `post` line at 4 and ITS lines at 6, as planVoiceBody
      // lays out from the base)
      let m = 0
      while (m < body.length) {
        const bl = body[m]!
        const bh = bl.toks[0]
        if (bh !== undefined && bh.k === 'ident' && (bh.v === 'play' || bh.v === 'beat' || bh.v === 'sing')) {
          setPlan(bl, 'expr', 2)
          const nb: Line[] = []
          let q = m + 1
          while (q < body.length && body[q]!.indent > bl.indent) {
            nb.push(body[q]!)
            q++
          }
          if (bh.v === 'sing') planVoiceBody(nb, 'sing', 4)
          else planPlayBody(nb, bh.v, 4)
          m = q
        } else {
          m++ // not a nested block (parse error) — leave it alone
        }
      }
    }
    k = j
  }
  return { lines, plans }

}

/* ---- interior transforms ---------------------------------------------------- */

/** Split a line's content into js{ … } spans (protected, byte-preserved) and
 *  free text, using the lexer's own balanced/string-aware scan. */
function mapUnprotected(core: string, fn: (s: string) => string): string {
  let out = ''
  let i = 0
  const re = /\bjs[ \t]*\{/g
  for (;;) {
    re.lastIndex = i
    const m = re.exec(core)
    if (m === null) {
      out += fn(core.slice(i))
      return out
    }
    const open = core.indexOf('{', m.index)
    const close = scanBalanced(core, open)
    out += fn(core.slice(i, m.index))
    if (close < 0) return out + core.slice(m.index) // unterminated: hands off
    out += core.slice(m.index, close + 1)
    i = close + 1
  }
}

/** Collapse runs of 3+ spaces to one, outside js{ … } spans. Never merges
 *  tokens (one space always remains), so the token stream is unchanged. */
const collapseRuns = (core: string): string => mapUnprotected(core, (s) => s.replace(/ {3,}/g, ' '))

/** `name = rhs`: at least one space each side of `=`; the run BEFORE `=` is
 *  preserved as-is (binding-name alignment columns are a deliberate style). */
function formatBinding(core: string): string {
  const m = /^([a-zA-Z_]\w*)([ \t]*)=([ \t]*)([\s\S]*)$/.exec(core)
  if (m === null) return collapseRuns(core)
  const before = m[2] === '' ? ' ' : m[2]!
  const after = m[3] === '' || m[3]!.length >= 3 ? ' ' : m[3]!
  return `${m[1]}${before}=${after}${collapseRuns(m[4]!)}`
}

/** Modifier lines: normalize the HEAD only (`name pre…: value` with single
 *  spaces and one space after the colon). The value side may be mini notation
 *  the compiler emits verbatim, so it stays byte-identical. Bare combinator
 *  lines (`rev`, `struct ~ t ~ t`) have no head colon and pass through. */
function formatMod(core: string): string {
  const fc = /^([a-zA-Z_]\w*)((?:[ \t]+-?\d*\.?\d+)*)[ \t]*:[ \t]*([\s\S]*)$/.exec(core)
  if (fc !== null && FN_COMBS[fc[1]!.toLowerCase()] !== undefined) {
    const pre = fc[2]!.trim().split(/[ \t]+/).filter((s) => s !== '')
    const value = fc[3]!
    return `${fc[1]}${pre.length > 0 ? ' ' + pre.join(' ') : ''}:${value === '' ? '' : ' ' + value}`
  }
  const kv = /^([a-zA-Z_]\w*)[ \t]*:[ \t]*([\s\S]*)$/.exec(core)
  if (kv !== null) return `${kv[1]}:${kv[2] === '' ? '' : ' ' + kv[2]}`
  return core
}

/** Play notation: verbatim, except the gap before an inline `scale:…`
 *  normalizes to the conventional two spaces. The compiler slices notation at
 *  the scale match and right-strips it, so only whitespace changes here. */
function formatNotation(core: string): string {
  const m = /\bscale:[a-gA-G][a-zA-Z0-9#_-]*/.exec(core) // the parser's extractor
  if (m === null || m.index === 0) return core
  let s = m.index
  while (s > 0 && (core[s - 1] === ' ' || core[s - 1] === '\t')) s--
  if (s === m.index) return core // glued to notation text: hands off
  return core.slice(0, s) + '  ' + core.slice(m.index)
}

const transformCore = (core: string, role: Role): string => {
  switch (role) {
    case 'expr': return collapseRuns(core)
    case 'binding': return formatBinding(core)
    case 'mod': return formatMod(core)
    case 'notation': return formatNotation(core)
    case 'raw': return core
  }
}

/* ---- line rendering ---------------------------------------------------------- */

const indentOf = (full: string): string => /^[ \t]*/.exec(full)![0]

/** For an own-line comment: the target indent of the nearest code line below
 *  (falling back to the nearest above), so comments travel with their block. */
function commentIndent(i: number, lines: string[], plans: Plan[]): number {
  const targetAt = (j: number): number | null => {
    const p = plans[j]!
    if (p.kind === 'code') return p.indent ?? indentOf(lines[j]!).length
    if (p.kind === 'keep') return indentOf(lines[j]!).length
    return null
  }
  for (let j = i + 1; j < lines.length; j++) {
    const t = targetAt(j)
    if (t !== null) return t
  }
  for (let j = i - 1; j >= 0; j--) {
    const t = targetAt(j)
    if (t !== null) return t
  }
  return 0
}

/** Render one line under its plan. `keep` lines return the input unchanged. */
function renderLine(full: string, plan: Plan, i: number, lines: string[], plans: Plan[]): string {
  if (plan.kind === 'keep') return full
  if (plan.kind === 'blank') return ''
  if (plan.kind === 'comment') return ' '.repeat(commentIndent(i, lines, plans)) + full.trim()
  // code: split indent / content / trailing comment the way the lexer does
  const stripped = stripComment(full)
  const comment = full.slice(stripped.length).replace(/\s+$/, '')
  const origIndent = indentOf(stripped)
  const contentWithGap = stripped.slice(origIndent.length)
  const core = contentWithGap.replace(/[ \t]+$/, '')
  const gap = contentWithGap.slice(core.length) // the run before a trailing comment
  const indent = plan.indent === null ? origIndent : ' '.repeat(plan.indent)
  const out = indent + transformCore(core, plan.role) + (comment !== '' ? gap + comment : '')
  return out.replace(/\s+$/, '')
}

/* ---- public API ---------------------------------------------------------------- */

/** Format a whole rondo document. Programs that do not compile come back
 *  unchanged (prettier-style: the formatter never guesses at broken code). */
export function formatRondo(src: string): string {
  if (src === '') return src
  if (!compile(src).ok) return src
  const { lines, plans } = analyze(src)
  // top-level unit starts: an indent-0 code line, extended up over a directly
  // attached comment group (no blank between) — the separator blank goes above
  const unitStart: boolean[] = new Array<boolean>(lines.length).fill(false)
  for (let i = 0; i < lines.length; i++) {
    const p = plans[i]!
    if (p.kind === 'code' && p.indent === 0) {
      let s = i
      while (s > 0 && plans[s - 1]!.kind === 'comment') s--
      unitStart[s] = true
    }
  }
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const p = plans[i]!
    if (p.kind === 'keep') {
      out.push(lines[i]!)
      continue
    }
    if (p.kind === 'blank') {
      if (out.length > 0 && out[out.length - 1] !== '') out.push('') // collapse runs, none at start
      continue
    }
    if (unitStart[i] === true && out.length > 0 && out[out.length - 1] !== '') out.push('')
    out.push(renderLine(lines[i]!, p, i, lines, plans))
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out.length === 0 ? '' : out.join('\n') + '\n'
}

/** Format ONE line of a rondo document — the format-on-newline path. Returns
 *  the formatted text for line `lineNumber` (1-based), or null when the line
 *  is out of range or must not be touched (js/visual/mask block bodies). Never
 *  requires the doc to compile; unclassifiable lines only lose trailing
 *  whitespace. Blank-line structure is untouched (this is strictly local). */
export function formatRondoLine(src: string, lineNumber: number): string | null {
  const { lines, plans } = analyze(src)
  const i = lineNumber - 1
  if (i < 0 || i >= lines.length) return null
  const p = plans[i]!
  if (p.kind === 'keep') return null
  return renderLine(lines[i]!, p, i, lines, plans)
}
