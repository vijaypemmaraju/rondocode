import { describe, expect, it } from 'vitest'
import { compile } from '@rondocode/rondo'
import { stageCode, runPatterns, renderMix, mixOptsFor } from '../../server/src/render-runner'
import { RECIPES } from '../src/docs/cookbook'
import { EXAMPLES } from '../src/examples'

/* ------------------------------------------------------------------------- *
 * The harmoniser recipe CLAIMS a fifth above every note. A test that only
 * checked it renders would pass with `pitchshift` doing nothing at all — and
 * `pitchshift` is bit-exact at 0 semitones, so "does nothing" is a real
 * failure mode a typo could produce silently.
 *
 * So this measures the claim: the shifted pitch has to actually be in the
 * audio, at the interval the prose promises.
 * ------------------------------------------------------------------------- */

const sr = 48000

/** Goertzel magnitude of `hz` in a buffer. */
function mag(buf: Float32Array, hz: number): number {
  const w = (2 * Math.PI * hz) / sr
  const coeff = 2 * Math.cos(w)
  let s1 = 0, s2 = 0
  for (let i = 0; i < buf.length; i++) {
    const s = buf[i]! + coeff * s1 - s2
    s2 = s1
    s1 = s
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2) / buf.length
}

/** Render a rondo program's first half-second of audio. */
function render(rondo: string): Float32Array {
  const c = compile(rondo)
  expect(c.ok, 'the program does not compile').toBe(true)
  const st = stageCode(c.code!)
  expect(st.ok, 'the program does not stage').toBe(true)
  const cps = st.cps ?? 0.5
  const evs = runPatterns(st.patterns, { cycles: 1, cps })
  return renderMix(st.synths, evs, 1 / cps, mixOptsFor(st, { cps, sampleRate: sr })).left
}

describe('the harmoniser recipe really harmonises', () => {
  const recipe = RECIPES.find((r) => r.id === 'harmoniser')

  it('ships', () => {
    expect(recipe, 'the harmoniser recipe is gone').toBeDefined()
  })

  it('puts a FIFTH above the played note into the audio', () => {
    /* The line starts on scale degree 0 of A minor, which the pattern engine
     * renders as MIDI 57 — A3, 220 Hz. Seven semitones above is 329.6. */
    const out = render(recipe!.code)
    const win = out.subarray(Math.round(sr * 0.05), Math.round(sr * 0.22))
    const root = mag(win, 220)
    const fifth = mag(win, 329.6)
    const nothing = mag(win, 265) // between the two, and in neither

    expect(root, 'the original note is missing').toBeGreaterThan(nothing * 3)
    expect(fifth, 'no fifth was added — pitchshift did nothing').toBeGreaterThan(nothing * 3)
  })

  it('keeps the original UNDER it, which is what mix < 1 buys', () => {
    // at mix 1 the part would simply be transposed and the root would vanish
    const out = render(recipe!.code)
    const win = out.subarray(Math.round(sr * 0.05), Math.round(sr * 0.22))
    expect(mag(win, 220), 'the root was replaced, not harmonised')
      .toBeGreaterThan(mag(win, 329.6))
  })
})

describe('the harmoniser example', () => {
  const ex = EXAMPLES.find((e) => e.name === 'harmoniser')

  it('ships and compiles', () => {
    expect(ex, 'the harmoniser example is gone').toBeDefined()
    expect(compile(ex!.rondo!).ok).toBe(true)
  })

  it('makes sound, and carries the harmony too', () => {
    const out = render(ex!.rondo!)
    let peak = 0
    for (const v of out) peak = Math.max(peak, Math.abs(v))
    expect(peak, 'rendered silence').toBeGreaterThan(0.001)
    const win = out.subarray(Math.round(sr * 0.05), Math.round(sr * 0.22))
    expect(mag(win, 329.6), 'no fifth in the example').toBeGreaterThan(mag(win, 265) * 3)
  })
})
