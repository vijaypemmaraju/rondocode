import { afterEach, describe, it, expect } from 'vitest'
import {
  WavetableKernel,
  WavetableBank,
  WAVETABLE_TABLES,
  WAVETABLE_FRAME_SIZE,
  getWavetable,
  getWavetableBank,
  getCustomWavetables,
  defineWavetable,
  clearCustomWavetables,
  snapshotCustomWavetables,
  restoreCustomWavetables,
  hasWavetable,
} from '../src/dsp/wavetable'
import { RealtimeEngine, BLOCK } from '../src/index'
import type { EngineEvent } from '../src/index'
import { synth } from '../src/builder'
import { renderOffline } from '../src/render'
import { goertzel } from './util/goertzel'
import type { DspContext } from '../src/dsp/types'

const ctx: DspContext = { sampleRate: 48000 }

/** Render a WavetableKernel at a constant freq and pos over n samples. */
const run = (table: string | undefined, freq: number, pos: number, n: number): Float32Array => {
  const f = new Float32Array(n).fill(freq)
  const p = new Float32Array(n).fill(pos)
  const out = new Float32Array(n)
  new WavetableKernel(table, ctx).process(n, { freq: f, pos: p }, out, ctx)
  return out
}

const rmsOf = (x: Float32Array): number => {
  let s = 0
  for (let i = 0; i < x.length; i++) s += x[i]! * x[i]!
  return Math.sqrt(s / x.length)
}

const minMax = (out: Float32Array, start = 0): [number, number] => {
  let min = Infinity
  let max = -Infinity
  for (let i = start; i < out.length; i++) {
    if (out[i]! < min) min = out[i]!
    if (out[i]! > max) max = out[i]!
  }
  return [min, max]
}

/** Energy-weighted mean frequency (spectral centroid) sampled at the true
 *  harmonics of `fund` — a brightness proxy. Probing exact harmonics of a
 *  periodic tone avoids the Goertzel leakage a fixed-grid comb would suffer. */
const centroid = (out: Float32Array, sr: number, fund: number): number => {
  let num = 0
  let den = 0
  for (let k = 1; k * fund < sr / 2; k++) {
    const f = k * fund
    const p = goertzel(out, f, sr)
    num += f * p
    den += p
  }
  return den > 0 ? num / den : 0
}

describe('WavetableKernel: produces a tone', () => {
  it('basic table at pos 0 renders a 440 Hz fundamental (Goertzel peak)', () => {
    const out = run('basic', 440, 0, 48000)
    const atFund = goertzel(out, 440, ctx.sampleRate)
    // dominates its neighbours and unrelated bins
    expect(atFund).toBeGreaterThan(goertzel(out, 330, ctx.sampleRate) * 50)
    expect(atFund).toBeGreaterThan(goertzel(out, 550, ctx.sampleRate) * 50)
    expect(atFund).toBeGreaterThan(goertzel(out, 880, ctx.sampleRate) * 50)
  })

  it('defaults to the basic table when no name is given (sample-identical output)', () => {
    // The default is DEFINED as the basic table: same phase accumulator, same
    // frames, same mipmaps — so the two renders must match sample-for-sample.
    // (A >0-energy check would pass for ANY table; identity pins the contract.)
    const def = run(undefined, 440, 0.35, 4800)
    const basic = run('basic', 440, 0.35, 4800)
    expect(Array.from(def)).toEqual(Array.from(basic))
    // and it is a real tone, not silence trivially matching silence
    expect(goertzel(def, 440, ctx.sampleRate)).toBeGreaterThan(1e-3)
  })
})

