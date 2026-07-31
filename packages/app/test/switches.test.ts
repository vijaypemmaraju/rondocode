import { describe, expect, it } from 'vitest'
import { compile } from '@rondocode/rondo'
import { scanSwitches, toggled } from '../src/editor/rondo/switches'
import { scanSwitchesJs, scanPlaysJs } from '../src/editor/widgets/jsscan'
import { STEP_RE, accValue, scanPlays, stepText } from '../src/editor/rondo/widgets'
import type { SwitchMatch } from '../src/editor/rondo/switches'

/* ------------------------------------------------------------------------- *
 * The Switch scanners.
 *
 * scan-parity.test.ts proves both languages agree on WHAT a switch is; the
 * write spans are excluded there because the two languages genuinely spell a
 * different number of them. This is where those spans are checked, and they
 * are the part that can silently corrupt a patch: a span off by one rewrites
 * the wrong number and the control starts lying about its own state.
 * ------------------------------------------------------------------------- */

/** Apply a toggle to the source the way the widget does, so a test asserts on
 *  the RESULTING TEXT rather than on offsets nobody can read. */
const flip = (src: string, m: SwitchMatch): string => {
  const next = toggled(m)
  const ordered = [...m.writes].sort((a, b) => a.from - b.from)
  let out = ''
  let at = 0
  for (const w of ordered) {
    out += src.slice(at, w.from) + String(next[w.holds])
    at = w.to
  }
  return out + src.slice(at)
}

describe('scanSwitches (rondo)', () => {
  it('reads a binding, resting on the value written first', () => {
    const src = 'synth a\n  saw note\n  d = switch 0.2 0.9\n  * d\n'
    const [m] = scanSwitches(src)
    expect(m?.values).toEqual([0.2, 0.9])
    expect(m?.name).toBe('d')
    expect(m?.synth).toBe('a')
    expect(m?.macro).toBeUndefined()
  })

  it('swaps the pair in place and touches nothing else', () => {
    const src = 'synth a\n  saw note\n  d = switch 0.2 0.9\n  * d\n'
    expect(flip(src, scanSwitches(src)[0]!)).toBe('synth a\n  saw note\n  d = switch 0.9 0.2\n  * d\n')
  })

  it('survives a round trip: two taps return the original text', () => {
    const src = 'synth a\n  saw note\n  d = switch 0.2 0.9\n'
    const once = flip(src, scanSwitches(src)[0]!)
    expect(flip(once, scanSwitches(once)[0]!)).toBe(src)
  })

  it('handles negative values without eating the sign', () => {
    const src = 'synth a\n  saw note\n  b = switch -1 1\n'
    expect(scanSwitches(src)[0]?.values).toEqual([-1, 1])
    expect(flip(src, scanSwitches(src)[0]!)).toBe('synth a\n  saw note\n  b = switch 1 -1\n')
  })

  it('does not mistake digits in the NAME for the first value', () => {
    // the spans are located from the end for exactly this case
    const src = 'synth a\n  saw note\n  osc2 = switch 1 9\n'
    const [m] = scanSwitches(src)
    expect(m?.name).toBe('osc2')
    expect(flip(src, m!)).toBe('synth a\n  saw note\n  osc2 = switch 9 1\n')
  })

  it('reads a top-level switch as a macro, with no owning synth', () => {
    const [m] = scanSwitches('switch fat 1 9\n\nsynth a\n  saw note\n')
    expect(m?.macro).toBe(true)
    expect(m?.synth).toBeUndefined()
    expect(m?.name).toBe('fat')
  })

  it('keeps a later binding attributed to its own synth', () => {
    const src = 'synth a\n  saw note\n  d = switch 1 9\n\nsynth b\n  saw note\n  e = switch 2 8\n'
    expect(scanSwitches(src).map((m) => [m.name, m.synth])).toEqual([['d', 'a'], ['e', 'b']])
  })

  it('ignores a switch inside a comment', () => {
    expect(scanSwitches('synth a\n  saw note\n  # d = switch 1 9\n')).toEqual([])
  })

  it('offers no widget for two equal values, which rondo already errors on', () => {
    // a toggle between a value and itself would be a control that does nothing
    expect(scanSwitches('synth a\n  saw note\n  d = switch 1 1\n')).toEqual([])
  })
})

