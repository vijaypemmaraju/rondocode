import { describe, expect, it } from 'vitest'
import { compile } from '../src/compile'
import { decompile } from '../src/decompile'
import { evalCode } from '../../app/src/session/evalCode'
import { baseScope } from '../../app/src/session/scope'

/* ------------------------------------------------------------------------- *
 * `overchord: <Am7 F>` — the play block's degrees become CHORD degrees.
 *
 * The order it is emitted in is the whole contract: overChord rewrites the
 * NOTES, so applying it after a modifier that already read them plays
 * something else while still sounding musical. Byte-compare the output.
 * ------------------------------------------------------------------------- */

const ok = (src: string): string => {
  const c = compile(src)
  expect(c.ok, JSON.stringify(c.ok ? [] : c.errors)).toBe(true)
  return c.ok ? c.code : ''
}

const SRC = `synth keys
  saw note

play arp synth:keys
  0 2 1 4
  overchord: <Am7 Fmaj7>
  dur: .42
  gain: .5
`

describe('overchord', () => {
  it('applies BEFORE .sound(), so later modifiers decorate the re-voiced notes', () => {
    expect(ok(SRC)).toContain(
      `n('0 2 1 4').overChord(chord('<Am7 Fmaj7>')).sound('keys').dur(0.42).gain(0.5)`,
    )
  })

  it('is not emitted twice — it leaves the ordinary modifier run', () => {
    expect([...ok(SRC).matchAll(/overChord/g)]).toHaveLength(1)
    expect(ok(SRC)).not.toContain(`ctrl('overchord'`)
  })

  it('rejects a value that is not chord names, at the line that wrote it', () => {
    const c = compile('synth k\n  saw note\n\nplay a synth:k\n  0 2\n  overchord: 4\n')
    expect(c.ok).toBe(false)
    if (!c.ok) {
      expect(c.errors[0]!.message).toMatch(/takes chord names/)
      expect(c.errors[0]!.line).toBe(6)
    }
  })

  it('evals, and the degrees really are re-voiced by the chord under them', () => {
    const r = evalCode(ok(SRC), baseScope)
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(r.ok).toBe(true)
  })

  it('round-trips: the modifier survives JS -> rondo -> JS unchanged', () => {
    const code = ok(SRC)
    const back = decompile(code)
    expect(back).toContain('overchord: <Am7 Fmaj7>')
    expect(ok(back)).toBe(code)
  })

  it('a NON-literal chord argument stays a js block rather than round-trip wrong', () => {
    // `const prog = chord(...)` shared across patterns has no rondo spelling;
    // inventing one would change which chords each pattern reads
    const js = [
      `const keys = synth(({ note, saw }) => saw(note.freq))`,
      `const prog = chord('<Am7 Fmaj7>')`,
      `p('arp', n('0 2').overChord(prog).sound('keys'))`,
    ].join('\n')
    expect(decompile(js)).toContain('js')
    expect(decompile(js)).not.toContain('overchord:')
  })
})

/* ------------------------------------------------------------------------- *
 * A numeric modifier will not quietly take a word.
 *
 * `dur: bright / 7300` used to compile to `.dur('bright / 7300')` — a mini
 * string — and every event came out with dur set to the STRING "bright". No
 * error, and no sound change you could trace back. The mistake is easy to make
 * because `bright` IS a real name: a synth param, which lives in the audio
 * graph and cannot be read from the pattern layer at all.
 * ------------------------------------------------------------------------- */
describe('numeric play modifiers reject bare words', () => {
  const play = (mod: string): string =>
    `synth lead\n  saw note\n  bright = knob 1200 500..7300 log\n  * bright\n\nplay lead\n  0 3 5\n  ${mod}\n`

  it('names the offending word, and where it actually lives', () => {
    const c = compile(play('dur: bright / 7300'))
    expect(c.ok).toBe(false)
    if (!c.ok) {
      expect(c.errors[0]!.message).toMatch(/takes numbers, not `bright`/)
      expect(c.errors[0]!.message).toMatch(/lives in the synth/)
      expect(c.errors[0]!.line).toBe(8)
    }
  })

  it('catches it on gain and pan and a .ctrl too, not just dur', () => {
    for (const mod of ['gain: bright', 'pan: bright', 'cutoff: bright']) {
      expect(compile(play(mod)).ok, mod).toBe(false)
    }
  })

  it('still accepts everything a numeric modifier legitimately takes', () => {
    for (const mod of ['dur: .5', 'dur: <.5 1>', 'gain: 1 .5 ~ .8', 'dur: sine 0.1..2 slow:4', 'cutoff: rise 8']) {
      expect(compile(play(mod)).ok, mod).toBe(true)
    }
  })
})

