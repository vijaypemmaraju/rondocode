/* Go-to-definition resolution for RONDO documents - the pure brain behind
 * Cmd/Ctrl-click in rondo mode (gotodef.ts owns the pointer plumbing; it
 * calls this when the buffer's syntax tree is not JavaScript).
 *
 * What a name can resolve to, in priority order:
 *   1. a BINDING (`name = ...`) inside the enclosing synth/post block
 *   2. a `synth name` header (play/beat words, sidechain refs, send targets)
 *   3. a `section name` header (song line refs)
 *   4. a `wavedef name` / `scaledef name` definition (table:/scale: refs)
 * The definition itself (or an unresolvable builtin) returns null so the
 * click falls through to normal caret placement. */

export interface Range {
  from: number
  to: number
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Offset of `lineIdx`'s first char in `doc`. */
const lineStart = (lines: string[], lineIdx: number): number => {
  let off = 0
  for (let i = 0; i < lineIdx; i++) off += lines[i]!.length + 1
  return off
}

/** The enclosing indent-0 block header line index, or -1 at top level. */
function enclosingHeader(lines: string[], lineIdx: number): number {
  for (let i = lineIdx; i >= 0; i--) {
    const ln = lines[i]!
    if (ln.trim() === '' && i < lineIdx) continue
    if (/^\S/.test(ln)) return i
  }
  return -1
}

/** Where `name`'s definition lives in a rondo doc, or null. `pos` scopes the
 *  binding search to the enclosing block. Pure. */
export function rondoDefinitionTarget(doc: string, name: string, pos: number): Range | null {
  const n = escapeRe(name)
  const lines = doc.split('\n')
  const lineIdx = doc.slice(0, pos).split('\n').length - 1

  // 1. binding inside the enclosing synth block (incl. its post sub-block)
  const headIdx = enclosingHeader(lines, lineIdx)
  if (headIdx >= 0 && /^synth\b/.test(lines[headIdx]!)) {
    const bindRe = new RegExp(`^[ \\t]+(${n})[ \\t]*=`)
    for (let i = headIdx + 1; i < lines.length; i++) {
      const ln = lines[i]!
      if (ln.trim() !== '' && /^\S/.test(ln)) break // left the block
      const m = bindRe.exec(ln)
      if (m !== null) {
        const from = lineStart(lines, i) + ln.indexOf(name)
        return { from, to: from + name.length }
      }
    }
  }

  // 2-4. top-level definitions, in reference-likelihood order
  const headers = [
    new RegExp(`^synth[ \\t]+(${n})\\b`),
    new RegExp(`^section[ \\t]+(${n})\\b`),
    new RegExp(`^(?:wavedef|scaledef)[ \\t]+(${n})\\b`),
  ]
  for (const re of headers) {
    for (let i = 0; i < lines.length; i++) {
      const m = re.exec(lines[i]!)
      if (m !== null) {
        const from = lineStart(lines, i) + lines[i]!.indexOf(name, m[0].indexOf(name))
        return { from, to: from + name.length }
      }
    }
  }
  return null
}
