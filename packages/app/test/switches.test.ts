import { describe, expect, it } from 'vitest'
import { compile } from '@rondocode/rondo'
import { scanSwitches, toggled } from '../src/editor/rondo/switches'
import { scanSwitchesJs } from '../src/editor/widgets/jsscan'
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
