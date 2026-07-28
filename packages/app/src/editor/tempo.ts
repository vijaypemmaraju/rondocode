import { bpmToCps, cpsToBpm } from '@rondocode/pattern'
import { verifiedChanges } from './rondo/gesture'
import type { WriteHost } from './rondo/gesture'
import { tooltip } from '../ui/tooltip'
import type { EditorLang } from './editor'

/* ------------------------------------------------------------------------- *
 * The header tempo readout: BPM as the face, cps as the truth underneath.
 *
 * The engine only knows cycles per second, and one cycle is one BAR of 4/4
 * everywhere in this codebase (mini-notation, the scheduler, MIDI import and
 * export) — so a BPM is exactly `cps * 60 * 4`, the conversion that lives in
 * @rondocode/pattern and is shared with the MIDI helpers. Nothing here does
 * that arithmetic itself.
 *
 * Editing rule: THE DOCUMENT IS THE SOURCE OF TRUTH. Typing a BPM rewrites the
 * number in the doc's tempo line, in the unit that line already uses (a
 * `bpm 128` line stays BPM, a `cps .5333` line stays cps) — the same
 * write-verify discipline the inline widgets use, so a concurrent edit drops
 * the write instead of splicing over it. A document with no tempo line has
 * nothing to rewrite, so the value applies to this session only, and the
 * readout says so.
 * ------------------------------------------------------------------------- */

/** The tempo number found in a document: the literal's range, its text (for
 *  write-verify) and the unit of the line that holds it. */
export interface TempoSite {
  unit: 'cps' | 'bpm'
  /** the number AS WRITTEN, in `unit` (not normalized). */
  value: number
  /** char range of the number literal alone. */
  from: number
  to: number
  /** the literal's exact text — what a write must still find there. */
  text: string
}

/** rondo: a top-level `cps .5333` / `bpm 128` line (indent 0, per the grammar). */
const RONDO_RE = /^(cps|bpm)([ \t]+)(-?(?:\d+\.?\d*|\.\d+))/
/** rondocode (JS): a `setCps(0.5333)` / `setBpm(128)` call with a literal. */
const JS_RE = /\bset(Cps|Bpm)\([ \t]*(-?(?:\d+\.?\d*|\.\d+))[ \t]*\)/g

/** Find the tempo line the running program actually obeys: the LAST one in the
 *  document, because both languages stage tempo in source order and the last
 *  call wins. Returns null when the document sets no tempo (and for a line
 *  whose tempo is an expression rather than a literal — there is no single
 *  number to rewrite). Comment text is skipped in both languages. */
export function findTempoSite(doc: string, lang: EditorLang): TempoSite | null {
  let found: TempoSite | null = null
  let offset = 0
  for (const raw of doc.split('\n')) {
    const line = stripComment(raw, lang)
    if (lang === 'rondo') {
      const m = RONDO_RE.exec(line)
      if (m) {
        const from = offset + m[1]!.length + m[2]!.length
        found = { unit: m[1] as 'cps' | 'bpm', value: Number(m[3]), from, to: from + m[3]!.length, text: m[3]! }
      }
    } else {
      JS_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = JS_RE.exec(line)) !== null) {
        const from = offset + m.index + m[0]!.indexOf(m[2]!)
        found = {
          unit: m[1] === 'Bpm' ? 'bpm' : 'cps',
          value: Number(m[2]),
          from,
          to: from + m[2]!.length,
          text: m[2]!,
        }
      }
    }
    offset += raw.length + 1
  }
  return found
}

/** Blank out the comment tail so a commented-out tempo line is never rewritten
 *  (blanks, not truncation: offsets must stay honest). */
function stripComment(line: string, lang: EditorLang): string {
  const i = lang === 'rondo' ? line.indexOf('#') : line.indexOf('//')
  return i < 0 ? line : line.slice(0, i)
}

/** The tempo a document asks for, in cps, or null when it sets none. */
export function docCps(doc: string, lang: EditorLang): number | null {
  const site = findTempoSite(doc, lang)
  if (site === null || !Number.isFinite(site.value)) return null
  return site.unit === 'bpm' ? bpmToCps(site.value) : site.value
}

/** The cps window the engine accepts (clampCps in evalCode) as BPM. */
export const MIN_BPM = cpsToBpm(0.05)
export const MAX_BPM = cpsToBpm(4)

/** Trim a number for DISPLAY: one decimal, and only when it earns its place
 *  (128, not 128.0; 127.5 keeps its half). */
export const showBpm = (bpm: number): string => String(Math.round(bpm * 10) / 10)

/** Trim a number for the DOCUMENT. cps gets 4 decimals, the same precision the
 *  MIDI importer writes, and keeps the line's leading-dot style if it had one
 *  (`.5333` stays `.5333`); BPM keeps up to 2 decimals. */
