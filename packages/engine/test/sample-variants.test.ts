import { describe, expect, it } from 'vitest'
import { SampleBank, parseSampleRef, sampleRefName } from '../src/samples'
import { SampleKernel } from '../src/dsp/sample'
import { synth } from '../src/builder'
import { renderOffline } from '../src/render'

/* ------------------------------------------------------------------------- *
 * SAMPLE FAMILIES.
 *
 * `bd:3` used to be a sound NAMED "bd:3". Nothing was called that, so the
 * voice resolved to nothing and played silence without complaining — the
 * project's worst-behaved bug shape, a declared capability that quietly does
 * nothing. `bd`, `bd:1` and `bd:2` are now one family with three slots.
 *
 * The index WRAPS, which is the whole point: a round-robin kit driven from a
 * pattern must not fall silent the moment the pattern counts past the last
 * sample you happened to load.
 * ------------------------------------------------------------------------- */

const sr = 48000
/** A buffer whose every frame is `v`, so the value identifies the variant. */
const pcm = (v: number, n = 8): Float32Array => Float32Array.from(Array(n).fill(v))

const kit = (): SampleBank => {
  const b = new SampleBank()
  b.set('bd', pcm(1), sr)
  b.set('bd:1', pcm(2), sr)
  b.set('bd:2', pcm(3), sr)
  b.set('sd', pcm(9), sr)
  return b
}

const first = (b: SampleBank, name: string): number | undefined => b.get(name)?.data[0]

describe('parseSampleRef', () => {
  it('splits a trailing integer off the family name', () => {
    expect(parseSampleRef('bd:3')).toEqual({ base: 'bd', index: 3 })
    expect(parseSampleRef('bd')).toEqual({ base: 'bd', index: undefined })
    expect(parseSampleRef('hi:hat:2')).toEqual({ base: 'hi:hat', index: 2 })
  })

  it('leaves a name that merely CONTAINS a colon alone', () => {
    /* Only a trailing integer counts, so a sample genuinely called `my:thing`
     * still loads and resolves under its own name. */
    for (const n of ['my:thing', 'bd:', 'bd:x', 'bd:-1', 'bd:1.5', ':3']) {
      expect(parseSampleRef(n), n).toEqual({ base: n, index: undefined })
    }
  })

  it('round-trips through sampleRefName, with variant 0 as the bare name', () => {
    expect(sampleRefName('bd', 0)).toBe('bd')
    expect(sampleRefName('bd', 2)).toBe('bd:2')
    for (const n of ['bd', 'bd:2', 'kick']) {
      const { base, index } = parseSampleRef(n)
      expect(sampleRefName(base, index ?? 0)).toBe(n)
    }
  })
})

describe('the bank resolves families', () => {
  it('a bare name is variant 0', () => {
    const b = kit()
    expect(first(b, 'bd')).toBe(1)
    expect(first(b, 'bd:0')).toBe(1)
  })

  it('an index picks its variant', () => {
    const b = kit()
    expect(first(b, 'bd:1')).toBe(2)
    expect(first(b, 'bd:2')).toBe(3)
  })

  it('and WRAPS past the end rather than going silent', () => {
    const b = kit()
    expect([3, 4, 5, 6, 7].map((i) => first(b, `bd:${i}`))).toEqual([1, 2, 3, 1, 2])
    // a one-deep family absorbs any index at all
    expect(first(b, 'sd:7')).toBe(9)
  })

  it('a missing family is undefined, index or not', () => {
    const b = kit()
    expect(first(b, 'nope')).toBeUndefined()
    expect(first(b, 'nope:2')).toBeUndefined()
  })

  it('a GAP stays empty instead of sliding to a neighbour', () => {
    /* Substituting a different sample for the one that was asked for would be
     * a worse failure than silence: it sounds deliberate. */
    const b = new SampleBank()
    b.set('x', pcm(1), sr)
    b.set('x:5', pcm(6), sr)
    expect(first(b, 'x:1')).toBeUndefined()
    expect(first(b, 'x:5')).toBe(6)
    expect(first(b, 'x:6')).toBe(1) // 6 % 6 === 0
  })

  it('reports depth, and names every occupied slot', () => {
    const b = kit()
    expect(b.depth('bd')).toBe(3)
    expect(b.depth('sd')).toBe(1)
    expect(b.depth('nope')).toBe(0)
    expect(b.names().sort()).toEqual(['bd', 'bd:1', 'bd:2', 'sd'])
  })

  it('has() follows resolution, so a wrapped index counts as present', () => {
    const b = kit()
    expect(b.has('bd:9')).toBe(true)
    expect(b.has('nope')).toBe(false)
  })

  it('deleting one variant leaves the rest, and the family shrinks', () => {
    const b = kit()
    b.delete('bd:2')
    expect(b.depth('bd')).toBe(2)
    expect(first(b, 'bd:2')).toBe(1) // 2 % 2 === 0
    b.delete('bd')
    expect(b.depth('bd')).toBe(0)
  })

  it('a single-sample bank behaves exactly as it did before families existed', () => {
    const b = new SampleBank()
    b.set('vox', pcm(4), sr)
    expect(first(b, 'vox')).toBe(4)
    expect(b.names()).toEqual(['vox'])
    expect(b.has('vox')).toBe(true)
  })

  it('still scrubs non-finite frames off the audio path', () => {
    const b = new SampleBank()
    b.set('bad', Float32Array.from([NaN, Infinity, 0.5]), sr)
    expect([...b.get('bad')!.data]).toEqual([0, 0, 0.5])
  })
})

