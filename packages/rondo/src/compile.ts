/* rondo compiler entry: source → rondocode DSL text (or errors). */

import type { RondoError } from './ast'
import { parse } from './parser'
import { codegen } from './codegen'

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

export type CompileResult =
  | { ok: true; code: string; notes: NoteSpan[]; jsRegions: JsRegion[]; errors: [] }
  | { ok: false; code: null; notes: []; jsRegions: []; errors: RondoError[] }

/** Compile rondo source into a rondocode DSL source string. On any lex/parse/
 *  codegen error, returns `{ ok: false }` with positioned diagnostics. */
export function compile(src: string): CompileResult {
  const { program, errors, jsRegions } = parse(src)
  if (errors.length > 0) return { ok: false, code: null, notes: [], jsRegions: [], errors }
  const code = codegen(program, errors)
  if (errors.length > 0) return { ok: false, code: null, notes: [], jsRegions: [], errors }
  const notes: NoteSpan[] = program.items
    .flatMap((it) => (it.t === 'play' ? [it] : it.t === 'section' ? it.plays : []))
    .flatMap((p) => {
      // beat lines may carry `word:v` suffixes the emitted mini won't have
      const span = p.entry === 'sound' ? beatSpan : (content: string, from: number): NoteSpan => ({ content, from })
      return [
        span(p.notation, p.notationFrom),
        ...(p.voices ?? []).map((v) => span(v.notation, v.notationFrom)),
      ]
    })
    .filter((s) => s.content.length > 0)
  return { ok: true, code, notes, jsRegions, errors: [] }
}