export function writeNum(value: number, unit: 'cps' | 'bpm', like: string): string {
  const fixed = unit === 'cps' ? value.toFixed(4) : value.toFixed(2)
  let out = fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed
  if (/^-?\./.test(like)) out = out.replace(/^(-?)0\./, '$1.') // `.5333`, not `0.5333`
  return out
}

/** cps for the secondary readout: enough decimals to be the real number, no
 *  trailing zeros (0.5, 0.5333). */
const trimCps = (cps: number): string => String(Math.round(cps * 10000) / 10000)

/** The verified change that sets this document's tempo to `bpm`, or null when
 *  the document has no tempo line to rewrite. The UNIT never changes: a cps
 *  line gets the converted cps, a bpm line gets the BPM as typed. */
export function tempoEdit(
  doc: string,
  lang: EditorLang,
  bpm: number,
): { from: number; to: number; expected: string; insert: string } | null {
  const site = findTempoSite(doc, lang)
  if (site === null) return null
  const value = site.unit === 'bpm' ? bpm : bpmToCps(bpm)
  return { from: site.from, to: site.to, expected: site.text, insert: writeNum(value, site.unit, site.text) }
}

export interface TempoOpts {
  /** the editor view — doc reads and the verified write both go through it. */
  view: WriteHost & { state: { doc: { toString(): string } } }
  getLang: () => EditorLang
  /** re-eval after a doc rewrite (the widgets' path). */
  requestEval: (immediate: boolean) => void
  /** apply a tempo the document does not carry, to the live session only. */
  setSessionCps: (cps: number) => void
  /** the tempo currently sounding, for the fallback readout. */
  getSessionCps: () => number
}

export interface TempoHandle {
  /** the header element to place in the controls cluster. */
  el: HTMLElement
  /** re-read the doc / session and repaint (call on doc + state changes). */
  refresh: () => void
}

/** Mount the BPM control. The field edits BPM; the line under it shows the cps
 *  the engine runs on, so the mapping is learnable instead of hidden. */
export function mountTempo(opts: TempoOpts): TempoHandle {
  const root = document.createElement('div')
  root.className = 'tempo'
  const field = document.createElement('input')
  field.className = 'tempo-input'
  field.type = 'text'
  field.inputMode = 'decimal'
  field.autocomplete = 'off'
  field.spellcheck = false
  field.setAttribute('aria-label', 'tempo in BPM')
  const unit = document.createElement('span')
  unit.className = 'tempo-unit'
  unit.textContent = 'bpm'
  const sub = document.createElement('span')
  sub.className = 'tempo-cps'
  root.append(field, unit, sub)

  const currentCps = (): number => docCps(opts.view.state.doc.toString(), opts.getLang()) ?? opts.getSessionCps()

  const refresh = (): void => {
    const cps = currentCps()
    const inDoc = docCps(opts.view.state.doc.toString(), opts.getLang()) !== null
    // never fight the hands that are typing in the field
    if (document.activeElement !== field) field.value = showBpm(cpsToBpm(cps))
    sub.textContent = inDoc ? `${trimCps(cps)} cps` : `${trimCps(cps)} cps, this run only`
    tooltip(
      root,
      inDoc
        ? 'tempo in bpm: 4 beats to the bar, one bar per cycle. Typing rewrites the tempo line in your code.'
        : 'tempo in bpm: 4 beats to the bar, one bar per cycle. Your code sets no tempo, so this applies to the current run only. Add a tempo line to keep it.',
    )
  }

  const commit = (): void => {
    const typed = Number(field.value.trim())
    if (!Number.isFinite(typed) || typed <= 0) {
      refresh() // unreadable input: snap back to what is actually playing
      return
    }
    const bpm = Math.min(MAX_BPM, Math.max(MIN_BPM, typed))
    const doc = opts.view.state.doc.toString()
    const edit = tempoEdit(doc, opts.getLang(), bpm)
    if (edit === null) {
      opts.setSessionCps(bpmToCps(bpm))
      refresh()
      return
    }
    // write-verify: if the line moved under us, drop the write and resync
    if (verifiedChanges(opts.view, [edit])) opts.requestEval(true)
    refresh()
  }

  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      field.blur() // commits, and hands the keyboard back on a phone
    } else if (e.key === 'Escape') {
      e.preventDefault()
      field.value = showBpm(cpsToBpm(currentCps()))
      field.blur()
    }
  })
  field.addEventListener('blur', commit)
  // selecting on focus makes the whole value replaceable with one thumb tap
  field.addEventListener('focus', () => field.select())

  refresh()
  return { el: root, refresh }
}
