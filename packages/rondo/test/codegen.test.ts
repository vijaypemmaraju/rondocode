import { describe, expect, it } from 'vitest'
import { compile, decompile } from '../src/index'

/* ------------------------------------------------------------------------- *
 * The Switch: a knob with two fixed values instead of a range.
 *
 * It compiles to `param(name, a, { values: [a, b] })` — the SAME param a knob
 * emits — so setParam, MIDI mapping and both editor scanners need no new case.
 * The first value is the one it rests on, which is why the widget REORDERS the
 * pair on a tap rather than writing a third number.
 * ------------------------------------------------------------------------- */
const cg = (src: string): string => {
  const r = compile(src)
  if (!r.ok) throw new Error(JSON.stringify(r.errors))
  return r.code
}

describe('switch bindings', () => {
  it('emits a param with two values, resting on the first', () => {
    expect(cg('synth a\n  saw note\n  drive = switch .2 .9\n  * drive\n'))
      .toContain("param('drive', 0.2, { values: [0.2, 0.9] })")
  })

  it('keeps the pair in written order, because the order says which is active', () => {
    expect(cg('synth a\n  saw note\n  d = switch .9 .2\n  * d\n'))
      .toContain("param('d', 0.9, { values: [0.9, 0.2] })")
  })

  it('takes negative values, which the lexer folds as signs', () => {
    expect(cg('synth a\n  saw note\n  b = switch -1 1\n  * b\n'))
      .toContain("param('b', -1, { values: [-1, 1] })")
  })

  it('rejects two equal values at parse time, not at eval', () => {
    const r = compile('synth a\n  saw note\n  d = switch 1 1\n  * d\n')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0]!.message).toMatch(/two DIFFERENT values/)
  })

  it('says what is missing when a value is left off', () => {
    const r = compile('synth a\n  saw note\n  d = switch 1\n  * d\n')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0]!.message).toMatch(/second value/)
  })

  it('cannot be used inline, where there would be no name to bind', () => {
    const r = compile('synth a\n  saw note\n  * switch 1 9\n')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0]!.message).toMatch(/only appear on a binding/)
  })
})

describe('switch macros', () => {
  it('registers through the SAME macro registry a ranged macro uses', () => {
    // a switch macro is still one control reaching every destination that
    // names it; only its shape differs
    expect(cg('switch fat 1 9\n\nsynth a\n  saw note\n  * fat / 9\n'))
      .toContain("macro('fat', 1, { values: [1, 9] })")
  })

  it('reaches a use site as a bare name, exactly like a ranged macro', () => {
    expect(cg('switch fat 1 9\n\nsynth a\n  saw note\n  * fat / 9\n'))
      .toContain("param('fat')")
  })

  it('refuses a range or a curve, rather than ignoring them', () => {
    const r = compile('switch fat 1 9 log\n\nsynth a\n  saw note\n')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0]!.message).toMatch(/exactly two values/)
  })

  it('rejects a switch with no name', () => {
    const r = compile('switch 1 9\n\nsynth a\n  saw note\n')
    expect(r.ok).toBe(false)
  })
})

describe('switch round-trips', () => {
  const roundtrip = (src: string): string => decompile(cg(src))

  it('comes back as a switch, not as a knob with an invented range', () => {
    // the failure this guards: omitted min/max default to 0..1 in the knob
    // path, so a switch that fell through would decompile to `knob 0.2 0..1`
    // -- silently a different control
    expect(roundtrip('synth a\n  saw note\n  d = switch .2 .9\n  * d\n'))
      .toContain('d = switch 0.2 0.9')
  })

  it('brings a switch macro back as a top-level switch', () => {
    expect(roundtrip('switch fat 1 9\n\nsynth a\n  saw note\n  * fat / 9\n'))
      .toContain('switch fat 1 9')
  })

  it('keeps a hand-written JS switch as JS when rondo cannot say it', () => {
    // a default that is not one of the pair has no `switch` spelling; it must
    // stay JavaScript rather than round-trip into something else
    expect(decompile("macro('x', 5, { values: [1, 9] })")).toContain('js')
  })
})

/* ------------------------------------------------------------------------- *
 * The pump was the one project control a macro could not reach.
 *
 * `sidechain` took `name:number` pairs only, so the most obvious thing to want
 * to switch off — the ducking — could not follow a switch. It now accepts a
 * bare macro name wherever it accepts a number.
 *
 * It resolves through macroNum(), not macroval(): sidechain() captures its
 * duck depth as a plain number at eval, it does not read a signal per sample.
 * That is exactly right for a switch, whose tap rewrites the source and
 * re-evals; a knob mid-drag will not move the pump until the drag ends.
 * ------------------------------------------------------------------------- */
describe('sidechain follows a project control', () => {
  const drums = (line: string): string =>
    cg(`switch drums 1 0\n\nsynth kick\n  sine 60\n\nsynth lead\n  saw note\n\nplay kick\n  c2 c2\n\nplay lead\n  0 3\n\n${line}\n\ncps .5\n`)

  it('reads a bare name as a macro for depth', () => {
    expect(drums('sidechain kick depth:drums')).toContain("depth: macroNum('drums')")
  })

  it('does the same for release and for a per-channel duck', () => {
    const out = drums('sidechain kick depth:.9 release:drums lead:drums')
    expect(out).toContain("release: macroNum('drums')")
    expect(out).toContain("lead: macroNum('drums')")
  })

  it('still takes plain numbers, unchanged', () => {
    expect(drums('sidechain kick depth:.99 release:.5 lead:.6'))
      .toContain("sidechain('kick', { depth: 0.99, release: 0.5, duck: { lead: 0.6 } })")
  })

  it('round-trips back to the bare name, not to macroNum(…)', () => {
    expect(decompile(drums('sidechain kick depth:drums release:.5')))
      .toContain('sidechain kick depth:drums release:0.5')
  })

  it('keeps a hand-written JS sidechain as JS when rondo cannot say it', () => {
    // an expression is not a name, so there is no bare-word spelling for it
    expect(decompile("sidechain('kick', { depth: x * 2 })")).toContain('js')
  })
})
