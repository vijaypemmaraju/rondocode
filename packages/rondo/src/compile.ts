/* rondo compiler entry: source → rondocode DSL text (or errors). */

import type { RondoError } from './ast'
import { parse } from './parser'
import { codegen } from './codegen'

/** A notation string + where it lives in the rondo source. The editor uses
 *  these to map play-events back onto the buffer for note-play highlighting:
 *  a mini-notation Loc is an offset into `content`, and `content` sits at
 *  `[from, from + content.length)` in the source. */
export interface NoteSpan {
  content: string
  from: number
}

export type CompileResult =
  | { ok: true; code: string; notes: NoteSpan[]; errors: [] }
  | { ok: false; code: null; notes: []; errors: RondoError[] }

/** Compile rondo source into a rondocode DSL source string. On any lex/parse/
 *  codegen error, returns `{ ok: false }` with positioned diagnostics. */
export function compile(src: string): CompileResult {
  const { program, errors } = parse(src)
  if (errors.length > 0) return { ok: false, code: null, notes: [], errors }
  const code = codegen(program, errors)
  if (errors.length > 0) return { ok: false, code: null, notes: [], errors }
  const notes: NoteSpan[] = program.items
    .filter((it): it is Extract<typeof it, { t: 'play' }> => it.t === 'play')
    .filter((p) => p.notation.length > 0)
    .map((p) => ({ content: p.notation, from: p.notationFrom }))
  return { ok: true, code, notes, errors: [] }
}