describe('scanSwitchesJs', () => {
  const src = `const a = synth(({ note, saw, param }) => saw(note.freq).mul(param('d', 0.2, { values: [0.2, 0.9] })))`

  it('writes ONE span: the default is what says where it rests', () => {
    // `values` is the SET; reordering it too would be a diff that changes
    // nothing. rondo swaps because it has no separate default.
    const [m] = scanSwitchesJs(src)
    expect(m?.writes).toHaveLength(1)
    expect(m?.values).toEqual([0.2, 0.9])
  })

  it('moves the default and leaves the array exactly as written', () => {
    expect(flip(src, scanSwitchesJs(src)[0]!)).toContain("param('d', 0.9, { values: [0.2, 0.9] })")
  })

  it('round-trips in two taps', () => {
    const once = flip(src, scanSwitchesJs(src)[0]!)
    expect(flip(once, scanSwitchesJs(once)[0]!)).toBe(src)
  })

  it('reads the pair in RESTING order even when values is written the other way', () => {
    // `values: [9, 1]` with default 1 is resting on the second element
    const s = `const a = synth(({ note, saw, param }) => saw(note.freq).mul(param('d', 1, { values: [9, 1] })))`
    const [m] = scanSwitchesJs(s)
    expect(m?.values).toEqual([1, 9])
    expect(flip(s, m!)).toContain("param('d', 9, { values: [9, 1] })") // array untouched
  })

  it('finds a macro switch and flags it, so a tap fans out', () => {
    const [m] = scanSwitchesJs(`macro('fat', 1, { values: [1, 9] })`)
    expect(m?.macro).toBe(true)
    expect(m?.name).toBe('fat')
  })

  it('offers nothing when the default is not one of the pair', () => {
    // the engine rejects this too, but a widget would be worse than the error:
    // it would offer a tap that writes a state the source cannot spell
    expect(scanSwitchesJs(`macro('x', 5, { values: [1, 9] })`)).toEqual([])
  })

  it('offers nothing for a non-literal value', () => {
    expect(scanSwitchesJs(`macro('x', 1, { values: [1, hi] })`)).toEqual([])
  })

  it('never yields a knob AND a switch for the same param', () => {
    // min/max default to 0..1 in the knob scanner, so before this was fixed a
    // switch grew a dial reading 0..1 as well, two controls over one value
    const code = compile('synth a\n  saw note\n  d = switch .2 .9\n  * d\n')
    expect(code.ok).toBe(true)
    if (!code.ok) return
    const sw = scanSwitchesJs(code.code)
    expect(sw).toHaveLength(1)
  })
})

/* ------------------------------------------------------------------------- *
 * Accidentals on degrees: `n('0 2# 4')`.
 *
 * A degree indexes a scale, so before this the only way to name a pitch the
 * scale does not contain was to abandon degree notation for note names. Worse,
 * the near-miss spelling was silent: `n('0 2.5 4')` ROUNDED to degree 3 rather
 * than failing, so a half-step looked like it worked and was not.
 *
 * The grid's rows are degrees, so an accidental note stays on its degree's row
 * and is MARKED. That is why steps and accs are separate arrays.
 * ------------------------------------------------------------------------- */
describe('accidental degrees in the piano roll', () => {
  it('reads the degree and the accidental apart, in rondo', () => {
    const src = 'synth a\n  saw note\n\nplay a\n  0 2# 4 3b\n  scale:c-maj\n'
    const [r] = scanPlays(src)
    expect(r?.steps).toEqual([0, 2, 4, 3])
    expect(r?.accs).toEqual([undefined, 1, undefined, -1])
  })

  it('reads the same notation the same way in JavaScript', () => {
    const [r] = scanPlaysJs(`p('a', n('0 2# 4 3b').scale('c major').sound('a'))`)
    expect(r?.steps).toEqual([0, 2, 4, 3])
    expect(r?.accs).toEqual([undefined, 1, undefined, -1])
  })

  it('spells a step back out with its accidental, so a drag cannot drop it', () => {
    expect(stepText(2, 1)).toBe('2#')
    expect(stepText(3, -1)).toBe('3b')
    expect(stepText(2, 2)).toBe('2##')
    expect(stepText(-1, -2)).toBe('-1bb')
    expect(stepText(4, undefined)).toBe('4')
    expect(stepText(null, 1)).toBe('~')
  })

  it('round-trips every step of a line unchanged', () => {
    // the property that matters: rewriting a line you did not edit must give
    // back the same text, or a stray drag rewrites notes you never touched
    const toks = '0 2# 4 ~ 3b -1 2##'.split(' ')
    const steps = toks.map((t) => (t === '~' ? null : Number(STEP_RE.exec(t)![1])))
    const accs = toks.map((t) => (t === '~' ? undefined : accValue(STEP_RE.exec(t)![2])))
    expect(steps.map((v, i) => stepText(v, accs[i])).join(' ')).toBe('0 2# 4 ~ 3b -1 2##')
  })

  it('does not mistake a sample name for an accidental', () => {
    // `2bd` is the number 2 and the word `bd`, not a flat and a stray d
    expect(STEP_RE.test('2bd')).toBe(false)
  })

  it('leaves a plain line with no accidentals at all', () => {
    const [r] = scanPlays('synth a\n  saw note\n\nplay a\n  0 3 5 7\n')
    expect(r?.accs).toEqual([undefined, undefined, undefined, undefined])
  })
})