describe('WavetableKernel: morph changes timbre', () => {
  it('basic table pos 0 is much darker than pos 1', () => {
    // 240 Hz => exactly 200 samples/cycle at 48k, so harmonic probes are coherent
    const dark = centroid(run('basic', 240, 0, 48000), ctx.sampleRate, 240)
    const bright = centroid(run('basic', 240, 1, 48000), ctx.sampleRate, 240)
    // pos 0 is a pure sine (centroid = the 240 Hz fundamental); pos 1 is a
    // band-limited square. Measured: dark = 240, bright ≈ 531 — a 2.2x lift
    // (the square's 1/k² energy weights the fundamental, so the power-centroid
    // is modest even though it is audibly far brighter). Pin > 2x.
    expect(bright).toBeGreaterThan(dark * 2)
  })

  it('harmonic table sweeps its centroid upward with pos', () => {
    const lo = centroid(run('harmonic', 240, 0, 48000), ctx.sampleRate, 240)
    const hi = centroid(run('harmonic', 240, 1, 48000), ctx.sampleRate, 240)
    expect(hi).toBeGreaterThan(lo)
  })
})

describe('WavetableKernel: anti-aliasing via mipmaps', () => {
  // A high note reading a harmonically rich frame: the mipmapped kernel keeps
  // only the harmonics that stay below Nyquist, while a deliberately
  // NON-mipmapped read of the same table (mipmap 0 = full harmonics) folds its
  // out-of-band harmonics back down as inharmonic alias energy.
  it('a high note aliases far less than a naive full-band read', () => {
    const n = 48000
    // 4700 Hz does NOT divide 48000 evenly, so out-of-band harmonics fold to
    // INHARMONIC positions (a 4 kHz fundamental would fold aliases exactly back
    // onto its own harmonics, hiding them). Legit harmonics: 4700/9400/14100/…
    const freq = 4700
    const table = getWavetable('basic')
    const lastFrame = table[table.length - 1]! // pos 1 = square/saw, richest
    const fullBand = lastFrame[0]! // mipmap 0 = all harmonics

    // mipmapped: the kernel picks a band-limited mipmap for 4 kHz
    const mip = run('basic', freq, 1, n)

    // naive: phase-accumulate straight through the full-band frame (aliases)
    const naive = new Float32Array(n)
    let phase = 0
    const dt = freq / ctx.sampleRate
    const size = WAVETABLE_FRAME_SIZE
    for (let i = 0; i < n; i++) {
      const posf = phase * size
      const i0 = posf | 0
      const frac = posf - i0
      const i1 = (i0 + 1) & (size - 1)
      naive[i] = fullBand[i0]! + frac * (fullBand[i1]! - fullBand[i0]!)
      phase += dt
      phase -= Math.floor(phase)
    }

    // Alias energy: power at probe frequencies that are NOT near a harmonic of
    // `freq`. For a mipmapped read those are ~0; a naive read spreads folded
    // harmonics all over them.
    const aliasEnergy = (out: Float32Array): number => {
      let e = 0
      for (let f = 550; f < ctx.sampleRate / 2; f += 313) {
        const r = f % freq
        if (r < 200 || freq - r < 200) continue // skip bins near a real harmonic
        e += goertzel(out, f, ctx.sampleRate)
      }
      return e
    }

    const mipAlias = aliasEnergy(mip)
    const naiveAlias = aliasEnergy(naive)
    // Measured (48k, 4700 Hz, basic pos 1): naive ≈ 4.9e-21, mipmapped ≈ 4.9e-25
    // inharmonic power — a ~10000x reduction. The absolute scale is small and
    // probe-grid dependent; the RATIO is the real claim, so pin a conservative
    // 100x margin (the naive read is the SAME table read without mipmapping).
    expect(mipAlias).toBeLessThan(naiveAlias / 100)
  })
})

