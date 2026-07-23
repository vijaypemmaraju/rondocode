/* rondo compiler entry: source → rondocode DSL text (or errors). */

import type { RondoError } from './ast'
import { parse } from './parser'
import { codegen } from './codegen'

export type CompileResult =
  | { ok: true; code: string; errors: [] }
  | { ok: false; code: null; errors: RondoError[] }

/** Compile rondo source into a rondocode DSL source string. On any lex/parse/
 *  codegen error, returns `{ ok: false }` with positioned diagnostics. */
export function compile(src: string): CompileResult {
  const { program, errors } = parse(src)
  if (errors.length > 0) return { ok: false, code: null, errors }
  const code = codegen(program, errors)
  if (errors.length > 0) return { ok: false, code: null, errors }
  return { ok: true, code, errors: [] }
}
