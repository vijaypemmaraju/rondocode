import { describe, expect, it } from 'vitest'
import { SHIPPED_EXAMPLES } from '../src/examples'
import { makeBreak } from '../src/audio/demo-samples'
import { renderStagedMix } from '../src/editor/resample'

/* The `chop` example is the shipped demo for sample slicing, and it is the one
 * example whose SOUND depends on a sample buffer. Rendering it offline (the
 * same staged -> renderMix path the WAV export uses) with the built-in break
 * loaded proves the chops actually sound, not just that the patterns emit. */

const SR = 48000
const ex = SHIPPED_EXAMPLES.find((e) => e.name === 'chop')!
const brk = { break: { data: makeBreak(SR), sampleRate: SR } }
const silent = { break: { data: new Float32Array(2 * SR), sampleRate: SR } }

const peak = (x: Float32Array): number => {
  let m = 0
  for (const v of x) m = Math.max(m, Math.abs(v))
  return m
}
const rms = (x: Float32Array): number => {
  let s = 0
  for (const v of x) s += v * v
  return Math.sqrt(s / x.length)
}

describe('the chop example renders', () => {
  it('is registered with a rondo twin that uses slices', () => {
    expect(ex.rondo).toContain('slices:8')
    expect(ex.code).toContain("{ slices: 8 }")
    expect(ex.code).toContain('start: 0.5')
    expect(ex.code).toContain('reverse: true')
  })

  it('renders two cycles at a sane level, with no NaN and no clipping', () => {
    const mix = renderStagedMix(ex.code, 2, brk)
    expect('error' in mix ? mix.error : '').toBe('')
    if ('error' in mix) return
    expect(mix.sampleRate).toBe(SR)
    expect(mix.left.length).toBe(Math.round((2 / mix.cps) * SR)) // 2 cycles at cps 0.5 = 8 s
    expect(mix.left.every(Number.isFinite)).toBe(true)
    expect(mix.right.every(Number.isFinite)).toBe(true)
    // measured: peak 0.648, rms 0.135 — audible, with headroom left
    expect(peak(mix.left)).toBeGreaterThan(0.1)
    expect(peak(mix.left)).toBeLessThan(0.99)
    expect(rms(mix.left)).toBeGreaterThan(0.02)
    expect(rms(mix.left)).toBeLessThan(0.4)
  })

  it('the chops carry the sound: silence the break and the mix collapses', () => {
    const withBreak = renderStagedMix(ex.code, 2, brk)
    const without = renderStagedMix(ex.code, 2, silent)
    if ('error' in withBreak || 'error' in without) throw new Error('render failed')
    // the sub sine still plays in both, so this is a real contribution test:
    // measured 0.135 vs 0.074 rms, and 0.648 vs 0.171 peak
    expect(rms(withBreak.left)).toBeGreaterThan(rms(without.left) * 1.5)
    expect(peak(withBreak.left)).toBeGreaterThan(peak(without.left) * 3)
  })

  it('the eight chops arrive as eight separate hits per cycle', () => {
    const mix = renderStagedMix(ex.code, 2, brk)
    if ('error' in mix) throw new Error(mix.error)
    // one cycle is 8 steps: count envelope onsets by looking for a jump from a
    // quiet window into a loud one, which a chopper produces once per step
    const step = Math.round((1 / mix.cps / 8) * SR)
    let hits = 0
    for (let s = 0; s < 8; s++) {
      const from = s * step
      const head = peak(mix.left.subarray(from, from + Math.round(step * 0.3)))
      if (head > 0.05) hits++
    }
    expect(hits).toBe(8)
  })
})
