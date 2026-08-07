/* ------------------------------------------------------------------------- *
 * THE OUTLINE: what is in this document, and where.
 *
 * A real arrangement here is 472 lines with 8 synths, 5 sections and 23 play
 * blocks, and the only ways to move around it were scrolling, folding and
 * Cmd-F. None of those answer "what is in this file" — you have to already
 * know what you are looking for to look for it.
 *
 * Both languages, because both have the same problem. Rondo's structure is
 * its block headers; the JS DSL's is its top-level `const NAME = synth(` and
 * `p('NAME', …)` calls. Neither needs a parse: these are line shapes, and a
 * regex that is wrong about one line costs a wrong jump, not a broken
 * document — which is why this is a scan and not a dependency on the compiler.
 * ------------------------------------------------------------------------- */

/** What kind of thing an outline row points at — also its sort/grouping key. */
export type OutlineKind = 'synth' | 'section' | 'play' | 'pattern' | 'bus' | 'song'

export interface OutlineItem {
  kind: OutlineKind
  /** the name as written */
  name: string
  /** 1-based line, for the jump */
  line: number
  /** document offset of the line's first non-space character */
  from: number
  /** a section's plays are nested under it */
  depth: number
}

/** Strip a trailing comment the way the lexer does, so `play lead # todo`
 *  does not name the synth "lead # todo". */
const stripComment = (s: string): string => {
  const m = /(^|\s)#/.exec(s)
  return m === null ? s : s.slice(0, m.index + (m[1] ? m[1].length : 0))
}

const RONDO = [
  { re: /^synth[ \t]+([A-Za-z_]\w*)/, kind: 'synth' as const },
  { re: /^section[ \t]+([A-Za-z_]\w*)/, kind: 'section' as const },
  { re: /^play[ \t]+([A-Za-z_]\w*)/, kind: 'play' as const },
  { re: /^beat[ \t]*([A-Za-z_]\w*)?/, kind: 'play' as const },
  { re: /^patdef[ \t]+([A-Za-z_]\w*)/, kind: 'pattern' as const },
  { re: /^bus[ \t]+([A-Za-z_]\w*)/, kind: 'bus' as const },
  { re: /^song\b/, kind: 'song' as const },
]

const JS = [
  { re: /^const[ \t]+([A-Za-z_$][\w$]*)[ \t]*=[ \t]*synth\b/, kind: 'synth' as const },
  { re: /^p\([ \t]*['"]([^'"]+)['"]/, kind: 'play' as const },
  { re: /^bus\([ \t]*['"]([^'"]+)['"]/, kind: 'bus' as const },
]

/**
 * Everything worth jumping to in `doc`.
 *
 * A rondo `play` inside a `section` is nested under it (depth 1), which is
 * what makes the list read as the arrangement rather than as a flat pile —
 * the nesting IS the information at 23 play blocks.
 */
export function outlineOf(doc: string, lang: 'rondo' | 'rondocode'): OutlineItem[] {
  const rules = lang === 'rondo' ? RONDO : JS
  const out: OutlineItem[] = []
  let at = 0
  let inSection = false
  for (const [i, raw] of doc.split('\n').entries()) {
    const indent = raw.length - raw.trimStart().length
    const text = stripComment(raw).trim()
    // The JS DSL's declarations are TOP-LEVEL by definition: `p(...)` and
    // `const x = synth(...)` at column 0. An indented one is inside something
    // else — a callback, a block — and is not a place to jump to. Rondo
    // indents on purpose, so it is judged on shape instead.
    const eligible = lang === 'rondo' || indent === 0
    if (text !== '' && eligible) {
      for (const { re, kind } of rules) {
        const m = re.exec(text)
        if (m === null) continue
        // a rondo section owns the deeper-indented blocks under it
        if (lang === 'rondo') {
          if (kind === 'section') inSection = true
          else if (indent === 0 && kind !== 'play') inSection = false
        }
        out.push({
          kind,
          name: m[1] ?? (kind === 'song' ? text : 'beat'),
          line: i + 1,
          from: at + indent,
          depth: lang === 'rondo' && inSection && kind === 'play' ? 1 : 0,
        })
        break
      }
    }
    at += raw.length + 1
  }
  return out
}

/** Rows matching `query`, case-insensitively, on the name or the kind. An
 *  empty query keeps everything — the list is the point, filtering is the
 *  refinement. */
export function filterOutline(items: readonly OutlineItem[], query: string): OutlineItem[] {
  const q = query.trim().toLowerCase()
  if (q === '') return [...items]
  return items.filter((it) => it.name.toLowerCase().includes(q) || it.kind.includes(q))
}