describe('WavetableKernel: bounded and finite', () => {
  it('|out| <= 1.1 with no NaN across freq 20..15000 and pos 0..1', () => {
    for (const table of WAVETABLE_TABLES) {
      for (const freq of [20, 110, 440, 1000, 4000, 8000, 15000]) {
        for (const pos of [0, 0.25, 0.5, 0.75, 1]) {
          const out = run(table, freq, pos, 4096)
          for (let i = 0; i < out.length; i++) {
            expect(Number.isFinite(out[i]!)).toBe(true)
          }
          const [min, max] = minMax(out)
          expect(max, `${table} f=${freq} p=${pos}`).toBeLessThanOrEqual(1.1)
          expect(min, `${table} f=${freq} p=${pos}`).toBeGreaterThanOrEqual(-1.1)
        }
      }
    }
  }, 20_000) // heavy parameter sweep (~140k asserts); don't rely on the 5s default

  it('recovers from a NaN freq block within one clean block', () => {
    const k = new WavetableKernel('basic', ctx)
    const nanF = new Float32Array(512).fill(NaN)
    const p = new Float32Array(512).fill(0.5)
    k.process(512, { freq: nanF, pos: p }, new Float32Array(512), ctx)
    const cleanF = new Float32Array(512).fill(440)
    const out = new Float32Array(512)
    k.process(512, { freq: cleanF, pos: p }, out, ctx)
    for (let i = 0; i < out.length; i++) {
      expect(Number.isFinite(out[i]!)).toBe(true)
      expect(Math.abs(out[i]!)).toBeLessThanOrEqual(1.1)
    }
  })
})

describe('WavetableKernel: block-boundary continuity', () => {
  it('two half blocks equal one full block', () => {
    const n = 1024
    const freq = new Float32Array(n).fill(440)
    const pos = new Float32Array(n)
    for (let i = 0; i < n; i++) pos[i] = i / (n - 1) // ramp so morph advances
    const inputs = { freq, pos }
    const slice = (lo: number, hi: number) => ({
      freq: freq.subarray(lo, hi),
      pos: pos.subarray(lo, hi),
    })
    const full = new Float32Array(n)
    new WavetableKernel('basic', ctx).process(n, inputs, full, ctx)
    const split = new Float32Array(n)
    const k = new WavetableKernel('basic', ctx)
    k.process(n / 2, slice(0, n / 2), split.subarray(0, n / 2), ctx)
    k.process(n / 2, slice(n / 2, n), split.subarray(n / 2), ctx)
    expect(Array.from(split)).toEqual(Array.from(full))
  })

  it('reset() zeros phase (replays the same output)', () => {
    const k = new WavetableKernel('basic', ctx)
    const f = new Float32Array(256).fill(440)
    const p = new Float32Array(256).fill(0.3)
    const a = new Float32Array(256)
    k.process(256, { freq: f, pos: p }, a, ctx)
    k.reset()
    const b = new Float32Array(256)
    k.process(256, { freq: f, pos: p }, b, ctx)
    expect(Array.from(b)).toEqual(Array.from(a))
  })
})

describe('WavetableKernel: audio-rate pos', () => {
  it('a pos ramp within a block morphs smoothly and stays bounded', () => {
    const n = 4096
    const freq = new Float32Array(n).fill(330)
    const pos = new Float32Array(n)
    for (let i = 0; i < n; i++) pos[i] = i / (n - 1)
    const out = new Float32Array(n)
    new WavetableKernel('basic', ctx).process(n, { freq, pos }, out, ctx)
    for (let i = 0; i < n; i++) expect(Number.isFinite(out[i]!)).toBe(true)
    const [min, max] = minMax(out)
    expect(max).toBeLessThanOrEqual(1.1)
    expect(min).toBeGreaterThanOrEqual(-1.1)
  })

  it('clamps out-of-range pos without blowing up', () => {
    const n = 2048
    const freq = new Float32Array(n).fill(440)
    const pos = new Float32Array(n)
    for (let i = 0; i < n; i++) pos[i] = -2 + (4 * i) / (n - 1) // -2 .. 2
    const out = new Float32Array(n)
    new WavetableKernel('basic', ctx).process(n, { freq, pos }, out, ctx)
    const [min, max] = minMax(out)
    expect(max).toBeLessThanOrEqual(1.1)
    expect(min).toBeGreaterThanOrEqual(-1.1)
  })
})

