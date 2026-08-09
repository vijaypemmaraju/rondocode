import { StateEffect, StateField } from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import { Decoration, EditorView } from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'
import { parse } from 'acorn'
import { noteNameToMidi, parseChord } from '@rondocode/pattern'
import type { ControlMap, Loc, SchedulerEvent } from '@rondocode/pattern'

/* ------------------------------------------------------------------------- *
 * Event flashing: when the scheduler fires an event whose controls carry a
 * mini-notation Loc, briefly highlight the originating text.
 *
 * THE MAPPING PROBLEM: a Loc is an offset range into the MINI STRING the
 * atom was parsed from ("0 0 3 5"), not into the document. To find the doc
 * range we collect every escape-free string literal of the last GOOD eval's
 * source (acorn, same trick as evalCode's MiniError mapping) and accept a
 * literal when the text at [loc.start, loc.end) inside it matches the atom
 * that plausibly created the event (its n degree, note, or sound). Several
 * literals can match identical offsets+text — all of them flash; that only
 * happens for genuinely identical atoms and reads fine visually.
 *
 * DIRTY POLICY (simplest correct): locs refer to the source at eval time,
 * so if the doc has changed since the last successful eval we skip flashing
 * entirely rather than guess at remapped positions. Re-running the doc
 * resumes flashing.
 *
 * Every entry point is try/caught: a flashing bug must never break the
 * editor or the scheduler tick.
 * ------------------------------------------------------------------------- */

/** Flash lifetime — the single source of truth: the CSS pulse animation
 *  reads it via the --flash-ms custom property (set in mountEditor). */
export const FLASH_MS = 150

/** Upper bound on how long a mark stays lit.
 *
 *  This was 4000, which is not a long note — it is TWO CYCLES at the default
 *  cps of 0.5. So `<c3 a2 f2 g2>/4`, a chord held four cycles, lit for the
 *  first two and went dark while it was still sounding. The highlight is
 *  supposed to say "this note is sounding now"; capped below the length of
 *  ordinary held chords, it said something false.
 *
 *  It is a BACKSTOP, not a policy: it exists so a pathological duration cannot
 *  pin a decoration forever. What actually keeps stale marks off the screen is
 *  clearPending(), which now clears the visible ones too — a mark can outlive
 *  its note only if the transport is still running, and then it is correct. */
export const MAX_LIT_MS = 30_000
/** Cap on concurrently scheduled flash timers (a dense pattern must not
 *  flood the event loop with thousands of setTimeouts). */
export const MAX_PENDING_FLASHES = 64

const addFlash = StateEffect.define<{ from: number; to: number; id: number }>({
  map: (v, mapping) => ({ ...v, from: mapping.mapPos(v.from), to: mapping.mapPos(v.to) }),
})
const removeFlash = StateEffect.define<number>()

const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes)
    for (const e of tr.effects) {
      if (e.is(addFlash)) {
        const { from, to, id } = e.value
        if (from < to) {
          deco = deco.update({
            add: [Decoration.mark({ class: 'cm-flash', flashId: id }).range(from, to)],
            sort: true,
          })
        }
      } else if (e.is(removeFlash)) {
        deco = deco.update({ filter: (_f, _t, d) => d.spec['flashId'] !== e.value })
      }
    }
    return deco
  },
  provide: (f) => EditorView.decorations.from(f),
})

/** The extension that renders flash decorations. */
export const flashExtension: Extension = flashField

/** One source-literal chunk of a (possibly concatenated) mini string: where it
 *  sits in the assembled `content` vs. where it sits in the document. */
interface LitPiece {
  /** Offset of this chunk's first char within the assembled `content`. */
  assembledStart: number
  /** Doc offset of this chunk's first content char. */
  sourceStart: number
  /** Chunk length in chars. */
  length: number
}

/** An escape-free mini string as the pattern engine sees it. `content` is the
 *  ASSEMBLED value (the concatenation the mini parser numbers its locs against);
 *  `pieces` maps ranges of it back to the document. A plain `'…'` literal is one
 *  piece; a `'…' + '…'` concatenation is several. `contentStart` is the doc
 *  offset of the first piece (kept for simple-literal callers). */
export interface StringLit {
  contentStart: number
  content: string
  pieces: LitPiece[]
  /** Spans that STAND FOR a stretch of the content rather than being it: a
   *  patdef reference. `<openB tail openA tail>` has no notes of its own, so
   *  without these the collapsed figure stays dark while the arrangement it
   *  names plays — the reader is watching the one line that is not literal
   *  notation, and it is the one line that never moves. */
  refs?: { from: number; to: number; assembledStart: number; assembledEnd: number }[]
}

