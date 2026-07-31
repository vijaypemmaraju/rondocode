/* Tiny syntax highlighters shared by the docs page and the synth library, one
 * per language. Comments, strings, numbers and vocabulary keywords. The
 * comment alternative comes first so strings inside a comment are not matched
 * separately.
 *
 * The rondo word lists are IMPORTED, never restated — see rondo/words.ts. */

import { BUILTINS, KEYWORDS as RONDO_KEYWORDS, MODIFIERS as RONDO_MODIFIERS } from '../editor/rondo/words'

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const KEYWORDS = new Set([
  'synth', 'const', 'return', 'p', 'note', 'n', 'chord', 'sound', 's', 'stack', 'cat',
  'fastcat', 'timecat', 'setCps', 'setBpm', 'mini', 'm', 'arrange', 'silence',
])

export const highlightDsl = (src: string): string => {
  const re = /(\/\/[^\n]*)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")|(\b\d+\.?\d*\b)|([A-Za-z_$][\w$]*)/g
  let out = ''
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    out += escapeHtml(src.slice(last, m.index))
    if (m[1] !== undefined) out += `<span class="tok-com">${escapeHtml(m[1])}</span>`
    else if (m[2] !== undefined) out += `<span class="tok-str">${escapeHtml(m[2])}</span>`
    else if (m[3] !== undefined) out += `<span class="tok-num">${escapeHtml(m[3])}</span>`
    else if (m[4] !== undefined) out += KEYWORDS.has(m[4]) ? `<span class="tok-kw">${escapeHtml(m[4])}</span>` : escapeHtml(m[4])
    last = m.index + m[0].length
  }
  out += escapeHtml(src.slice(last))
  return out
}

/** rondo's highlighter. Different in three ways that matter: comments start
 *  with `#`, notation is bare rather than quoted (so there are no strings to
 *  find), and the vocabulary is rondo's own — block keywords and pattern
 *  modifiers, both read from the single list the editor's tokenizer uses. */
export const highlightRondo = (src: string): string => {
  const re = /(#[^\n]*)|(\b-?\d+\.?\d*\b)|([A-Za-z_][\w]*)/g
  let out = ''
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    out += escapeHtml(src.slice(last, m.index))
    if (m[1] !== undefined) out += `<span class="tok-com">${escapeHtml(m[1])}</span>`
    else if (m[2] !== undefined) out += `<span class="tok-num">${escapeHtml(m[2])}</span>`
    else {
      const w = m[3]!
      // the same three-way split the editor's tokenizer makes (kw / builtin /
      // mod), collapsed to two colours: block words and modifiers both frame
      // the music, builtins are the things that make sound
      const cls = RONDO_KEYWORDS.has(w) || RONDO_MODIFIERS.has(w)
        ? 'tok-kw'
        : BUILTINS.has(w) ? 'tok-fn' : null
      out += cls === null ? escapeHtml(w) : `<span class="${cls}">${escapeHtml(w)}</span>`
    }
    last = m.index + m[0].length
  }
  out += escapeHtml(src.slice(last))
  return out
}

/** The highlighter for a language, so callers pick by lang rather than by
 *  remembering which function is which. */
export const highlightFor = (lang: string): ((src: string) => string) =>
  lang === 'rondo' ? highlightRondo : highlightDsl