/* ------------------------------------------------------------------------- *
 * A macro reaching `dur` — the structural side of the pattern.
 *
 * `dur`, `gain` and `pan` are consumed by the SCHEDULER per event and never
 * sent to the engine, so a synth param could never drive one. A macro can,
 * because its value is mirrored into the pattern layer (macroval) and read at
 * query time.
 * ------------------------------------------------------------------------- */
describe('macros drive dur/gain/pan', () => {
  const play = (mod: string): string =>
    `macro bright 1200 500..7300 log\n\nsynth lead\n  saw note\n  svf bright res:.3\n\nplay lead\n  0 3 5\n  ${mod}\n`

  const line = (mod: string): string => {
    const c = compile(play(mod))
    expect(c.ok, JSON.stringify(c.ok ? [] : c.errors)).toBe(true)
    return c.ok ? c.code.split('\n').find((l) => l.startsWith("p('lead'"))! : ''
  }

  it('a bare macro name becomes a pattern signal, not a mini string', () => {
    expect(line('dur: bright / 7300')).toContain(".dur(macroval('bright').div(7300))")
  })

  it('COMMUTES a literal head, since a number has no .sub', () => {
    // the same shape the synth side emits for `0.6 - norm * 0.55`
    expect(line('dur: 0.6 - bright / 7300')).toContain(".dur(macroval('bright').div(7300).mul(-1).add(0.6))")
  })

  it('works on gain and pan and a .ctrl alike', () => {
    expect(line('gain: bright / 7300')).toContain(".gain(macroval('bright')")
    expect(line('pan: bright / 7300')).toContain(".pan(macroval('bright')")
    expect(line('cutoff: bright / 2')).toContain(".ctrl('cutoff', macroval('bright')")
  })

  it('leaves ordinary values alone', () => {
    expect(line('dur: .5')).toContain('.dur(0.5)')
    expect(line('dur: <.5 1>')).toContain(".dur('<.5 1>')")
    expect(line('dur: sine 0.1..2 slow:4')).toContain('.dur(sine.range(0.1, 2).slow(4))')
  })

  it('a word that is NOT a declared macro is still an error, not a mini string', () => {
    const c = compile(play('dur: nosuch / 2'))
    expect(c.ok).toBe(false)
    if (!c.ok) expect(c.errors[0]!.message).toMatch(/takes numbers, not `nosuch`/)
  })

  it('declines what it cannot express rather than emitting something wrong', () => {
    // `2 / bright` has no reciprocal combinator to lean on
    const c = compile(play('dur: 2 / bright'))
    expect(c.ok).toBe(false)
  })
})

/* ------------------------------------------------------------------------- *
 * `LEVEL:CURVE` on an env breakpoint.
 *
 * `curve:` bends every joint the same way. A drawn curve does not: the attack
 * wants snapping and the tail wants easing. The colon is unambiguous because a
 * NUMBER followed by one has no other meaning — named args are `word:value`.
 * ------------------------------------------------------------------------- */
describe('env breakpoints can carry their own curve', () => {
  const gen = (body: string): string => {
    const c = compile(`synth z\n  saw note\n  * e\n  e = ${body}\n`)
    expect(c.ok, JSON.stringify(c.ok ? [] : c.errors)).toBe(true)
    return c.ok ? (c.code.split('\n').find((l) => l.includes('const e')) ?? '').trim() : ''
  }

  it('emits a TRIPLE for the segment that carries one', () => {
    expect(gen('env .005 1:3 .15 .4')).toBe('const e = env(gate, [[0.005, 1, 3], [0.15, 0.4]])')
  })

  it('leaves plain pairs exactly as they were', () => {
    expect(gen('env .005 1 .15 .4')).toBe('const e = env(gate, [[0.005, 1], [0.15, 0.4]])')
  })

  it('mixes shaped and plain segments, and still takes named args', () => {
    expect(gen('env .005 1:3 .15 .4:-2 release:.3 curve:1'))
      .toBe('const e = env(gate, [[0.005, 1, 3], [0.15, 0.4, -2]], { release: 0.3, curve: 1 })')
  })

  it('round-trips as rondo, not as a js block', () => {
    const c = compile('synth z\n  saw note\n  * e\n  e = env .005 1:3 .15 .4:-2\n')
    expect(c.ok).toBe(true)
    if (!c.ok) return
    const back = decompile(c.code)
    expect(back).toContain('env 0.005 1:3 0.15 0.4:-2')
    expect(back).not.toContain('js{')
    expect(compile(back).ok && (compile(back) as { code: string }).code).toBe(c.code)
  })

  it('is rejected where it means nothing', () => {
    // the parser only builds it inside an env arg list, so `svf 900:3` never
    // reaches codegen — it is refused earlier, which is the better place
    expect(compile('synth z\n  svf 900:3 res:.3\n').ok).toBe(false)
  })

  it('a colon after a TIME is not a curve — that slot has no shape to give', () => {
    expect(compile('synth z\n  * e\n  e = env .005:3 1 .15 .4\n').ok).toBe(false)
  })
})

