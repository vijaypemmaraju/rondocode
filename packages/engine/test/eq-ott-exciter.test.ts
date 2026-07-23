import { describe, expect, it } from 'vitest'
import { EqKernel } from '../src/dsp/eq'
import { ExciterKernel } from '../src/dsp/exciter'
import { OttKernel } from '../src/dsp/ott'
import { synth } from '../src/builder'
import { renderOffline } from '../src/render'

const SR = 48000

/** RMS of a buffer. */
const rms = (a: Float32Array): number => {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i]! * a[i]!
  return Math.sqrt(s / a.length)
}

/** Render a sine at `freq` for `n` samples through a kernel; return the output
 *  (after a warm-up so filter state has settled). */
const runSine = (k: { process: (n: number, i: Record<string, Float32Array>, o: Float32Array, c: { sampleRate: number }) => void }, freq: number, n = SR): Float32Array => {
  const input = new Float32Array(n)
  for (let i = 0; i < n; i++) input[i] = Math.sin((2 * Math.PI * freq * i) / SR)
  const out = new Float32Array(n)
  k.process(n, { in: input }, out, { sampleRate: SR })
  return out
}

const finite = (a: Float32Array): boolean => a.every((x) => Number.isFinite(x))
const tail = (a: Float32Array): Float32Array => a.subarray(Math.floor(a.length / 2))

describe('EqKernel', () => {
  it('with no bands is a pass-through', () => {
    const out = runSine(new EqKernel([]), 1000)
    expect(rms(tail(out))).toBeCloseTo(Math.SQRT1_2, 2) // unit sine ~0.707
  })

  it('a high-shelf boost raises high-frequency energy but leaves lows ~unchanged', () => {
    const shelf = () => new EqKernel([{ type: 'highshelf', freq: 4000, gain: 12 }])
    const lowIn = rms(tail(runSine(new EqKernel([]), 200)))
    const lowOut = rms(tail(runSine(shelf(), 200)))
    const hiOut = rms(tail(runSine(shelf(), 9000)))
    expect(lowOut).toBeCloseTo(lowIn, 1) // low untouched
    expect(hiOut).toBeGreaterThan(lowIn * 2) // highs clearly boosted (~+12 dB ≈ 4×)
  })

  it('a peak boost lifts a sine at its center frequency', () => {
    const eq = new EqKernel([{ type: 'peak', freq: 1000, gain: 12, q: 1 }])
    expect(rms(tail(runSine(eq, 1000)))).toBeGreaterThan(1.0) // >0.707 = boosted
  })

  it('an hp cut attenuates a low sine', () => {
    const eq = new EqKernel([{ type: 'hp', freq: 500 }])
    expect(rms(tail(runSine(eq, 80)))).toBeLessThan(0.3) // well below unity
  })

  it('is finite even with an aggressive stack', () => {
    const eq = new EqKernel([
      { type: 'hp', freq: 120 }, { type: 'peak', freq: 900, gain: -18, q: 6 },
      { type: 'highshelf', freq: 8000, gain: 15 },
    ])
    expect(finite(runSine(eq, 1000))).toBe(true)
  })
})

describe('ExciterKernel', () => {
  it('leaves a signal below the crossover ~untouched', () => {
    const ex = new ExciterKernel({ freq: 4000, amount: 0.6 })
    const out = tail(runSine(ex, 300))
    expect(rms(out)).toBeCloseTo(Math.SQRT1_2, 1) // low sine: nothing to excite
  })

  it('boosts and adds harmonics to content above the crossover', () => {
    const ex = new ExciterKernel({ freq: 3000, amount: 0.6, drive: 4 })
    const dry = rms(tail(runSine(new ExciterKernel({ amount: 0 }), 6000)))
    const wet = rms(tail(runSine(ex, 6000)))
    expect(wet).toBeGreaterThan(dry) // energy added up top
    expect(finite(runSine(ex, 6000))).toBe(true)
  })
})

describe('OttKernel', () => {
  it('with depth 0 is a pass-through', () => {
    const out = tail(runSine(new OttKernel({ depth: 0 }), 1000))
    expect(rms(out)).toBeCloseTo(Math.SQRT1_2, 1)
  })

  it('reduces dynamic range: quiet content comes up relative to loud', () => {
    // loud vs quiet sine through OTT — the gap between them should shrink.
    const loudIn = 0.6, quietIn = 0.02
    const process = (level: number): number => {
      const k = new OttKernel({ depth: 1 })
      const n = SR
      const input = new Float32Array(n)
      for (let i = 0; i < n; i++) input[i] = level * Math.sin((2 * Math.PI * 1000 * i) / SR)
      const out = new Float32Array(n)
      k.process(n, { in: input }, out, { sampleRate: SR })
      return rms(tail(out))
    }
    const loudRatioIn = loudIn / quietIn // 30×
    const loudRatioOut = process(loudIn) / process(quietIn)
    expect(loudRatioOut).toBeLessThan(loudRatioIn) // compressed together
    expect(Number.isFinite(loudRatioOut)).toBe(true)
  })

  it('stays finite on a hot signal', () => {
    const k = new OttKernel({ depth: 1, makeup: 6 })
    const out = runSine(k, 1000)
    expect(finite(out)).toBe(true)
  })
})

