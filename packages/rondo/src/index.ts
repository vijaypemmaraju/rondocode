/* @rondocode/rondo — a terse, mobile-native music language that transpiles to
 * rondocode DSL source (which the existing engine runs unchanged).
 *
 *   import { compile } from '@rondocode/rondo'
 *   const out = compile(rondoSource)        // { ok, code, errors }
 *   if (out.ok) evalCode(out.code, baseScope)
 */

export { compile } from './compile'
export { formatRondo, formatRondoLine } from './format'
export { expandScale, splitBeatVelocities } from './codegen'
export { decompile } from './decompile'
export { BUILTINS, RESERVED_TOP_LEVEL } from './builtins'
export type { BuiltinSpec, PosKind, NamedKind } from './builtins'
export type { CompileResult, NoteSpan, JsRegion, PulseSpan, Arrangement, SongSlot } from './compile'
export { isComposablePatDefName } from './codegen'
export type { Program, TopItem, SynthBlock, PlayBlock, Expr, RondoError } from './ast'
export { stripComment, scanBalanced } from './lexer'
export { KNOWN_CTX, MASK_DRAW_INPUTS } from './codegen'
export { BLOCK_KEYWORDS, STATEMENT_KEYWORDS, VOICE_FLAGS, VOICE_OPTS, EQ_BAND_TYPES as RONDO_EQ_BAND_TYPES } from './parser'