/** If `node` is an escape-free string literal, or a `+` chain of them, return
 *  its source chunks in left-to-right order; otherwise null. `+` on any
 *  non-string-literal operand (a variable, a number) is NOT a chunk chain — it
 *  returns null so the caller recurses and picks up the string leaves alone. */
function stringChunks(
  node: { type: string; [k: string]: unknown },
  source: string,
): { sourceStart: number; value: string }[] | null {
  if (node.type === 'Literal') {
    const start = node['start'] as number
    const end = node['end'] as number
    const rawValue = (node as { value?: unknown }).value
    if (typeof rawValue !== 'string') return null
    const value = rawValue
    // Reject escapes: raw text must equal cooked value so offset math is exact.
    if (source.slice(start + 1, end - 1) !== value) return null
    return [{ sourceStart: start + 1, value }]
  }
  // A no-substitution template literal (`...`, no ${}) — e.g. a multi-line
  // note(`[c3,e3,g3]\n  [f3,a3,c4]`). One quasi, no expressions. The content is
  // between the backticks; require raw === cooked (no escapes) so offset math is
  // exact, same rule as the Literal case.
  if (node.type === 'TemplateLiteral') {
    const quasis = node['quasis'] as { value: { cooked?: string } }[]
    const exprs = node['expressions'] as unknown[]
    if (exprs.length !== 0 || quasis.length !== 1) return null
    const cooked = quasis[0]!.value.cooked
    if (typeof cooked !== 'string') return null
    const start = node['start'] as number
    const end = node['end'] as number
    if (source.slice(start + 1, end - 1) !== cooked) return null
    return [{ sourceStart: start + 1, value: cooked }]
  }
  if (node.type === 'BinaryExpression' && node['operator'] === '+') {
    const left = stringChunks(node['left'] as typeof node, source)
    const right = stringChunks(node['right'] as typeof node, source)
    if (left === null || right === null) return null
    return [...left, ...right]
  }
  return null
}

/** Assemble raw chunks into a StringLit: concatenate the values and record each
 *  chunk's running offset into the assembled content. */
function assemble(chunks: { sourceStart: number; value: string }[]): StringLit {
  let content = ''
  const pieces: LitPiece[] = []
  for (const c of chunks) {
    pieces.push({ assembledStart: content.length, sourceStart: c.sourceStart, length: c.value.length })
    content += c.value
  }
  return { contentStart: pieces[0]!.sourceStart, content, pieces }
}

/** Every mini string of `source` — plain literals AND `+`-concatenated ones —
 *  each carrying the source mapping the flasher needs. The pattern engine
 *  numbers a Loc against the ASSEMBLED string, so a concatenation must be
 *  collected as ONE StringLit (with per-chunk offsets), not as its separate
 *  literals — otherwise atoms past the first chunk map to nothing. Parse
 *  failure → []. */
export function collectStringLiterals(source: string): StringLit[] {
  const out: StringLit[] = []
  try {
    const program = parse(source, { ecmaVersion: 2022, sourceType: 'script' })
    // Custom descent: when a node is a string literal or a `+` chain of them,
    // emit it as one StringLit and DON'T recurse (so its leaf literals aren't
    // also emitted standalone). Otherwise recurse into child nodes generically.
    const visit = (node: unknown): void => {
      if (node === null || typeof node !== 'object') return
      const n = node as { type?: string; [k: string]: unknown }
      if (typeof n.type !== 'string') return
      const chunks = stringChunks(n as { type: string; [k: string]: unknown }, source)
      if (chunks !== null) {
        out.push(assemble(chunks))
        return
      }
      for (const key in n) {
        const child = n[key]
        if (Array.isArray(child)) child.forEach(visit)
        else visit(child)
      }
    }
    visit(program)
  } catch {
    // unparseable source (should not happen for a good eval): no literals
  }
  return out
}

/** Does atom text `t` plausibly account for this event's controls? Locs are
 *  attached by the entry points n()/note()/sound(), so the atom is a degree,
 *  a note (number or name), or a sound word. */
const atomMatches = (t: string, controls: ControlMap): boolean => {
  if (t.length === 0 || /\s/.test(t)) return false
  if (typeof controls.sound === 'string' && t === controls.sound) return true
  const num = Number(t)
  if (typeof controls.n === 'number' && !Number.isNaN(num) && num === controls.n) return true
  if (typeof controls.note === 'number') {
    if (!Number.isNaN(num) && num === controls.note) return true
    if (noteNameToMidi(t) === controls.note) return true
    // Chord atoms ("Am7", "<Cmaj7 …>") aren't note names: a chord expands to
    // several note events, all stamped with the chord atom's loc. Light the
    // atom when the fired note is one of the chord's notes.
    const ch = parseChord(t)
    if (ch !== undefined && ch.includes(controls.note)) return true
  }
  return false
}