describe('eq/exciter/ott through synth() + renderOffline (builder wiring)', () => {
  const ev = [
    { time: 0, type: 'noteOn' as const, note: 57, velocity: 1 },
    { time: 0.3, type: 'noteOff' as const, note: 57 },
  ]
  const renders = (def: ReturnType<typeof synth>): Float32Array => renderOffline(def, ev, 0.4).left

  it('all three wire into the POST chain (nodes present in the compiled post graph)', () => {
    // NB: renderOffline does NOT run def.post, so we assert the builder actually
    // compiled eq/exciter/ott INTO the post graph (a rms>0 render would pass even
    // if post were a no-op — the hollow-test trap this replaces).
    const s = synth(
      ({ note, gate, adsr, saw }) => saw(note.freq).mul(adsr(gate, { a: 0.001, s: 1 })),
      ({ input, eq, exciter, ott }) =>
        ott(exciter(eq(input, [{ type: 'highshelf', freq: 6000, gain: 6 }, { type: 'hp', freq: 100 }]), { amount: 0.3 }), { depth: 0.4 }),
    )
    expect(s.post).toBeDefined()
    const types = s.post!.nodes.map((n) => n.type)
    expect(types).toContain('eq')
    expect(types).toContain('exciter')
    expect(types).toContain('ott')
    // and the voice graph still renders finite/sounding (post is exercised by the
    // server render-runner + the direct-kernel tests above)
    const out = renders(s)
    expect(out.every((x) => Number.isFinite(x))).toBe(true)
    expect(rms(out)).toBeGreaterThan(0)
  })

  it('eq/ott RECOVER from a transient NaN instead of latching to silence', () => {
    // regression: without state-scrub (flush), one NaN sample poisoned the biquad
    // /envelope state forever → permanent silence even after clean input resumed.
    const recover = (k: EqKernel | OttKernel): number => {
      const bad = new Float32Array(64); bad[0] = NaN
      k.process(64, { in: bad }, new Float32Array(64), { sampleRate: SR })
      const clean = runSine(k, 1000)
      return rms(tail(clean))
    }
    expect(recover(new EqKernel([{ type: 'peak', freq: 1000, gain: 6, q: 1 }]))).toBeGreaterThan(0.1)
    expect(recover(new OttKernel({ depth: 0.5 }))).toBeGreaterThan(0.05)
  })

  it('exciter recovers from a transient NaN within the SAME block (per-sample scrub)', () => {
    // regression: exciter scrubbed its lp state only at block END, so one NaN
    // input NaN'd the rest of the block. Now it scrubs per-sample like eq/ott.
    const k = new ExciterKernel({ amount: 0.5, drive: 4 })
    const bad = new Float32Array(128)
    for (let i = 0; i < 128; i++) bad[i] = 0.3 * Math.sin((2 * Math.PI * 4000 * i) / SR)
    bad[10] = NaN
    const out = new Float32Array(128)
    k.process(128, { in: bad }, out, { sampleRate: SR })
    expect(out.every((x) => Number.isFinite(x))).toBe(true) // whole block finite, not just the tail
  })

  it('a non-finite eq band field does not silence the whole signal', () => {
    // regression: NaN freq → NaN coefficients → dead biquad. Bad fields must be
    // guarded to a sane default so only that band is off, not the entire chain.
    const out = runSine(new EqKernel([{ type: 'peak', freq: NaN as unknown as number, gain: 6 }]), 440)
    expect(rms(tail(out))).toBeGreaterThan(0.3)
    expect(finite(out)).toBe(true)
  })

  it('eq works in the VOICE graph too', () => {
    const s = synth(({ note, gate, adsr, saw, eq }) =>
      eq(saw(note.freq), [{ type: 'peak', freq: 800, gain: 9, q: 2 }]).mul(adsr(gate, { a: 0.001, s: 1 })))
    const out = renders(s)
    expect(out.every((x) => Number.isFinite(x))).toBe(true)
    expect(rms(out)).toBeGreaterThan(0)
  })
})

describe('post-chain params ARE driveable + renderOffline safety', () => {
  const paramEv = (lvl: number) => [
    { time: 0, type: 'noteOn' as const, note: 57, velocity: 1 },
    { time: 0.001, type: 'param' as const, name: 'lvl', value: lvl },
    { time: 0.3, type: 'noteOff' as const, note: 57 },
  ]

  it('a POST param() driven by a param event takes effect in the render', () => {
    // regression: post params were unreachable — renderOffline ignored def.post,
    // and the engine never routed setParam to the post chain. Now they work.
    const s = synth(
      ({ note, gate, saw }) => saw(note.freq).mul(gate),
      ({ input, param }) => input.mul(param('lvl', 1, { min: 0, max: 1 })),
    )
    expect(rms(renderOffline(s, paramEv(1), 0.3).left)).toBeGreaterThan(0.2)
    expect(rms(renderOffline(s, paramEv(0), 0.3).left)).toBeLessThan(0.1) // post param silenced it
  })

  it('renderOffline scrubs non-finite samples (a runaway pow cannot emit Inf/NaN)', () => {
    const s = synth(({ note, gate, saw }) => saw(note.freq).add(2).pow(4000).mul(gate))
    const out = renderOffline(s, [
      { time: 0, type: 'noteOn' as const, note: 57, velocity: 1 },
      { time: 0.2, type: 'noteOff' as const, note: 57 },
    ], 0.3)
    expect(out.left.every((x) => Number.isFinite(x))).toBe(true)
    expect(out.right.every((x) => Number.isFinite(x))).toBe(true)
  })
})
