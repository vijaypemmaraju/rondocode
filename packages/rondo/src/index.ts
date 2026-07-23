/* @rondocode/rondo — a terse, mobile-native music language that transpiles to
 * rondocode DSL source (which the existing engine runs unchanged).
 *
 *   import { compile } from '@rondocode/rondo'
 *   const out = compile(rondoSource)        // { ok, code, errors }
 *   if (out.ok) evalCode(out.code, baseScope)
 */

export { compile } from './compile'
export type { CompileResult } from './compile'
export type { Program, TopItem, SynthBlock, PlayBlock, Expr, RondoError } from './ast'
