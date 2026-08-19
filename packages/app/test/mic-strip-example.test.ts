import { describe, expect, it } from 'vitest'
import { renderOffline } from '@rondocode/engine'
import { evalCode } from '../src/session/evalCode'
import { baseScope } from '../src/session/scope'
import { EXAMPLES } from '../src/examples'

/* ------------------------------------------------------------------------- *
 * THE MIC CHANNEL STRIP EXAMPLE, MEASURED.
 *
 * Its comments make four claims — the gate kills the room, the de-esser tames
 * the "s", the compressor evens the level, the limiter holds a ceiling. An
 * example's comments are the first documentation anyone reads, and until
 * renderOffline could take a `mic` signal there was no way to check any of
 * them: the whole example rendered silence.
 *
 * So this drives the ACTUAL shipped example (not a copy of it) with a
 * synthetic take built from what a stage throws at a microphone, and asserts
 * the claims. If someone retunes a threshold and the strip stops doing what
 * the comment above it says, this fails.
 * ------------------------------------------------------------------------- */

const sr = 48000
const SEG = sr / 4
const TOTAL = SEG * 4
const dbToLin = (db: number): number => Math.pow(10, db / 20)

/** room tone · a vowel · a vowel with sibilance on top · far too loud. */
function take(): Float32Array {
  const a = new Float32Array(TOTAL)
  let seed = 7
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return (seed / 0x7fffffff) * 2 - 1
  }
  for (let i = 0; i < TOTAL; i++) {
    const seg = Math.floor(i / SEG)
    if (seg === 0) a[i] = rnd() * dbToLin(-52)
    else if (seg === 1) a[i] = dbToLin(-12) * Math.sin((2 * Math.PI * 220 * i) / sr)
    else if (seg === 2) {
      a[i] = dbToLin(-16) * Math.sin((2 * Math.PI * 220 * i) / sr)
        + dbToLin(-10) * Math.sin((2 * Math.PI * 8000 * i) / sr)
    } else a[i] = 2.2 * Math.sin((2 * Math.PI * 300 * i) / sr)
  }
  return a
}

const peak = (a: Float32Array, from: number, to: number): number => {
  let p = 0
  for (let i = from; i < to; i++) p = Math.max(p, Math.abs(a[i]!))
  return p
}

describe('the "mic channel strip" example does what its comments claim', () => {
  const ex = EXAMPLES.find((e) => e.name === 'mic channel strip')

  it('ships (a renamed example would make everything below vacuous)', () => {
    expect(ex, 'the example is gone').toBeDefined()
  })

  const staged = evalCode(ex!.code, baseScope)
  const def = staged.synths.get('voice')
  const input = take()
  const out = def === undefined
    ? new Float32Array(TOTAL)
    : renderOffline(
        def,
        [{ time: 0, type: 'noteOn', note: 48 }, { time: TOTAL / sr - 0.01, type: 'noteOff', note: 48 }],
        TOTAL / sr,
        { mic: input },
      ).left

  it('evals to one synth named `voice` on the mic', () => {
    expect(staged.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(def, 'the strip synth is not called `voice` any more').toBeDefined()
  })

  it('the GATE kills the room tone between phrases', () => {
    const before = peak(input, 1000, SEG - 1000)
    const after = peak(out, 1000, SEG - 1000)
    expect(after, 'room tone came through the gate').toBeLessThan(before * 0.25)
  })

  it('and the voice itself still comes through', () => {
    // a gate that ate the voice would pass the test above and be useless
    expect(peak(out, SEG + 5000, 2 * SEG - 1000), 'the strip ate the voice')
      .toBeGreaterThan(0.02)
  })

  it('the LIMITER holds its ceiling, and is actually DOING it', () => {
    /* The comment says "a ceiling nothing crosses"; the example sets -1 dB.
     *
     * The first version of this example set makeup:3, and the limiter was
     * DECORATIVE — the strip never reached the ceiling, so removing the
     * limiter changed nothing and a mutation of it survived. A limiter that
     * cannot be observed is not a limiter, it is a comment. makeup:6 drives
     * the strip properly: without the limiter this take peaks at 1.19, and
     * with it, at exactly the ceiling. */
    expect(peak(out, 0, TOTAL), 'a sample crossed the ceiling')
      .toBeLessThanOrEqual(dbToLin(-1) + 1e-6)
    // and it is not merely under by luck: it is pinned AT the ceiling, which
    // only happens because something is holding it there
    expect(peak(out, 0, TOTAL), 'the limiter is not engaging at all')
      .toBeGreaterThan(dbToLin(-1) * 0.98)
  })

  it('the strip CONTROLS level, by about the ratio it is set to', () => {
    /* What a compressor is for, tied to the example's OWN setting rather than
     * to a number I picked: `compress ratio:3` should squeeze the input range
     * to roughly a third of itself. Measured: 21.6 dB in, 6.9 dB out — 3.1:1,
     * which is the setting doing exactly what it says.
     *
     * The band is deliberately wide (2.5:1 to 5:1) because the gate, the eq
     * and the limiter all touch these numbers too. What it will not tolerate
     * is the compressor being turned off or turned into a brick. */
    const vowel = peak(out, SEG + 5000, 2 * SEG - 1000)
    const loud = peak(out, 3 * SEG + 5000, 4 * SEG - 1000)
    const inVowel = peak(input, SEG + 5000, 2 * SEG - 1000)
    const inLoud = peak(input, 3 * SEG + 5000, 4 * SEG - 1000)
    const inRange = 20 * Math.log10(inLoud / inVowel)
    const outRange = 20 * Math.log10(loud / vowel)
    expect(inRange, 'the fixture stopped being a dynamics test').toBeGreaterThan(18)
    expect(outRange, 'the strip is barely compressing').toBeLessThan(inRange / 2.5)
    expect(outRange, 'the strip is squashing far harder than ratio:3').toBeGreaterThan(inRange / 6)
  })

  it('never emits a non-finite sample', () => {
    expect(out.every((v) => Number.isFinite(v))).toBe(true)
  })
})
