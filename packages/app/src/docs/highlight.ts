/* Tiny DSL syntax highlighter shared by the docs page and the synth library.
 * Highlights comments, strings, numbers, and vocabulary keywords. Comment
 * alternative comes first so strings inside `//` are not matched separately. */

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const KEYWORDS = new Set([
  'synth', 'const', 'return', 'p', 'note', 'n', 'chord', 'sound', 's', 'stack', 'cat',
  'fastcat', 'timecat', 'setCps', 'mini', 'm', 'arrange', 'silence',
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