describe('WavetableKernel: table set', () => {
  it('exposes basic, harmonic and pwm tables with octave mipmaps', () => {
    expect([...WAVETABLE_TABLES]).toEqual(['basic', 'harmonic', 'pwm'])
    for (const name of WAVETABLE_TABLES) {
      const frames = getWavetable(name)
      expect(frames.length).toBeGreaterThanOrEqual(7) // ~8 frames
      for (const mips of frames) {
        expect(mips.length).toBeGreaterThanOrEqual(10) // ~10-11 octave mipmaps
        expect(mips[0]!.length).toBe(WAVETABLE_FRAME_SIZE)
      }
    }
  })

  it('rejects an unknown table name', () => {
    expect(() => new WavetableKernel('nope', ctx)).toThrow()
  })
})

/* ---------------------------- custom tables -------------------------------- */

describe('custom wavetables: defineWavetable + registry', () => {
  afterEach(() => clearCustomWavetables())

  it('partial list -> exact spectrum: [1, 0, 0.5] has h1 and h3, no h2 (Goertzel)', () => {
    defineWavetable('spec13', [[1, 0, 0.5]])
    // 240 Hz divides 48000 (200 samples/cycle) so harmonic probes are coherent
    const out = run('spec13', 240, 0, 48000)
    const h1 = goertzel(out, 240, ctx.sampleRate)
    const h2 = goertzel(out, 480, ctx.sampleRate)
    const h3 = goertzel(out, 720, ctx.sampleRate)
    expect(h1).toBeGreaterThan(h2 * 1000) // h2 amplitude is 0
    expect(h3).toBeGreaterThan(h2 * 100)
    // POWER ratio h1/h3 = (1/0.5)^2 = 4 (amplitudes normalize together)
    expect(h1 / h3).toBeGreaterThan(3)
    expect(h1 / h3).toBeLessThan(5.5)
  })

  it('morphs between custom frames: pos 0 = fundamental, pos 1 = 4th harmonic', () => {
    defineWavetable('morph14', [[1], [0, 0, 0, 1]])
    const at0 = run('morph14', 240, 0, 24000)
    const at1 = run('morph14', 240, 1, 24000)
    expect(goertzel(at0, 240, ctx.sampleRate)).toBeGreaterThan(goertzel(at0, 960, ctx.sampleRate) * 100)
    expect(goertzel(at1, 960, ctx.sampleRate)).toBeGreaterThan(goertzel(at1, 240, ctx.sampleRate) * 100)
  })

  it('band-limits at high notes: an 8th-harmonic-only frame goes quiet up high', () => {
    defineWavetable('h8only', [[0, 0, 0, 0, 0, 0, 0, 1]])
    // low note: 8th harmonic (1760 Hz) is fully in band — audible
    const lo = run('h8only', 220, 0, 24000)
    expect(goertzel(lo, 1760, ctx.sampleRate)).toBeGreaterThan(1e-4)
    // high note: 8 x 8000 = 64 kHz is FAR above Nyquist; the mipmap for 8 kHz
    // keeps only harmonics <= 3, so the frame renders (near) silence instead
    // of aliasing the 8th harmonic back into band
    const hi = run('h8only', 8000, 0, 24000)
    expect(rmsOf(hi)).toBeLessThan(1e-6)
    expect(rmsOf(lo)).toBeGreaterThan(0.1)
  })

  it('rejects bad names and specs; hasWavetable/getCustomWavetables reflect the registry', () => {
    expect(() => defineWavetable('basic', [[1]])).toThrow(/shadows a built-in/)
    expect(() => defineWavetable('9lives', [[1]])).toThrow(/name must be a word/)
    expect(() => defineWavetable('t', [])).toThrow(/frames/)
    expect(() => defineWavetable('t', [[]])).toThrow(/partial/)
    expect(() => defineWavetable('t', [Array.from({ length: 33 }, () => 1)])).toThrow(/partial/)
    expect(() => defineWavetable('t', [[1, NaN]])).toThrow(/finite/)
    expect(() => defineWavetable('t', [[99]])).toThrow(/finite numbers with/)
    defineWavetable('goodwt', [[1, 0.5], [0.2, 1]])
    expect(hasWavetable('goodwt')).toBe(true)
    expect(hasWavetable('basic')).toBe(true)
    expect(hasWavetable('gone')).toBe(false)
    expect(getCustomWavetables().get('goodwt')).toEqual([[1, 0.5], [0.2, 1]])
    expect(getWavetableBank('goodwt')![0]![0]!.length).toBe(WAVETABLE_FRAME_SIZE)
  })

  it('unknown custom name throws and lists the registered customs', () => {
    defineWavetable('knownwt', [[1]])
    expect(() => new WavetableKernel('nopewt', ctx)).toThrow(/knownwt/)
  })

  it('snapshot/clear/restore round-trips (the eval staging lifecycle)', () => {
    defineWavetable('keepme', [[1, 0.5]])
    const snap = snapshotCustomWavetables()
    clearCustomWavetables()
    expect(hasWavetable('keepme')).toBe(false)
    restoreCustomWavetables(snap)
    expect(hasWavetable('keepme')).toBe(true)
    expect(getCustomWavetables().get('keepme')).toEqual([[1, 0.5]])
  })
})

