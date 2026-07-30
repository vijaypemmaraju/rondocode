/* Enum tap-cycling — every enum word in a rondo synth/post/bus line becomes a
 * tappable control that cycles through its LEGAL values (the scale-chip
 * pattern from palette.ts, generalized to the builtin registry).
 *
 * The registry (@rondocode/rondo builtins) declares WHERE enums live
 * (positional slots + named-arg kinds) but not WHICH values are legal — the
 * value lists here are built explicitly from the engine kernels' accepted
 * values (each list's source is cited inline; enum-values.test.ts pins the
 * lists against the engine's exported constants so they cannot drift).
 *
 * Everything here is PURE ((text) → spans, (text, pos) → edit) and unit
 * tested; the DOM layer (mark decorations + the tap handler) lives in
 * widgets.ts and follows the gesture rules there. */

/** SVF response modes — filters.ts SvfMode (SvfKernel's output mix). */
const SVF_MODES = ['lp', 'hp', 'bp', 'notch', 'peak', 'allpass'] as const

/** Built-in wavetable names — wavetable.ts WAVETABLE_TABLES. Doc wavedefs
 *  are appended at scan time (they are the doc's own truth, fresh while
 *  typing). */
export const WT_TABLES = ['basic', 'harmonic', 'pwm'] as const

interface EnumArgLists {
  /** legal values per positional slot (index-aligned with the registry's
   *  `pos`); null = the slot is an enum but has NO static value list (sample
   *  names are runtime data — loaded/recorded, not engine constants), so it
   *  never cycles. */
  pos?: (readonly string[] | null)[]
  /** legal values per named enum arg. */
  named?: Record<string, readonly string[]>
}

/** The value table: builtin → where its enum words live and what they may
 *  be. Lists mirror the ENGINE's accepted values (kernel constructors /
 *  exported const arrays), not guesses. */
export const ENUM_VALUE_TABLE: Record<string, EnumArgLists> = {
  // osc.ts NOISE_COLORS
  noise: { pos: [['white', 'pink', 'brown']] },
  // lfo.ts LfoShape (LfoKernel's shape switch)
  lfo: { pos: [null, ['sine', 'tri', 'square', 'saw', 'rand']] },
  // osc.ts LFSR_MODES
  lfsr: { named: { mode: ['white', 'periodic'] } },
  // osc.ts FM_WAVES
  fm: { named: { wave: ['sine', 'tri', 'saw', 'square'] } },
  // filters.ts SvfMode
  svf: { named: { mode: SVF_MODES } },
  // filters.ts DualSvfRouting + per-stage SvfMode
  dualsvf: { named: { mode: ['serial', 'parallel'], a: SVF_MODES, b: SVF_MODES } },
  // shape.ts ShapeType
  shape: { named: { type: ['soft', 'hard', 'sine', 'tube'] } },
  // physical.ts MODAL_MODELS keys
  modal: { named: { model: ['bell', 'bar', 'drum', 'glass'] } },
  // width.ts MODE_DELAY keys (the decorrelation delay: 12 ms vs 3 ms)
  width: { pos: [null], named: { mode: ['wide', 'tight'] } },
  // wavetable.ts WAVETABLE_WARPS; table gets doc wavedefs appended at scan
  wavetable: { named: { warp: ['sync', 'bend', 'mirror'], table: WT_TABLES } },
  // sample/granular name their source sample: a RUNTIME set (loaded files,
  // mic takes), not an engine constant — declared so the scanner knows the
  // slot is an enum, but with no list, so the word never cycles.
  sample: { pos: [null] },
  granular: { pos: [null] },
}

/** eq band types cycle WITHIN their arity group: hp/lp bands read their
 *  numbers as freq q, peak/shelf bands as freq gain q (see the rondo
 *  codegen's eqCall) — cycling across groups would silently re-key the
 *  numbers that follow (or make them a compile error), so we don't. */
export const EQ_TYPE_CYCLES: readonly (readonly string[])[] = [
  ['hp', 'lp'],
  ['peak', 'lowshelf', 'highshelf'],
]

export interface EnumSpan {
  /** absolute char range of the enum WORD. */
  from: number
  to: number
  word: string
  /** the legal values this word cycles through. */
  values: readonly string[]
}

/** Strip a rondo ` # comment` (line start or whitespace-preceded '#'). */
const stripComment = (raw: string): string => {
  const cm = /(^|\s)#/.exec(raw)
  return cm ? raw.slice(0, cm.index + (cm[1] ? cm[1].length : 0)) : raw
}

const ATOM_RE = /^(-?\d*\.?\d+|[a-zA-Z_]\w*)$/
const WORD_RE = /^[a-zA-Z_]\w*$/