describe('a note picks its variant', () => {
  /** Four gated hits, 16 samples apart; returns the value each hit played. */
  const hits = (bank: SampleBank, name: string, variants?: number[]): (number | undefined)[] => {
    const k = new SampleKernel(name, false, bank)
    const N = 64
    const out = new Float32Array(N)
    const gate = new Float32Array(N)
    const vin = new Float32Array(N)
    for (let i = 0; i < N; i++) {
      gate[i] = i % 16 < 4 ? 1 : 0
      if (variants !== undefined) vin[i] = variants[Math.floor(i / 16)]!
    }
    const ins: Record<string, Float32Array> = { gate }
    if (variants !== undefined) ins['variant'] = vin
    k.process(N, ins, out, { sampleRate: sr })
    return [0, 1, 2, 3].map((b) => out[b * 16])
  }

  it('plays variant 0 when nothing asks otherwise', () => {
    expect(hits(kit(), 'bd')).toEqual([1, 1, 1, 1])
  })

  it('honours a variant written into the NAME', () => {
    expect(hits(kit(), 'bd:2')).toEqual([3, 3, 3, 3])
  })

  it('round-robins from the variant input, latched per note', () => {
    /* Sample-accurate: a block can hold several gate edges, and each note must
     * play the sample it asked for rather than the one the previous note left
     * resolved. Four hits fall inside a single 64-sample call here. */
    expect(hits(kit(), 'bd', [0, 1, 2, 0])).toEqual([1, 2, 3, 1])
  })

  it('and the input wraps too', () => {
    expect(hits(kit(), 'bd', [3, 4, 5, 7])).toEqual([1, 2, 3, 2])
  })

  it('a missing family is silent however the variant moves', () => {
    expect(hits(kit(), 'nope', [0, 1, 2, 0])).toEqual([0, 0, 0, 0])
  })

  it('a sample loaded LATE still starts on the next note', () => {
    /* The kernel resolves per block on purpose, so a bank that fills in after
     * a synth was compiled becomes audible with no recompile. Families must
     * not have broken that. */
    const b = new SampleBank()
    const k = new SampleKernel('late', false, b)
    const gate = new Float32Array(8).fill(1)
    const out = new Float32Array(8)
    k.process(8, { gate }, out, { sampleRate: sr })
    expect([...out].every((v) => v === 0), 'sounded before it was loaded').toBe(true)
    b.set('late', pcm(5), sr)
    const gate2 = new Float32Array(8)
    gate2.fill(0, 0, 2)
    gate2.fill(1, 2, 8) // a fresh edge
    const out2 = new Float32Array(8)
    k.process(8, { gate: gate2 }, out2, { sampleRate: sr })
    expect(out2[3]).toBe(5)
  })
})

/* ------------------------------------------------------------------------- *
 * KEY ZONES.
 *
 * One buffer stretched across a keyboard is the thing that gives a sampler
 * away: a piano pitched down two octaves is a different instrument, not a
 * lower note. Zones map ranges of the keyboard to different recordings, each
 * pitched from its own root.
 *
 * They compose with families rather than replacing them — a zone name may be
 * `piano_mid:2`, so round robin still applies within the zone.
 * ------------------------------------------------------------------------- */

const freqOf = (midi: number): number => 440 * Math.pow(2, (midi - 69) / 12)

