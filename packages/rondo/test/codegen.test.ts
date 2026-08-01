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

describe('accidental degrees pick n(), not note()', () => {
  it('a flattened degree does not flip the line to note names', () => {
    // `3b` contains a `b`, and the note-name heuristic used to take that as
    // the note B — flipping the whole line to note(), which then read `0` as a
    // note name and IGNORED the scale, silently, because note() accepts a
    // .scale() call and does nothing with it
    expect(cg('synth a\n  saw note\n\nplay a\n  0 2# 4 3b\n  scale:c-maj\n\ncps .5\n'))
      .toContain("n('0 2# 4 3b').scale('c major')")
  })

  it('still picks note() for real note names', () => {
    expect(cg('synth a\n  saw note\n\nplay a\n  c4 e4 g4\n\ncps .5\n')).toContain("note('c4 e4 g4')")
  })

  it('still picks chord() for an uppercase root', () => {
    expect(cg('synth a\n  saw note\n\nplay a\n  Am F C G\n\ncps .5\n')).toContain('chord(')
  })

  it('round-trips the accidentals back into the rondo line', () => {
    expect(decompile(cg('synth a\n  saw note\n\nplay a\n  0 2# 4 3b\n  scale:c-maj\n\ncps .5\n')))
      .toContain('0 2# 4 3b')
  })
})

/* ------------------------------------------------------------------------- *
 * Unknown names are a rondo error, at a rondo position.
 *
 * Asked whether one synth can feed another. `vocoder pad bands:32` COMPILED —
 * rondo emitted any bare identifier as a raw JavaScript reference, so `pad`
 * became the SynthDef object and the engine said "expected a Sig or number,
 * got object ([object Object])". A JavaScript complaint about a rondo
 * mistake, with no line to point at.
 *
 * The same hole swallowed every typo: `envv` became `envv is not defined`.
 * ------------------------------------------------------------------------- */
describe('names are checked where they are written', () => {
  const err = (src: string): string => {
    const r = compile(src)
    expect(r.ok, 'expected a compile error').toBe(false)
    return r.ok ? '' : r.errors[0]!.message
  }

  it('says a synth is not a signal, and what to do instead', () => {
    // the reason is structural, not a typo: a synth runs per VOICE, so there
    // is no single output for a line to read
    const m = err('synth pad\n  supersaw note\n\nsynth x\n  vocoder pad bands:32\n')
    expect(m).toMatch(/`pad` is a synth, not a signal/)
    expect(m).toMatch(/per voice/i)
    expect(m).toMatch(/bus/)
  })

  it('catches a typo in a binding name and suggests the binding', () => {
    expect(err('synth x\n  saw note\n  * envv\n  env = adsr .01 .1 .5 .1\n'))
      .toMatch(/unknown name `envv`.*did you mean `env`\?/)
  })

  it('reports an unknown name with no near miss, without inventing one', () => {
    const m = err('synth x\n  saw note\n  * zzz\n')
    expect(m).toMatch(/unknown name `zzz`/)
    expect(m).not.toMatch(/did you mean/)
  })

  it('points at the name, not at the block', () => {
    const r = compile('synth x\n  saw note\n  * zzz\n')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]!.line).toBe(3)
  })

  it('leaves the js{ } escape hatch alone — its names are in scope', () => {
    // checking unknown names has to know about the escape hatch, or the
    // escape hatch stops working
    expect(compile('js\n  const boost = 3\n\nsynth x\n  saw note\n  * boost\n').ok).toBe(true)
  })

  it('still accepts macros, bindings and the implicit signals', () => {
    expect(compile('macro b 1 0..2\n\nsynth x\n  saw note\n  * b\n').ok).toBe(true)
    expect(compile('synth x\n  saw note\n  * e\n  e = adsr .01 .1 .5 .1\n').ok).toBe(true)
    expect(compile('synth x\n  saw note\n  * velocity\n').ok).toBe(true)
  })
})

/* ------------------------------------------------------------------------- *
 * Round trips: an example that cannot come back is only half a language.
 *
 * Five of the eighteen programs in the docs decompiled to a `js{ }` blob, so
 * a JavaScript reader of the cookbook got a degraded version of nearly a
 * third of it. This is the first of those gaps.
 * ------------------------------------------------------------------------- */
describe('an operator after adsr round-trips', () => {
  const rt = (rhs: string): string => {
    const r = compile(`synth a\n  saw note\n  * x\n  x = ${rhs}\n\nplay a\n  0\n\ncps .5\n`)
    expect(r.ok, r.ok ? '' : JSON.stringify(r.errors)).toBe(true)
    return r.ok ? decompile(r.code) : ''
  }

  it('brings back `^ n -> lo..hi`, which used to be a js block', () => {
    // the kick-drop idiom, in two docs programs
    expect(rt('adsr .001 .09 0 .05 ^ 3 -> 48..190')).toContain('x = adsr 0.001 0.09 0 0.05 ^ 3 -> 48..190')
  })

  it('brings back the other operators too', () => {
    expect(rt('adsr .01 .1 .5 .1 * 2')).toContain('* 2')
    expect(rt('adsr .01 .1 .5 .1 + 1')).toContain('+ 1')
  })

  it('still binds the operator to the CALL, not the last positional', () => {
    // what makes closing adsr safe: its arity is fixed at four, so the parser
    // finishes the call before reading the operator
    const c = compile('synth a\n  saw note\n  * x\n  x = adsr .001 .09 0 .05 ^ 3\n\nplay a\n  0\n\ncps .5\n')
    expect(c.ok).toBe(true)
    if (!c.ok) return
    expect(c.code).toContain('r: 0.05 }).pow(3)')
  })
})

describe('a macro driving a pattern control round-trips', () => {
  const rt = (mod: string): string => {
    const r = compile(`macro bright 1400 300..7000 log\n\nsynth a\n  saw note\n  * adsr .01 .1 .5 .1\n\nplay a\n  0 3\n  ${mod}\n\ncps .5\n`)
    expect(r.ok, r.ok ? '' : JSON.stringify(r.errors)).toBe(true)
    return r.ok ? decompile(r.code) : ''
  }

  it('brings back arithmetic on the macro, not a js block', () => {
    // `gain: bright / 9000 + .5` compiles to
    // .gain(macroval('bright').div(9000).add(0.5)); nothing brought it back,
    // so the one-knob recipe -- the case the feature exists for -- degraded
    expect(rt('gain: bright / 9000 + .5')).toContain('gain: bright / 9000 + 0.5')
  })

  it('handles the bare macro and each operator', () => {
    expect(rt('gain: bright')).toContain('gain: bright')
    expect(rt('dur: bright / 2')).toContain('dur: bright / 2')
    expect(rt('pan: bright * 0.5')).toContain('pan: bright * 0.5')
  })

  it('refuses a shape that would not re-parse the same way', () => {
    // a modifier value has no parentheses, so anything needing them must stay
    // JavaScript rather than come back as something subtly different
    const r = compile('macro b 1 0..2\n\nsynth a\n  saw note\n\nplay a\n  0\n\ncps .5\n')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const withParens = r.code.replace("p('a', n('0').sound('a'))", "p('a', n('0').sound('a').gain(macroval('b').add(1).mul(2)))")
    expect(decompile(withParens)).toContain('js')
  })
})
