import { bpmToCps, cpsToBpm, quartersPerBar, DEFAULT_TIME_SIG } from '@rondocode/pattern'
import type { TimeSig } from '@rondocode/pattern'
import { verifiedChanges } from './rondo/gesture'
import type { WriteHost } from './rondo/gesture'
import { tooltip } from '../ui/tooltip'
import type { EditorLang } from './editor'

/* ------------------------------------------------------------------------- *
 * The header tempo readout: BPM as the face, cps as the truth underneath.
 *
 * The engine only knows cycles per second, and one cycle is one BAR everywhere
 * in this codebase (mini-notation, the scheduler, MIDI import and export) — so
 * a BPM is `cps * 60 * quartersPerBar`, the conversion that lives in
 * @rondocode/pattern and is shared with the MIDI helpers. Nothing here does
 * that arithmetic itself.
 *
 * The bar's length comes from the document's own `timesig` line, not from the
 * session: this readout has to describe what the code WILL do when it runs,
 * exactly as docCps does for the tempo. In 3/4 a bar is three quarters, so the
 * same 120 bpm is 0.667 cps rather than 0.5.
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

/** rondo: a top-level `timesig 3 4` line. */
const RONDO_SIG_RE = /^timesig[ \t]+(\d+)[ \t]+(\d+)\b/
/** rondocode (JS): a `setTimeSig(3, 4)` call with two literals. */
const JS_SIG_RE = /\bsetTimeSig\([ \t]*(\d+)[ \t]*,[ \t]*(\d+)[ \t]*\)/g

/** The meter a document asks for, or 4/4 when it asks for none. Last one wins,
 *  like the tempo line, because both languages stage in source order. A
 *  denominator that is not a power of two is IGNORED here rather than
 *  reported: this is a readout, and the evaluator is what refuses it with a
 *  positioned error. */
export function docTimeSig(doc: string, lang: EditorLang): TimeSig {
  let found: TimeSig = DEFAULT_TIME_SIG
  for (const raw of doc.split('\n')) {
    const line = stripComment(raw, lang)
    if (lang === 'rondo') {
      const m = RONDO_SIG_RE.exec(line)
      if (m) found = { num: Number(m[1]), den: Number(m[2]) }
    } else {
      JS_SIG_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = JS_SIG_RE.exec(line)) !== null) found = { num: Number(m[1]), den: Number(m[2]) }
    }
  }
  const ok = Number.isInteger(found.num) && found.num >= 1 && Number.isInteger(found.den) &&
    found.den >= 1 && (found.den & (found.den - 1)) === 0
  return ok ? found : DEFAULT_TIME_SIG
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
  return site.unit === 'bpm' ? bpmToCps(site.value, quartersPerBar(docTimeSig(doc, lang))) : site.value
}

/** The cps window the engine accepts (clampCps in evalCode), as BPM. Meter
 *  dependent: a 3/4 bar is three quarters, so the same cps ceiling is fewer
 *  beats per minute. */
export const bpmRange = (timeSig: TimeSig = DEFAULT_TIME_SIG): { min: number; max: number } => ({
  min: cpsToBpm(0.05, quartersPerBar(timeSig)),
  max: cpsToBpm(4, quartersPerBar(timeSig)),
})

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
  const value = site.unit === 'bpm' ? bpm : bpmToCps(bpm, quartersPerBar(docTimeSig(doc, lang)))
  return { from: site.from, to: site.to, expected: site.text, insert: writeNum(value, site.unit, site.text) }
}

/** Where the meter is written: ONE range covering both numbers, since they are
 *  rewritten together. null when the document sets no meter. */
export interface TimeSigSite {
  from: number
  to: number
  /** the exact text between from/to — what a write must still find there. */
  text: string
}

/** rondo: `timesig 3 4`, capturing both numbers as one span. */
const RONDO_SIG_SITE_RE = /^timesig[ \t]+(\d+[ \t]+\d+)/
/** rondocode: `setTimeSig(3, 4)`, likewise. */
const JS_SIG_SITE_RE = /\bsetTimeSig\([ \t]*(\d+[ \t]*,[ \t]*\d+)[ \t]*\)/g

/** Find the meter line the running program obeys: the LAST one, like the
 *  tempo line. */
export function findTimeSigSite(doc: string, lang: EditorLang): TimeSigSite | null {
  let found: TimeSigSite | null = null
  let offset = 0
  for (const raw of doc.split('\n')) {
    const line = stripComment(raw, lang)
    if (lang === 'rondo') {
      const m = RONDO_SIG_SITE_RE.exec(line)
      if (m) {
        const from = offset + m[0].length - m[1]!.length
        found = { from, to: from + m[1]!.length, text: m[1]! }
      }
    } else {
      JS_SIG_SITE_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = JS_SIG_SITE_RE.exec(line)) !== null) {
        const from = offset + m.index + m[0].indexOf(m[1]!)
        found = { from, to: from + m[1]!.length, text: m[1]! }
      }
    }
    offset += raw.length + 1
  }
  return found
}

/** The verified change that sets this document's meter, or null when there is
 *  nothing to do.
 *
 *  Two shapes. With a meter line, the numbers are rewritten in place. WITHOUT
 *  one, a line is INSERTED — after the tempo line when there is one, so the
 *  two live together, otherwise at the end. Nothing is inserted for 4/4 when
 *  the document never mentions a meter: writing "the default, explicitly" into
 *  someone's file for a change that changes nothing is noise. */
