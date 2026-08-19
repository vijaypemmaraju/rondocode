/* ------------------------------------------------------------------------- *
 * Putting an eval diagnostic back on the rondo line it came from.
 *
 * In rondo the thing that runs is transpiled JavaScript, so every diagnostic
 * the eval produces carries a position in a file the musician never sees. They
 * used to be dropped from the buffer entirely and printed as a line of text
 * under the editor: an unknown `.ctrl` param, a note longer than its own step,
 * a chord sent to a mono synth, a staging target that does not exist, any
 * runtime throw -- all of them messages with no place, in a language whose
 * whole pitch is that you can see what you are editing.
 *
 * The compiler now reports which rondo line each generated line came from, and
 * this is the other half of that.
 * ------------------------------------------------------------------------- */

import type { Diagnostic } from '../session/evalCode'

/**
 * Move `d` onto the rondo line it came from, or return null when nothing in
 * the buffer stands for it.
 *
 * The map is BLOCK-level (see codegen's CodegenOut), so the result points at
 * the block header and covers that whole line. Columns are DROPPED rather than
 * carried across: a column into generated JavaScript means nothing in a rondo
 * line of a different length, and a squiggle under a plausible-looking wrong
 * word is worse than one under the right block.
 *
 * NULL, not a guess. A position-less diagnostic, a line past the generated
 * code, or a line the map attributes to nothing (the blank between statements)
 * has genuinely nowhere to point, and those keep going to the status strip --
 * which is what the whole buffer used to do.
 */
export const mapToRondo = (d: Diagnostic, lineMap: readonly number[]): Diagnostic | null => {
  if (lineMap.length === 0) return null
  const src = lineMap[d.line - 1]
  if (src === undefined || src === 0) return null
  // col 1 -> end of line: toCmDiagnostics clamps endCol to the line, so a large
  // number means "all of it" without needing the document here
  return { ...d, line: src, col: 1, endLine: src, endCol: Number.MAX_SAFE_INTEGER }
}