/** Doc ranges to flash for an event loc — every literal where the range fits
 *  and the text there matches the event (see module doc). */
export function locToDocRanges(
  literals: StringLit[],
  loc: Loc,
  controls: ControlMap,
): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = []
  if (!(loc.start >= 0) || !(loc.end > loc.start)) return out
  for (const lit of literals) {
    // The parser stamps each loc with its exact source string, so flash ONLY
    // the originating literal — not every same-looking one (stacked voices like
    // q0/q1/q2 share offsets and would otherwise cross-light a wrong/future
    // note). locs without a src (built outside the parser) fall back to the
    // old text-match-anywhere behavior.
    if (loc.src !== undefined && lit.content !== loc.src) continue
    if (loc.end > lit.content.length) continue
    // A parser-stamped loc (src present, and matched above) already pinpoints the
    // exact originating atom, so TRUST it — don't re-check the atom text against
    // the event's note. Transposers (octave/add/invert/voicing) change the note
    // value while the source atom stays put ("e3" → note 64), so an atomMatches
    // gate here would wrongly drop every shifted note and it would never flash.
    // atomMatches is only needed to disambiguate the srcless match-anywhere path.
    const trusted = loc.src !== undefined
    if (!trusted && !atomMatches(lit.content.slice(loc.start, loc.end), controls)) continue
    // Map the assembled-string range back to the document via the chunk that
    // fully contains it. An atom that straddles a concatenation boundary maps to
    // no single chunk and is skipped (mini atoms don't span the `+` in practice).
    // Any REFERENCE covering this atom lights too: the word that stands for
    // the figure, and every reference nested inside it.
    for (const r of lit.refs ?? []) {
      if (loc.start >= r.assembledStart && loc.end <= r.assembledEnd) out.push({ from: r.from, to: r.to })
    }
    const piece = lit.pieces.find(
      (p) => loc.start >= p.assembledStart && loc.end <= p.assembledStart + p.length,
    )
    if (piece === undefined) continue
    const offset = piece.sourceStart - piece.assembledStart
    out.push({ from: offset + loc.start, to: offset + loc.end })
  }
  return out
}

/** Build flash literals from rondo notation spans: `content` is the mini string
 *  the compiler passed to n()/note() (so it equals each event's `loc.src`), and
 *  `from` is that string's char offset in the rondo buffer. One single-piece
 *  literal each — a mini Loc offset indexes straight into it. */
export function rondoNoteLiterals(
  notes: { content: string; from: number; pieces?: LitPiece[]; refs?: StringLit['refs'] }[],
): StringLit[] {
  return notes.map((n) => ({
    contentStart: n.from,
    content: n.content,
    ...(n.refs !== undefined && n.refs.length > 0 ? { refs: n.refs } : {}),
    // a beat line with velocity suffixes compiles to a STRIPPED mini string —
    // the compiler supplies pieces mapping it back around each removed `:v`
    pieces: n.pieces ?? [{ assembledStart: 0, sourceStart: n.from, length: n.content.length }],
  }))
}

/** Flash literals for rondo's js escape hatches: each region is raw JS that
 *  sits VERBATIM in the buffer at [from, to), so the normal JS literal scan
 *  runs on the slice and every offset just shifts by the region start. This
 *  is what makes note-flash work inside js{ … } / js blocks. */
export function jsRegionLiterals(source: string, regions: { from: number; to: number }[]): StringLit[] {
  const out: StringLit[] = []
  for (const r of regions) {
    for (const lit of collectStringLiterals(source.slice(r.from, r.to))) {
      out.push({
        contentStart: lit.contentStart + r.from,
        content: lit.content,
        pieces: lit.pieces.map((p) => ({ ...p, sourceStart: p.sourceStart + r.from })),
      })
    }
  }
  return out
}

/** A source range to PULSE on loc-less events of a channel. Patterns built
 *  from continuous signals (`n(irand(8).segment(8))`) have no mini locs, so
 *  the per-atom flash can't anchor — instead the whole expression (JS) or
 *  notation line (rondo `irand N seg:M`) lights on each of its notes. */
export interface PulseSpan {
  from: number
  to: number
  /** the channel whose events pulse this span (event controls.sound). */
  sound: string
}