export function timeSigEdit(
  doc: string,
  lang: EditorLang,
  sig: TimeSig,
): { from: number; to: number; expected: string; insert: string } | null {
  const numbers = lang === 'rondo' ? `${sig.num} ${sig.den}` : `${sig.num}, ${sig.den}`
  const site = findTimeSigSite(doc, lang)
  if (site !== null) {
    if (site.text === numbers) return null // already says exactly this
    return { from: site.from, to: site.to, expected: site.text, insert: numbers }
  }
  if (sig.num === 4 && sig.den === 4) return null // already in 4/4, implicitly
  const line = lang === 'rondo' ? `timesig ${sig.num} ${sig.den}` : `setTimeSig(${sig.num}, ${sig.den})`
  // Anchor to the END of the tempo line's own line, so the pair reads together
  // and the insertion can never land inside an indented block body.
  const tempo = findTempoSite(doc, lang)
  const lineEnd = tempo === null ? -1 : doc.indexOf('\n', tempo.to)
  const pos = tempo === null || lineEnd === -1 ? doc.length : lineEnd
  const atEnd = pos === doc.length
  // Mid-document: land on the newline that ends the tempo line, so the new
  // line goes after it. At the end: only add a break if the file lacks one.
  const prefix = atEnd ? (doc.length === 0 || doc.endsWith('\n') ? '' : '\n') : '\n'
  const suffix = atEnd ? '\n' : ''
  return { from: pos, to: pos, expected: '', insert: `${prefix}${line}${suffix}` }
}

/** Parse what someone typed into the meter field: `3/4`, `3 4`, `7/8`. null
 *  when it is not a meter — the field snaps back rather than guessing. */
export function parseTimeSig(text: string): TimeSig | null {
  const m = /^\s*(\d{1,2})\s*[/ ]\s*(\d{1,3})\s*$/.exec(text)
  if (!m) return null
  const num = Number(m[1])
  const den = Number(m[2])
  if (!Number.isInteger(num) || num < 1 || num > 64) return null
  if (!Number.isInteger(den) || den < 1 || den > 64 || (den & (den - 1)) !== 0) return null
  return { num, den }
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
  // The meter, in the same pill: it is the other half of "how long is a bar",
  // and typing it here writes the timesig line rather than hiding the change
  // in session state (same contract as the BPM field).
  const sigField = document.createElement('input')
  sigField.className = 'tempo-input tempo-sig'
  sigField.type = 'text'
  sigField.inputMode = 'numeric'
  sigField.autocomplete = 'off'
  sigField.spellcheck = false
  sigField.setAttribute('aria-label', 'time signature')
  const sub = document.createElement('span')
  sub.className = 'tempo-cps'
  root.append(field, unit, sigField, sub)

  const currentCps = (): number => docCps(opts.view.state.doc.toString(), opts.getLang()) ?? opts.getSessionCps()
  const currentSig = (): TimeSig => docTimeSig(opts.view.state.doc.toString(), opts.getLang())
  const currentBpm = (): number => cpsToBpm(currentCps(), quartersPerBar(currentSig()))

  const refresh = (): void => {
    const cps = currentCps()
    const sig = currentSig()
    const inDoc = docCps(opts.view.state.doc.toString(), opts.getLang()) !== null
    // never fight the hands that are typing in the field
    if (document.activeElement !== field) field.value = showBpm(cpsToBpm(cps, quartersPerBar(sig)))
    if (document.activeElement !== sigField) sigField.value = `${sig.num}/${sig.den}`
    sub.textContent = inDoc ? `${trimCps(cps)} cps` : `${trimCps(cps)} cps, this run only`
    // The meter is named only when it is not 4/4: every project would
    // otherwise carry a "in 4/4" that says nothing.
    const meter = sig.num === 4 && sig.den === 4 ? '' : ` in ${sig.num}/${sig.den}`
    tooltip(
      root,
      `tempo in bpm, counted in quarter notes; one bar${meter} per cycle. ` +
      (inDoc
        ? 'Typing rewrites the tempo line in your code.'
        : 'Your code sets no tempo, so this applies to the current run only. Add a tempo line to keep it.'),
    )
  }

  const commit = (): void => {
    const typed = Number(field.value.trim())
    if (!Number.isFinite(typed) || typed <= 0) {
      refresh() // unreadable input: snap back to what is actually playing
      return
    }
    const doc = opts.view.state.doc.toString()
    const sig = docTimeSig(doc, opts.getLang())
    const { min, max } = bpmRange(sig)
    const bpm = Math.min(max, Math.max(min, typed))
    const edit = tempoEdit(doc, opts.getLang(), bpm)
    if (edit === null) {
      opts.setSessionCps(bpmToCps(bpm, quartersPerBar(sig)))
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
      field.value = showBpm(currentBpm())
      field.blur()
    }
  })
  field.addEventListener('blur', commit)
  // selecting on focus makes the whole value replaceable with one thumb tap
  field.addEventListener('focus', () => field.select())

  /* The meter writes the timesig line (or adds one), then re-evals — the same
   * write-verify path the BPM field and the inline widgets use, so an edit
   * that raced a keystroke is dropped rather than spliced over. Typing
   * something that is not a meter snaps back: the beat unit has to be a power
   * of two, and guessing what someone meant by 4/6 would be worse than
   * refusing it. */
  const commitSig = (): void => {
    const parsed = parseTimeSig(sigField.value)
    if (parsed === null) {
      refresh()
      return
    }
    const doc = opts.view.state.doc.toString()
    const edit = timeSigEdit(doc, opts.getLang(), parsed)
    if (edit !== null && verifiedChanges(opts.view, [edit])) opts.requestEval(true)
    refresh()
  }
  sigField.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      sigField.blur()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      const s = currentSig()
      sigField.value = `${s.num}/${s.den}`
      sigField.blur()
    }
  })
  sigField.addEventListener('blur', commitSig)
  sigField.addEventListener('focus', () => sigField.select())

  refresh()
  return { el: root, refresh }
}