describe('key zones', () => {
  const zones = [
    { lo: 0, hi: 59, name: 'low', root: 48 },
    { lo: 60, hi: 71, name: 'mid', root: 60 },
    { lo: 72, hi: 127, name: 'high', root: 84 },
  ]
  const zoned = (): SampleBank => {
    const b = new SampleBank()
    b.set('low', pcm(1), sr)
    b.set('mid', pcm(2), sr)
    b.set('high', pcm(3), sr)
    return b
  }
  /** The value the note plays, which identifies the sample it chose. */
  const played = (midi: number, bank = zoned(), zs = zones): number => {
    const k = new SampleKernel('low', false, bank, { zones: zs } as never)
    const n = 32
    const out = new Float32Array(n)
    const gate = new Float32Array(n).fill(1)
    k.process(n, { gate, nfreq: new Float32Array(n).fill(freqOf(midi)) }, out, { sampleRate: sr })
    return out[1]!
  }

  it('picks the recording for the note, not one sample for all of them', () => {
    expect(played(40)).toBe(1)
    expect(played(64)).toBe(2)
    expect(played(90)).toBe(3)
  })

  it('the boundaries are inclusive on both sides', () => {
    expect(played(59)).toBe(1)
    expect(played(60)).toBe(2)
    expect(played(71)).toBe(2)
    expect(played(72)).toBe(3)
  })

  it('a note outside every zone is SILENT, not the nearest neighbour', () => {
    /* Same choice the family gap makes: substituting a sample nobody asked
     * for sounds deliberate, which is worse than hearing nothing. */
    expect(played(64, zoned(), [{ lo: 0, hi: 40, name: 'low', root: 40 }])).toBe(0)
  })

  it('each zone pitches from ITS OWN root', () => {
    // a ramp, so the playback rate is readable from how fast it climbs
    const b = new SampleBank()
    b.set('a', Float32Array.from({ length: 4000 }, (_, i) => i / 4000), sr)
    const rate = (midi: number): number => {
      const k = new SampleKernel('a', false, b, { zones: [{ lo: 0, hi: 127, name: 'a', root: 60 }] } as never)
      const n = 400
      const out = new Float32Array(n)
      k.process(n, { gate: new Float32Array(n).fill(1), nfreq: new Float32Array(n).fill(freqOf(midi)) }, out, { sampleRate: sr })
      return ((out[300]! - out[100]!) / 200) * 4000
    }
    expect(rate(60)).toBeCloseTo(1, 3)
    expect(rate(72)).toBeCloseTo(2, 3)
    expect(rate(48)).toBeCloseTo(0.5, 3)
  })

  it('a zone name may be a FAMILY member, so round robin still works inside it', () => {
    const b = zoned()
    b.set('mid:1', pcm(9), sr)
    expect(played(64, b, [{ lo: 60, hi: 71, name: 'mid:1', root: 60 }])).toBe(9)
  })

  it('no zones at all leaves the plain name behaviour untouched', () => {
    const b = new SampleBank()
    b.set('plain', pcm(7), sr)
    const k = new SampleKernel('plain', false, b)
    const out = new Float32Array(16)
    k.process(16, { gate: new Float32Array(16).fill(1) }, out, { sampleRate: sr })
    expect(out[1]).toBe(7)
  })

  it('survives a missing or nonsense note frequency rather than going mad', () => {
    const k = new SampleKernel('low', false, zoned(), { zones } as never)
    const n = 16
    const out = new Float32Array(n)
    const bad = new Float32Array(n).fill(NaN)
    expect(() => k.process(n, { gate: new Float32Array(n).fill(1), nfreq: bad }, out, { sampleRate: sr })).not.toThrow()
    for (const v of out) expect(Number.isFinite(v)).toBe(true)
  })
})

describe('key zones through the REAL build path', () => {
  /* The kernel tests above construct it directly, which skips `sampleCfg` —
   * and that is exactly where the compressor's `key` was silently dropped,
   * because those mappers copy config by sweeping a list of NUMERIC keys. An
   * array falls through the same hole, so this goes synth() -> graph ->
   * compile -> kernel like a real program does. */
  const zones = [
    { lo: 0, hi: 59, name: 'low', root: 60 },
    { lo: 60, hi: 127, name: 'high', root: 60 },
  ]
  const flat = (v: number): { data: Float32Array; sampleRate: number } =>
    ({ data: Float32Array.from(Array(4000).fill(v)), sampleRate: sr })

  const play = (midi: number): number => {
    const def = synth((c) => c.sample(c.gate, 'low', { zones }))
    const r = renderOffline(def, [{ type: 'noteOn', time: 0, note: midi, velocity: 1 }], 0.2, {
      sampleRate: sr,
      samples: { low: flat(0.25), high: flat(0.75) },
    })
    let peak = 0
    for (const v of r.left) peak = Math.max(peak, Math.abs(v))
    return peak
  }

  it('a low note and a high note play DIFFERENT samples', () => {
    const lo = play(40)
    const hi = play(90)
    expect(lo, 'the low zone was silent').toBeGreaterThan(0)
    expect(hi, 'the high zone was silent').toBeGreaterThan(0)
    expect(hi, 'both notes played the same sample — zones never reached the kernel')
      .toBeGreaterThan(lo * 1.5)
  })

  it('the config survives the graph, which is the part that gets dropped', () => {
    const def = synth((c) => c.sample(c.gate, 'low', { zones }))
    const node = def.graph.nodes.find((n) => n.type === 'sample')
    expect(node?.config?.['zones'], 'zones missing from the graph').toHaveLength(2)
    expect(node?.inputs['nfreq'], 'the note never reached the kernel').toBeDefined()
  })
})
