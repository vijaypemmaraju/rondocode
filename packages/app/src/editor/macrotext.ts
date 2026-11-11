/* ------------------------------------------------------------------------- *
 * Where a project macro's default is WRITTEN, in either language:
 *
 *   rondo        macro energy .35 0..1
 *   rondocode    macro('energy', 0.35, { min: 0, max: 1 })
 *
 * An eased set_macro moves the sound; the editor rewrites this number as it
 * goes, so the dial on screen follows and the next eval finds the value the
 * sound is already at. Pure, so the matching is testable without an editor.
 * ------------------------------------------------------------------------- */

export interface MacroNumber {
  /** Document offsets of the number itself. */
  from: number
  to: number
  value: number
}

const NUMBER = '(-?(?:\\d+\\.?\\d*|\\.\\d+))'
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Find the default of the macro called `name`, or undefined when the text
 *  declares no such macro. The name must match whole: `energy` does not find
 *  `energy2`, and a macro mentioned in a comment is not a declaration. */
export function findMacroNumber(doc: string, name: string, lang: 'rondo' | 'rondocode'): MacroNumber | undefined {
  const n = escapeRe(name)
  const re = lang === 'rondo'
    ? new RegExp(`^(macro[ \\t]+${n}[ \\t]+)${NUMBER}`, 'm')
    : new RegExp(`(\\bmacro\\(\\s*['"]${n}['"]\\s*,\\s*)${NUMBER}`)
  const m = re.exec(doc)
  if (m === null) return undefined
  const from = m.index + m[1]!.length
  return { from, to: from + m[2]!.length, value: Number(m[2]) }
}

/** The text a macro value is written as: three decimals at most, so a ramp
 *  does not fill the buffer with float noise. */
export function formatMacroNumber(value: number): string {
  return String(Math.round(value * 1000) / 1000)
}