describe('custom wavetables: WavetableBank on the ctx (the engine store)', () => {
  it('kernel resolves via ctx.wavetables, and a re-load is heard per block without a rebuild', () => {
    const bank = new WavetableBank()
    bank.set('livewt', [[1]]) // pure fundamental
    const bctx: DspContext = { sampleRate: 48000, wavetables: bank }
    const k = new WavetableKernel('livewt', bctx)
    const n = 24000
    const f = new Float32Array(n).fill(240)
    const p = new Float32Array(n)
    const a = new Float32Array(n)
    k.process(n, { freq: f, pos: p }, a, bctx)
    expect(goertzel(a, 240, 48000)).toBeGreaterThan(goertzel(a, 480, 48000) * 100)
    // REPLACE the table (same name, new partials): next block reads the new bank
    bank.set('livewt', [[0, 1]]) // pure 2nd harmonic
    const b = new Float32Array(n)
    k.process(n, { freq: f, pos: p }, b, bctx)
    expect(goertzel(b, 480, 48000)).toBeGreaterThan(goertzel(b, 240, 48000) * 100)
  })

  it('bank.set validates like defineWavetable (shadow + spec errors throw)', () => {
    const bank = new WavetableBank()
    expect(() => bank.set('pwm', [[1]])).toThrow(/shadows a built-in/)
    expect(() => bank.set('x', [[Infinity]])).toThrow(/finite/)
    bank.set('ok', [[1, 0.3]])
    expect(bank.has('ok')).toBe(true)
    expect(bank.names()).toEqual(['ok'])
    bank.delete('ok')
    expect(bank.get('ok')).toBeUndefined()
  })
})