/** Scan JS source for pulse spans: inside each `p('name', CHAIN)`, any
 *  n()/note() whose first argument is NOT a string literal produces loc-less
 *  events — pulse that argument's text. The chain's `.sound('x')` names the
 *  channel (falling back to the p() name). Parse failure → []. */
export function collectPulseSpans(source: string): PulseSpan[] {
  const out: PulseSpan[] = []
  try {
    const program = parse(source, { ecmaVersion: 2022, sourceType: 'script' })
    const isCall = (n: unknown): n is { type: string; callee: unknown; arguments: unknown[]; [k: string]: unknown } =>
      typeof n === 'object' && n !== null && (n as { type?: string }).type === 'CallExpression'
    const calleeName = (n: { callee: unknown }): string | undefined => {
      const c = n.callee as { type?: string; name?: string }
      return c.type === 'Identifier' ? c.name : undefined
    }
    const litStr = (n: unknown): string | undefined => {
      const l = n as { type?: string; value?: unknown }
      return l?.type === 'Literal' && typeof l.value === 'string' ? l.value : undefined
    }
    // find `.sound('x')` in a chain; collect pulse candidates in the same walk
    const scanChain = (node: unknown, add: (from: number, to: number) => void, sound: { v?: string }): void => {
      if (node === null || typeof node !== 'object') return
      const n = node as { type?: string; [k: string]: unknown }
      if (typeof n.type !== 'string') return
      if (isCall(n)) {
        const callee = n.callee as { type?: string; property?: { type?: string; name?: string }; [k: string]: unknown }
        if (callee.type === 'MemberExpression' && callee.property?.type === 'Identifier' &&
            callee.property.name === 'sound' && sound.v === undefined) {
          const sv = litStr(n.arguments[0])
          if (sv !== undefined) sound.v = sv
        }
        const cn = calleeName(n)
        if ((cn === 'n' || cn === 'note') && n.arguments.length > 0 && litStr(n.arguments[0]) === undefined) {
          const a = n.arguments[0] as { start?: number; end?: number }
          if (typeof a.start === 'number' && typeof a.end === 'number') add(a.start, a.end)
        }
      }
      for (const key in n) {
        const child = n[key]
        if (Array.isArray(child)) child.forEach((c) => scanChain(c, add, sound))
        else scanChain(child, add, sound)
      }
    }
    const visit = (node: unknown): void => {
      if (node === null || typeof node !== 'object') return
      const n = node as { type?: string; [k: string]: unknown }
      if (typeof n.type !== 'string') return
      if (isCall(n) && calleeName(n) === 'p' && n.arguments.length === 2) {
        const pname = litStr(n.arguments[0])
        if (pname !== undefined) {
          const spans: { from: number; to: number }[] = []
          const sound: { v?: string } = {}
          scanChain(n.arguments[1], (from, to) => spans.push({ from, to }), sound)
          for (const sp of spans) out.push({ ...sp, sound: sound.v ?? pname })
          return
        }
      }
      for (const key in n) {
        const child = n[key]
        if (Array.isArray(child)) child.forEach(visit)
        else visit(child)
      }
    }
    visit(program)
  } catch {
    // unparseable source: no pulses
  }
  return out
}

type SetTimeoutImpl = (fn: () => void, ms: number) => unknown
type ClearTimeoutImpl = (handle: unknown) => void

/** The slice of EditorView the flasher needs — injectable for tests
 *  (EditorView satisfies it structurally). */
export interface FlashHost {
  dispatch(spec: { effects: StateEffect<unknown>[] }): void
  readonly state: { readonly doc: { readonly length: number } }
}

export class EventFlasher {
  private literals: StringLit[] = []
  private pulses: PulseSpan[] = []
  /** Handles of scheduled-but-not-yet-fired flash timers (NOT the removal
   *  timers — those must run so existing marks get cleaned up). */
  private readonly pendingTimers = new Set<unknown>()
  /** Ids of marks currently on screen, so a stop can take them down. */
  private readonly litIds = new Set<number>()
  private nextId = 1
  private disposed = false
  private readonly setT: SetTimeoutImpl
  private readonly clearT: ClearTimeoutImpl

  constructor(
    private readonly view: FlashHost,
    /** Audio "now" in seconds — the clock SchedulerEvent.timeSec lives on. */
    private readonly now: () => number,
    /** True when the doc differs from the last GOOD eval's source. */
    private readonly isDirty: () => boolean,
    /** Timer injection for tests; provide BOTH or NEITHER. */
    timers?: { setTimeoutImpl: SetTimeoutImpl; clearTimeoutImpl: ClearTimeoutImpl },
  ) {
    this.setT = timers?.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearT =
      timers?.clearTimeoutImpl ??
      ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  }

