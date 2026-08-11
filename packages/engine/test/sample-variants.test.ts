import { describe, expect, it } from 'vitest'
import { SampleBank, parseSampleRef, sampleRefName } from '../src/samples'
import { SampleKernel } from '../src/dsp/sample'

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