describe('custom wavetables: wire messages (loadWavetable / clearWavetable)', () => {
  /** Build the GraphSpec with the registry TEMPORARILY holding the table
   *  (synth() eager-compiles), then clear it — so the engine-side tests below
   *  exercise ONLY the wire path (ctx.wavetables), never the realm fallback. */
  const wtSynth = (table: string) => {
    defineWavetable(table, [[1]])
    const g = synth((c) => c.wavetable(c.note.freq, 0.5, { table }).mul(c.gate)).graph
    clearCustomWavetables()
    return g
  }

  const makeEngine = () => {
    const events: EngineEvent[] = []
    const eng = new RealtimeEngine({ sampleRate: 48000 }) // fresh ctx: isolated banks
    eng.onEvent = (ev) => events.push(ev)
    return { eng, events }
  }
  const errs = (events: EngineEvent[]) =>
    events.filter((e): e is Extract<EngineEvent, { kind: 'error' }> => e.kind === 'error')
  const walk = (eng: RealtimeEngine, blocks: number): Float32Array => {
    const L = new Float32Array(blocks * BLOCK)
    const bl = new Float32Array(BLOCK)
    const br = new Float32Array(BLOCK)
    for (let b = 0; b < blocks; b++) {
      eng.process(bl, br, eng.currentFrame)
      L.set(bl, b * BLOCK)
    }
    return L
  }

  it('loadWavetable then defineSynth + noteOn produces sound', () => {
    const { eng, events } = makeEngine()
    eng.handleMessage({ kind: 'loadWavetable', name: 'wirewt', frames: [[1, 0.5], [0.2, 1, 0.7]] })
    eng.handleMessage({ kind: 'defineSynth', name: 'lead', graph: wtSynth('wirewt') })
    eng.handleMessage({ kind: 'noteOn', synth: 'lead', note: 60, velocity: 1 })
    const out = walk(eng, 20)
    expect(errs(events)).toEqual([])
    expect(rmsOf(out)).toBeGreaterThan(0.01)
  })

  it('defineSynth against a missing table is an error event, not a crash', () => {
    const { eng, events } = makeEngine()
    eng.handleMessage({ kind: 'defineSynth', name: 'lead', graph: wtSynth('missingwt') })
    expect(errs(events).some((e) => e.message.includes('missingwt'))).toBe(true)
  })

  it('a bad frames spec is an error event; clearWavetable makes later defines fail', () => {
    const { eng, events } = makeEngine()
    eng.handleMessage({ kind: 'loadWavetable', name: 'badwt', frames: [[NaN]] })
    expect(errs(events).some((e) => e.message.includes('finite'))).toBe(true)
    eng.handleMessage({ kind: 'loadWavetable', name: 'okwt', frames: [[1]] })
    eng.handleMessage({ kind: 'clearWavetable', name: 'okwt' })
    eng.handleMessage({ kind: 'defineSynth', name: 'lead', graph: wtSynth('okwt') })
    expect(errs(events).some((e) => e.message.includes('okwt'))).toBe(true)
  })
})

describe('custom wavetables: offline render', () => {
  afterEach(() => clearCustomWavetables())

  // synth() runs an eager validation compile at DEFINITION time, so the table
  // must already resolve in this realm when the def is built (defineWavetable
  // first — exactly the order the rondo codegen hoists wavedef into).
  const def = (table: string) =>
    synth((c) => c.wavetable(c.note.freq, 0.25, { table }).mul(c.adsr(c.gate, { a: 0.005, d: 0.05, s: 0.8, r: 0.05 })))

  const NOTE_EVENTS = [
    { time: 0, type: 'noteOn' as const, note: 57 },
    { time: 0.4, type: 'noteOff' as const, note: 57 },
  ]

  it('building a synth on an UNKNOWN table throws at definition (the existing throw)', () => {
    expect(() => def('renderwt')).toThrow(/unknown wavetable 'renderwt'/)
  })

  it('renderOffline with the wavetables option is NOT silent (option overrides the realm)', () => {
    defineWavetable('renderwt', [[1]])
    const d = def('renderwt')
    clearCustomWavetables() // the registry is gone; only the OPTION can supply the bank
    const res = renderOffline(d, NOTE_EVENTS, 0.5, {
      wavetables: { renderwt: [[1, 0.4], [0.3, 1, 0.6]] },
    })
    expect(rmsOf(res.left)).toBeGreaterThan(0.02)
  })

  it('renderOffline falls back to the defineWavetable registry (same realm as the eval)', () => {
    defineWavetable('fallbackwt', [[1, 0.6, 0.3]])
    const res = renderOffline(def('fallbackwt'), NOTE_EVENTS, 0.5)
    expect(rmsOf(res.left)).toBeGreaterThan(0.02)
  })
})
