/* rondo compiler entry: source → rondocode DSL text (or errors). */

import type { Comb, RondoError } from './ast'
import { parse } from './parser'
import { codegen, scaleArg } from './codegen'

/** A notation string + where it lives in the rondo source. The editor uses
 *  these to map play-events back onto the buffer for note-play highlighting:
 *  a mini-notation Loc is an offset into `content`, and `content` sits at
 *  `[from, from + content.length)` in the source — UNLESS `pieces` is set:
 *  a beat line with `word:v` velocity suffixes compiles to a STRIPPED mini
 *  string, so `content` (what events' loc.src equals) no longer matches the
 *  buffer 1:1 and each piece maps a chunk of it back to its source offset. */
export interface NoteSpan {
  content: string
  from: number
  pieces?: { assembledStart: number; sourceStart: number; length: number }[]
  /** Spans that STAND FOR part of the content: a patdef reference, which has
   *  no notes of its own but should light when the notes it expands to play. */
  refs?: { from: number; to: number; assembledStart: number; assembledEnd: number }[]
}

/** Span for a beat notation line: velocity suffixes (`hat:.6`) are stripped
 *  from the emitted mini string, so the span's content is the STRIPPED text
 *  and pieces map its chunks back to the buffer around each removed `:v`. */
function beatSpan(notation: string, from: number): NoteSpan {
  const re = /([a-zA-Z_]\w*):(\d*\.?\d+)/g
  const pieces: { assembledStart: number; sourceStart: number; length: number }[] = []
  let stripped = ''
  let orig = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(notation)) !== null) {
    const keepEnd = m.index + m[1]!.length // keep the word…
    if (keepEnd > orig) {
      pieces.push({ assembledStart: stripped.length, sourceStart: from + orig, length: keepEnd - orig })
      stripped += notation.slice(orig, keepEnd)
    }
    orig = m.index + m[0].length // …drop the `:v`
  }
  if (pieces.length === 0) return { content: notation, from } // no suffixes
  if (orig < notation.length) {
    pieces.push({ assembledStart: stripped.length, sourceStart: from + orig, length: notation.length - orig })
    stripped += notation.slice(orig)
  }
  return { content: stripped, from, pieces }
}

/** A js{ … } / js-block region in the rondo source. The editor scans these
 *  slices for mini-notation string literals so note-flash works inside
 *  escape hatches too — the raw JS sits VERBATIM in the buffer, so literal
 *  offsets found in a slice map straight back to it. */
export interface JsRegion {
  from: number
  to: number
}

/** A notation line whose pattern has NO mini locs (`irand N seg:M` builds
 *  from a signal) — the editor PULSES the whole line on each of the
 *  channel's notes instead of flashing per atom. */
export interface PulseSpan {
  from: number
  to: number
  sound: string
}

export type CompileResult =
  | { ok: true; code: string; lineMap: number[]; notes: NoteSpan[]; jsRegions: JsRegion[]; pulses: PulseSpan[]; errors: [] }
  | { ok: false; code: null; lineMap: []; notes: []; jsRegions: []; pulses: []; errors: RondoError[] }

/** Compile rondo source into a rondocode DSL source string. On any lex/parse/
 *  codegen error, returns `{ ok: false }` with positioned diagnostics. */
export function compile(src: string): CompileResult {
  const { program, errors, jsRegions } = parse(src)
  if (errors.length > 0) return { ok: false, code: null, lineMap: [], notes: [], jsRegions: [], pulses: [], errors }
  const { code, lineMap } = codegen(program, errors)
  if (errors.length > 0) return { ok: false, code: null, lineMap: [], notes: [], jsRegions: [], pulses: [], errors }
  const notes: NoteSpan[] = program.items
    .flatMap((it) => (it.t === 'play' ? [it] : it.t === 'section' ? it.plays : []))
    .flatMap((p) => {
      // beat lines may carry `word:v` suffixes the emitted mini won't have
      const span = p.entry === 'sound' ? beatSpan : (content: string, from: number): NoteSpan => ({ content, from })
      // an ASSEMBLED notation (patdefs composed into one figure) exists nowhere
      // in the buffer as a single run, so it carries its own chunk map
      const one = (v: {
        notation: string
        notationFrom: number
        notationPieces?: NoteSpan['pieces']
        notationRefs?: NoteSpan['refs']
      }): NoteSpan => {
        const base =
          v.notationPieces === undefined
            ? span(v.notation, v.notationFrom)
            : { content: v.notation, from: v.notationFrom, pieces: v.notationPieces }
        return v.notationRefs === undefined || v.notationRefs.length === 0 ? base : { ...base, refs: v.notationRefs }
      }
      /* MODIFIER lines are notation too. `dur: <1 .5>` is mini-notation the
       * reader wrote and watches, and it stayed dark while the notes beside it
       * lit up, because nothing ever told the editor those spans existed. The
       * pattern layer carries their locs (ControlMap.locs); this is the other
       * half. */
      /* A COMBINATOR's mini-looking argument is notation too: `chop [1 2 4]`,
       * `fast <2 4>`, `every <2 4>: rev`. cgComb emits every non-numeric
       * argument as a quoted string verbatim, and the pattern layer threads
       * each count atom's loc into the events it shaped -- this span is the
       * other half, exactly like the ctrl/method case below. Numeric args
       * emit as bare numbers (nothing at runtime references their source),
       * so they carry no span. */
      const NUMERIC_ARG = /^-?\d*\.?\d+$/
      const combSpans = (c: Comb): NoteSpan[] =>
        c.args.flatMap((arg, i) => {
          const from = c.argFroms?.[i]
          return from !== undefined && !NUMERIC_ARG.test(arg) ? [{ content: arg, from }] : []
        })
      const modSpans: NoteSpan[] = p.mods.flatMap((m) => {
        if (m.kind === 'comb') return combSpans(m.comb)
        if (m.kind === 'fncomb') {
          return [
            ...m.pre.flatMap((a, i) => {
              const from = m.preFroms?.[i]
              return typeof a === 'string' && from !== undefined ? [{ content: a, from }] : []
            }),
            ...combSpans(m.comb),
          ]
        }
        if (m.kind !== 'ctrl' && m.kind !== 'method') return []
        const v = m.value
        return v.kind === 'mini' && v.from !== undefined
          ? [{ content: v.text, from: v.from }]
          : []
      })
      /* A PATTERNED scale is notation too. The emitted text differs from the
       * buffer only by `-` -> `_`, which is length-preserving on purpose (see
       * scaleArg), so the offsets still land on the right characters. */
      const scaleSpans: NoteSpan[] = p.scale !== undefined && p.scaleFrom !== undefined
        ? [{ content: scaleArg(p.scale), from: p.scaleFrom }]
        : []
      return [one(p), ...(p.voices ?? []).map(one), ...modSpans, ...scaleSpans]
    })
    .filter((s) => s.content.length > 0)
  // irand notation lines produce loc-less events — pulse the whole line
  const pulses: PulseSpan[] = program.items
    .flatMap((it) => (it.t === 'play' ? [it] : it.t === 'section' ? it.plays : []))
    .flatMap((p) => [
      { notation: p.notation, from: p.notationFrom, sound: p.name },
      ...(p.voices ?? []).map((v) => ({ notation: v.notation, from: v.notationFrom, sound: p.name })),
    ])
    .filter((l) => /^irand\b/.test(l.notation))
    .map((l) => ({ from: l.from, to: l.from + l.notation.length, sound: l.sound }))
  return { ok: true, code, lineMap, notes, jsRegions, pulses, errors: [] }
}
