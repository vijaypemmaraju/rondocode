import { afterEach, describe, expect, it } from 'vitest'
import { WAVETABLE_WARPS, WavetableKernel, clearCustomWavetables, defineWavetable } from '@rondocode/engine'
import type { DspContext } from '@rondocode/engine'
import { WARP_MODES, morphWave, partialWave, scanWavetableCalls, warpPhase, warpWave } from '../src/editor/rondo/wavetable'
import type { WarpMode } from '../src/editor/rondo/wavetable'

/* Ribbon warp composition: the ribbon renders frames through the SAME phase
 * maps the kernel applies. The pure fns are pinned directly against the
 * engine's WavetableKernel output — visual faithfulness is a test, not a
 * hope. */

afterEach(() => clearCustomWavetables())

describe('warpPhase', () => {
  it('mode list matches the engine WAVETABLE_WARPS', () => {
    expect([...WARP_MODES]).toEqual([...WAVETABLE_WARPS])
  })

  it('amt 0 is the identity for every mode', () => {
    for (const mode of WARP_MODES) {
      for (const p of [0, 0.25, 0.5, 0.9]) expect(warpPhase(mode, 0, p)).toBe(p)
    }
  })

  it('sync re-runs the cycle (1+3*amt)x faster and wraps', () => {
    expect(warpPhase('sync', 1, 0.3)).toBeCloseTo(0.2, 12) // 0.3*4 = 1.2 → .2
    expect(warpPhase('sync', 0.5, 0.5)).toBeCloseTo(0.25, 12) // 0.5*2.5 = 1.25
  })

  it('bend bows the transfer curve (p^(1+3*amt))', () => {
    expect(warpPhase('bend', 1, 0.5)).toBeCloseTo(0.0625, 12) // .5^4
    expect(warpPhase('bend', 1, 1)).toBe(1)
  })

  it('mirror at amt 1 is the reflected ramp (a palindrome)', () => {
    expect(warpPhase('mirror', 1, 0.25)).toBeCloseTo(0.5, 12)
    expect(warpPhase('mirror', 1, 0.75)).toBeCloseTo(0.5, 12)
    for (const p of [0.1, 0.3, 0.45]) {
      expect(warpPhase('mirror', 1, p)).toBeCloseTo(warpPhase('mirror', 1, 1 - p), 12)
    }
  })

  it('clamps amt to [0, 1] and swallows NaN (like the kernel)', () => {
    expect(warpPhase('sync', 2, 0.3)).toBeCloseTo(warpPhase('sync', 1, 0.3), 12)
    expect(warpPhase('bend', Number.NaN, 0.4)).toBe(0.4)
    expect(warpPhase('mirror', -1, 0.4)).toBe(0.4)
  })
})

describe('warpWave', () => {
  it('mirror amt 1 forces reflection symmetry on the rendered cycle', () => {
    const wave = partialWave([1, 0.4, 0.2], 128)
    const warped = warpWave(wave, 'mirror', 1)
    for (let i = 1; i < 64; i++) {
      expect(warped[i]!).toBeCloseTo(warped[128 - i]!, 5)
    }
  })

  it('sync amt 1 packs 4 cycles into one (the hard-sync tear)', () => {
    const n = 256
    const sine = new Float32Array(n)
    for (let i = 0; i < n; i++) sine[i] = Math.sin((2 * Math.PI * i) / n)
    const warped = warpWave(sine, 'sync', 1)
    for (let i = 0; i < n; i++) {
      const expected = Math.sin(2 * Math.PI * ((i * 4) / n % 1))
      expect(warped[i]!).toBeCloseTo(expected, 3)
    }
  })

  it('warping frames commutes with the morph blend (what build() relies on)', () => {
    const a = partialWave([1], 96)
    const b = partialWave([0, 1, 0.5], 96)
    for (const mode of WARP_MODES) {
      const pre = morphWave([warpWave(a, mode, 0.7), warpWave(b, mode, 0.7)], 0.4)
      const post = warpWave(morphWave([a, b], 0.4), mode, 0.7)
      for (let i = 0; i < pre.length; i++) expect(pre[i]!).toBeCloseTo(post[i]!, 6)
    }
  })
})

describe('warpPhase vs WavetableKernel (the curve cannot drift from the sound)', () => {
  const SR = 48000
  const ctx: DspContext = { sampleRate: SR }

  /** Run the kernel on a pure-sine custom table (all mipmaps identical) and
   *  compare each output sample to sin(2*pi * warpPhase(phase)). */
  const pin = (mode: WarpMode, amt: number): void => {
    defineWavetable('rwt', [[1]])
    const kernel = new WavetableKernel('rwt', undefined, mode)
    const n = 512
    const f = SR / 128 // dt = 1/128: phase_i = (i/128) mod 1, exactly representable
    const inputs = {
      freq: new Float32Array(n).fill(f),
      pos: new Float32Array(n),
      warpAmt: new Float32Array(n).fill(amt),
    }
    const out = new Float32Array(n)
    kernel.process(n, inputs, out, ctx)
    for (let i = 0; i < n; i++) {
      const phase = (i / 128) % 1
      const expected = Math.sin(2 * Math.PI * warpPhase(mode, amt, phase))
      expect(Math.abs(out[i]! - expected), `${mode} amt=${amt} sample ${i}`).toBeLessThan(1e-3)
    }
  }

  it('sync matches the kernel sample-for-sample', () => pin('sync', 0.7))
  it('bend matches the kernel sample-for-sample', () => pin('bend', 0.7))
  it('mirror matches the kernel sample-for-sample', () => pin('mirror', 0.7))
  it('amt 0 leaves every mode at the identity read', () => {
    for (const mode of WARP_MODES) pin(mode, 0)
  })
})

describe('scanWavetableCalls: warp args', () => {
  it('reads a known warp word + literal warpamt', () => {
    const [call] = scanWavetableCalls('synth s1\n  wavetable note .3 warp:sync warpamt:.7\n')
    expect(call).toMatchObject({ warp: 'sync', warpAmt: 0.7 })
  })

  it('a signal-driven warpamt falls back to the kernel default 0.5', () => {
    const src = 'synth s1\n  wavetable note scan warp:bend warpamt:tear\n  tear = adsr .01 .2 .5 .1\n'
    const [call] = scanWavetableCalls(src)
    expect(call).toMatchObject({ warp: 'bend', warpAmt: 0.5 })
  })

  it('no warp / an unknown warp word renders unwarped', () => {
    expect(scanWavetableCalls('synth s1\n  wavetable note .3\n')[0]!.warp).toBeUndefined()
    expect(scanWavetableCalls('synth s1\n  wavetable note .3 warp:zap\n')[0]!.warp).toBeUndefined()
  })

  it('warpamt literals clamp to [0, 1] like the kernel', () => {
    expect(scanWavetableCalls('synth s1\n  wavetable note .3 warp:mirror warpamt:7\n')[0]!.warpAmt).toBe(1)
  })
})