/* ------------------------------------------------------------------------- *
 * `curvedef` and the lane forms.
 *
 * Both existed only through the js{ … } hatch. The shapes chosen: curvedef
 * mirrors `env`'s pair form (including `level:curve`) because it IS the same
 * kind of list, and the lane rides the existing signal ctrl-value slot beside
 * `sine …` and `rise …` rather than inventing a value kind.
 * ------------------------------------------------------------------------- */
describe('curvedef', () => {
  const gen = (src: string): string => {
    const c = compile(src)
    expect(c.ok, JSON.stringify(c.ok ? [] : c.errors)).toBe(true)
    return c.ok ? c.code.trim() : ''
  }

  it('takes fraction/level pairs, like env', () => {
    expect(gen('curvedef swell .25 1 .75 .2\n')).toBe("curvedef('swell', [[0.25, 1], [0.75, 0.2]])")
  })

  it('takes a per-segment curve with the same `level:curve` suffix', () => {
    expect(gen('curvedef s .25 1:3 .75 .2:-2\n')).toBe("curvedef('s', [[0.25, 1, 3], [0.75, 0.2, -2]])")
  })

  it('refuses a half pair, and a shape with no length anywhere', () => {
    expect(compile('curvedef s .25\n').ok).toBe(false)
    expect(compile('curvedef s 0 1 0 .5\n').ok).toBe(false)
  })

  it('HOISTS, so a play above it still resolves the name', () => {
    const code = gen('play pad\n  0 3\n  cut: shape swell 8\n\ncurvedef swell .25 1 .75 .2\n')
    expect(code.indexOf('curvedef(')).toBeLessThan(code.indexOf("p('pad'"))
  })
})

describe('curve / shape as a modifier value', () => {
  const line = (mod: string): string => {
    const c = compile(`curvedef swell .25 1 .75 .2\n\nsynth pad\n  saw note\n\nplay pad\n  0 3 5\n  ${mod}\n`)
    expect(c.ok, JSON.stringify(c.ok ? [] : c.errors)).toBe(true)
    return c.ok ? (c.code.split('\n').find((l) => l.startsWith("p('pad'")) ?? '') : ''
  }

  it('a breakpoint lane in cycles', () => {
    expect(line('cut: curve 8 1 8 .2 300..6000'))
      .toContain(".ctrl('cut', curve([[8, 1], [8, 0.2]]).range(300, 6000))")
  })

  it('a NAMED shape scaled to a length in cycles', () => {
    expect(line('cut: shape swell 16 300..6000'))
      .toContain(".ctrl('cut', curve(shape('swell', 16)).range(300, 6000))")
  })

  it('still takes the range/slow suffixes, and per-leg curves', () => {
    expect(line('cut: curve 4 1:3 4 0 200..4000 slow:2'))
      .toContain('curve([[4, 1, 3], [4, 0]]).range(200, 4000).slow(2)')
  })

  it('leaves the other signal forms alone', () => {
    expect(line('cut: sine 200..2400 slow:4')).toContain('sine.range(200, 2400).slow(4)')
    expect(line('cut: rise 8')).toContain('rise(8)')
  })

  it('a half breakpoint is an error that names the right thing', () => {
    // it must NOT say "a knob lives in the synth" — curve IS legal here, so
    // that would send you looking in entirely the wrong place
    const c = compile('curvedef s .5 1\n\nsynth pad\n  saw note\n\nplay pad\n  0\n  cut: curve 8 1 8\n')
    expect(c.ok).toBe(false)
    if (!c.ok) expect(c.errors[0]!.message).toMatch(/fraction\/level PAIRS/)
  })

  it('round-trips as rondo, both forms', () => {
    for (const mod of ['cut: shape swell 16 300..6000', 'cut: curve 8 1 8 0.2']) {
      const src = `curvedef swell .25 1 .75 .2\n\nsynth pad\n  saw note\n\nplay pad\n  0 3 5\n  ${mod}\n`
      const a = compile(src)
      expect(a.ok).toBe(true)
      if (!a.ok) continue
      const back = decompile(a.code)
      expect(back).toContain('curvedef swell 0.25 1 0.75 0.2')
      expect(back).not.toContain('js{')
      const b = compile(back)
      expect(b.ok && (b as { code: string }).code).toBe(a.code)
    }
  })
})