  /** Call after every successful eval with the eval'd source. */
  onGoodEval(source: string): void {
    this.literals = collectStringLiterals(source)
    this.pulses = collectPulseSpans(source)
  }

  /** rondo mode: set flash literals directly. The eval'd source is transpiled
   *  JS (not the buffer), so we can't scan it here — the rondo compiler supplies
   *  each notation string + its buffer offset (see rondoNoteLiterals). */
  onGoodEvalLiterals(literals: StringLit[], pulses: PulseSpan[] = []): void {
    this.literals = literals
    this.pulses = pulses
  }

  /** Session.onPatternEvents hook. */
  onEvents(evs: SchedulerEvent[]): void {
    try {
      if (this.disposed || this.isDirty()) return
      for (const ev of evs) {
        const loc = ev.loc
        // loc-less events (patterns built from signals, not mini strings)
        // PULSE their channel's registered span instead of an atom flash
        const pulseRanges = loc === undefined ? this.pulseRangesFor(ev.controls) : []
        if (loc === undefined && pulseRanges.length === 0) continue
        if (this.pendingTimers.size >= MAX_PENDING_FLASHES) return
        const delay = Math.max(0, (ev.timeSec - this.now()) * 1000)
        // Stay lit for the event's musical duration (the user reads "this
        // note is sounding now"), bounded: at least FLASH_MS so very short
        // events are visible at all, at most MAX_LIT_MS so a drone doesn't
        // pin a mark forever.
        const litMs = Math.min(Math.max(ev.durSec * 1000, FLASH_MS), MAX_LIT_MS)
        let handle: unknown
        handle = this.setT(() => {
          this.pendingTimers.delete(handle)
          if (loc !== undefined) this.fire(loc, ev.controls, litMs)
          else this.flashRanges(pulseRanges, litMs)
        }, delay)
        this.pendingTimers.add(handle)
      }
    } catch {
      // flashing must never break the scheduler tick
    }
  }

  /** Cancel every scheduled-but-unfired flash AND clear the visible ones
   *  (transport stop: events that will never sound must not light up, and a
   *  note that is no longer sounding must not stay lit).
   *
   *  Clearing the visible marks used to be left to their own removal timers,
   *  which was only tolerable because MAX_LIT_MS capped them at 4s. Once a
   *  mark can legitimately stay lit for a long held chord, a stop has to take
   *  it down — otherwise pressing stop leaves the editor lit for the rest of
   *  the note. */
  clearPending(): void {
    for (const h of this.pendingTimers) this.clearT(h)
    this.pendingTimers.clear()
    this.clearLit()
  }

  /** Remove every currently-visible mark. */
  private clearLit(): void {
    if (this.litIds.size === 0) return
    const ids = [...this.litIds]
    this.litIds.clear()
    try {
      this.view.dispatch({ effects: ids.map((id) => removeFlash.of(id)) })
    } catch {
      // view may be gone; nothing to clean up
    }
  }

  /** TERMINAL: cancel pending flashes and ignore everything after. */
  dispose(): void {
    this.disposed = true
    this.clearPending()
  }

  private pulseRangesFor(controls: ControlMap): { from: number; to: number }[] {
    const sound = controls['sound']
    if (typeof sound !== 'string') return []
    return this.pulses.filter((sp) => sp.sound === sound).map((sp) => ({ from: sp.from, to: sp.to }))
  }

  private fire(loc: Loc, controls: ControlMap, litMs: number = FLASH_MS): void {
    this.flashRanges(locToDocRanges(this.literals, loc, controls), litMs)
  }

  private flashRanges(ranges: { from: number; to: number }[], litMs: number): void {
    try {
      if (this.disposed || this.isDirty()) return
      const docLen = this.view.state.doc.length
      const effects: StateEffect<unknown>[] = []
      const ids: number[] = []
      for (const r of ranges) {
        if (r.to > docLen) continue // defensive: clamp to the current doc
        const id = this.nextId++
        ids.push(id)
        effects.push(addFlash.of({ from: r.from, to: r.to, id }))
      }
      if (effects.length === 0) return
      this.view.dispatch({ effects })
      for (const id of ids) this.litIds.add(id)
      this.setT(() => {
        if (this.disposed) return
        for (const id of ids) this.litIds.delete(id)
        try {
          this.view.dispatch({ effects: ids.map((id) => removeFlash.of(id)) })
        } catch {
          // view may be gone; nothing to clean up
        }
      }, litMs)
    } catch {
      // flashing must never break the editor
    }
  }
}
