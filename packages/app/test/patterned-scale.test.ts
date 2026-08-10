import { describe, expect, it } from 'vitest'
import { compile } from '@rondocode/rondo'
import { F, TimeSpan, hasOnset, n } from '@rondocode/pattern'
import type { ControlMap, SchedulerEvent } from '@rondocode/pattern'
import { stageCode } from '../../server/src/render-runner'
import { EventFlasher, rondoNoteLiterals } from '../src/editor/flash'

/* ------------------------------------------------------------------------- *
 * `scale: <c-maj f-min>` — the key modulates.
 *
 * The thing that made this awkward is worth stating: a scale name is TWO
 * WORDS (`c major`) and mini atoms are space-delimited, so a scale could not
 * be a mini atom at all. The mini lexer also rejects `-` inside a word, so the
 * short form was no good either. `_` is what survives, and rondo rewrites its
 * `-` to one — LENGTH-PRESERVINGLY, because note-flash maps a loc back to the
 * buffer by offset and expanding `maj` to `major` here would shift every
 * highlight onto the wrong characters.
 * ------------------------------------------------------------------------- */

const SRC = `synth lead
  saw note
  * adsr .01 .1 .7 .2

play lead
  0 2 4
  scale: <c-maj f-min>

cps .5`

const notesAt = (cycle: number, code: string): number[] => {
  const st = stageCode(code)
  expect(st.ok, 'stage failed').toBe(true)
  if (!st.ok) return []
  const pat = [...st.patterns.values()][0]!
  return pat.query(new TimeSpan(F(cycle), F(cycle + 1)))
    .filter(hasOnset)
    .map((h) => (h.value as ControlMap).note as number)
}

describe('the key actually changes', () => {
  const c = compile(SRC)

  it('compiles', () => {
    expect(c.ok, JSON.stringify(c.errors?.[0])).toBe(true)
  })

  it('cycle 0 is C major and cycle 1 is F minor', () => {
    // C E G  then  F Ab C — a real modulation, not a transposition
    expect(notesAt(0, c.code!)).toEqual([60, 64, 67])
    expect(notesAt(1, c.code!)).toEqual([65, 68, 72])
  })

  it('and it comes back round', () => {
    expect(notesAt(2, c.code!)).toEqual(notesAt(0, c.code!))
  })
})

describe('it composes with degree transposition', () => {
  it('add re-resolves through the scale sounding at that moment', () => {
    /* `add` works in scale DEGREES by re-reading the stamped scale name, so a
     * patterned scale has to stamp per event or this silently transposes
     * everything through whichever scale happened to be first. */
    const p = n('0 2 4').scale('<c_maj f_min>').add(2)
    const at = (cy: number): number[] =>
      p.query(new TimeSpan(F(cy), F(cy + 1))).filter(hasOnset).map((h) => (h.value as ControlMap).note as number)
    expect(at(0)).toEqual([64, 67, 71]) // E G B — two degrees up in C major
    expect(at(1)).toEqual([68, 72, 75]) // Ab C Eb — two degrees up in F minor
  })

  it('the scale NAME on the event is the one that applied', () => {
    const p = n('0').scale('<c_maj f_min>')
    const nameAt = (cy: number): unknown =>
      (p.query(new TimeSpan(F(cy), F(cy + 1))).filter(hasOnset)[0]!.value as ControlMap).scale
    expect(nameAt(0)).toBe('c_maj')
    expect(nameAt(1)).toBe('f_min')
  })
})

describe('a bad scale name still fails EAGERLY', () => {
  it('throws when the pattern is built, not when it plays', () => {
    // the static form has always done this; a patterned one must not be laxer
    expect(() => n('0').scale('<c_maj f_nonsense>')).toThrow(/nonsense/)
  })

  it('and the single-name form is unchanged', () => {
    expect(() => n('0').scale('h minor')).toThrow()
  })
})

describe('the patterned scale lights up, on the right characters', () => {
  const c = compile(SRC)

  it('is reported as a notation span', () => {
    expect(c.ok).toBe(true)
    if (!c.ok) return
    expect(c.notes.map((x) => x.content)).toContain('<c_maj f_min>')
  })

  it('and the span covers exactly the text in the buffer', () => {
    /* The emitted spelling differs by `-` vs `_`; the RANGE must still be the
     * scale the reader wrote. A non-length-preserving rewrite would slide this
     * onto the wrong characters and the highlight would be silently wrong. */
    if (!c.ok) return
    const span = c.notes.find((x) => x.content.includes('_maj'))!
    expect(SRC.slice(span.from, span.from + span.content.length)).toBe('<c-maj f-min>')
  })

  it('the flasher highlights the arm that fired, and not the other', () => {
    if (!c.ok) return
    const st = stageCode(c.code)
    expect(st.ok).toBe(true)
    if (!st.ok) return
    const pat = [...st.patterns.values()][0]!
    const controls = pat.query(new TimeSpan(F(0), F(1))).filter(hasOnset)[0]!.value as ControlMap
    const ev: SchedulerEvent = {
      timeSec: 0, durSec: 0.25, cycle: 0, controls,
      ...(controls.loc !== undefined ? { loc: controls.loc } : {}),
      ...(controls.locs !== undefined ? { locs: controls.locs } : {}),
    }
    const ranges: { from: number; to: number }[] = []
    const timers: (() => void)[] = []
    const f = new EventFlasher(
      {
        dispatch: (spec: { effects: unknown[] }) => {
          for (const e of spec.effects as { value?: { from: number; to: number } }[]) {
            if (e.value !== undefined && typeof e.value.from === 'number') ranges.push(e.value)
          }
        },
        state: { doc: { length: SRC.length } },
      },
      () => 0, () => false,
      { setTimeoutImpl: (fn) => { timers.push(fn); return timers.length }, clearTimeoutImpl: () => {} },
    )
    f.onGoodEvalLiterals(rondoNoteLiterals(c.notes))
    f.onEvents([ev])
    for (const t of timers.splice(0)) t()
    const lit = ranges.map((r) => SRC.slice(r.from, r.to))
    expect(lit, `flashed: ${lit.join(' | ')}`).toContain('c-maj')
    expect(lit).not.toContain('f-min')
  })
})