/** Doc-defined wavedef names (`wavedef NAME …` at line start). */
const scanWavedefNames = (text: string): string[] => {
  const out: string[] = []
  const re = /^wavedef[ \t]+([a-zA-Z_]\w*)/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) out.push(m[1]!)
  return out
}

/** Find every cyclable enum word in `text`. Pure — unit tested.
 *
 *  Scope: indented body lines (synth spine/bindings, post, bus) whose HEAD
 *  call is a registry builtin with enum slots, plus eq band-type words.
 *  Positional tracking is conservative: the first token that is not a simple
 *  atom (an operator, a range, a js{ } escape) ends positional matching for
 *  the line — a mis-counted slot would decorate the wrong word. Named args
 *  are position-independent and keep scanning. */
export function scanEnumSpans(text: string): EnumSpan[] {
  const out: EnumSpan[] = []
  const wavedefs = scanWavedefNames(text)
  const tableValues: readonly string[] = wavedefs.length > 0 ? [...WT_TABLES, ...wavedefs] : WT_TABLES
  let off = 0
  let block: string | undefined
  for (const raw of text.split('\n')) {
    const line = stripComment(raw)
    // track the enclosing top-level block: builtin calls live in synth (and
    // its post) and bus bodies ONLY — a `noise pink` beat row or play line
    // is notation, and decorating it would invite a wrong rewrite
    const header = /^([a-zA-Z_]\w*)\b/.exec(line)
    if (header !== null) block = header[1]
    if (block !== 'synth' && block !== 'bus') { off += raw.length + 1; continue }
    const m = /^[ \t]+(?:[a-zA-Z_]\w*[ \t]*=[ \t]*)?([a-zA-Z_]\w*)\b/.exec(line)
    if (m === null) { off += raw.length + 1; continue }
    const head = m[1]!
    const rest = line.slice(m[0].length)
    const restOff = off + m[0].length
    if (head === 'eq') {
      // band type words: each ident token starts a band
      const tok = /[a-zA-Z_]\w*/g
      let t: RegExpExecArray | null
      while ((t = tok.exec(rest)) !== null) {
        const cycle = EQ_TYPE_CYCLES.find((c) => c.includes(t![0]))
        if (cycle === undefined) continue // unknown word: the parser's error tells that story
        out.push({ from: restOff + t.index, to: restOff + t.index + t[0].length, word: t[0], values: cycle })
      }
      off += raw.length + 1
      continue
    }
    const spec = ENUM_VALUE_TABLE[head]
    if (spec === undefined) { off += raw.length + 1; continue }
    const tok = /[^ \t]+/g
    let t: RegExpExecArray | null
    let posIdx = 0
    let posAlive = true
    while ((t = tok.exec(rest)) !== null) {
      const w = t[0]
      const colon = w.indexOf(':')
      if (colon > 0 && WORD_RE.test(w.slice(0, colon))) {
        // named arg — value either attached (`mode:hp`) or the next token (`mode: hp`)
        const key = w.slice(0, colon)
        let value = w.slice(colon + 1)
        let vFrom = restOff + t.index + colon + 1
        if (value === '') {
          const nx = tok.exec(rest)
          if (nx === null) break
          value = nx[0]
          vFrom = restOff + nx.index
        }
        let values = spec.named?.[key]
        if (values === undefined || !WORD_RE.test(value)) continue
        if (head === 'wavetable' && key === 'table') values = tableValues
        out.push({ from: vFrom, to: vFrom + value.length, word: value, values })
        continue
      }
      if (!posAlive) continue
      if (!ATOM_RE.test(w)) { posAlive = false; continue } // expression — stop counting slots
      const values = spec.pos?.[posIdx]
      posIdx++
      if (values == null || !WORD_RE.test(w)) continue
      out.push({ from: restOff + t.index, to: restOff + t.index + w.length, word: w, values })
    }
    off += raw.length + 1
  }
  return out
}

/** The tap edit at `pos`: the enclosing enum word advances to the next legal
 *  value (wrapping; an unknown/misspelled current value cycles to the list
 *  head). Null when `pos` is not on a cyclable enum word. Pure — the enum
 *  cycler's whole brain, like cycleScaleEdit. */
export function cycleEnumEdit(text: string, pos: number): { from: number; to: number; insert: string } | null {
  const span = scanEnumSpans(text).find((s) => pos >= s.from && pos <= s.to)
  if (span === undefined) return null
  const i = span.values.indexOf(span.word)
  const next = span.values[(i + 1) % span.values.length]!
  return { from: span.from, to: span.to, insert: next }
}
