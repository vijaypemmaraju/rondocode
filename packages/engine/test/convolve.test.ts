import { describe, expect, it } from 'vitest'
import { ConvolveKernel, ifft, normScale, prepareIr } from '../src/dsp/convolve'
import { fft } from '../src/analysis'

/* Convolution is the one node where "sounds plausible" is worth nothing: a
 * partitioned FFT convolver with an off-by-one in the frequency-delay line
 * still produces a lush wash, and it is simply the wrong answer.
 *
 * So the load-bearing test is a DIRECT CONVOLUTION REFERENCE — the textbook
 * double loop, which is far too slow to ship and exactly right — checked
 * sample for sample against what the kernel produces.
 */

const sr = 48000

/** The kernel's latency: one partition, less the sample it emits on the same
 *  tick it crunches. Measured, then pinned — see the identity test. */
const LAG = 127

function bankOf(ir: Float32Array): { get: (n: string) => { data: Float32Array; sampleRate: number } | undefined } {
  return { get: (n: string) => (n === 'ir' ? { data: ir, sampleRate: sr } : undefined) }
}

/** `mix` is a per-sample SIGNAL input now, so the harness supplies one. Pass
 *  `undefined` to exercise the absent-input default. */
function run(k: ConvolveKernel, input: Float32Array, block = 128, mix: number | undefined = 1): Float32Array {
  const out = new Float32Array(input.length)
  for (let d = 0; d < input.length; d += block) {
    const len = Math.min(block, input.length - d)
    const ins: Record<string, Float32Array> = { in: input.subarray(d, d + len) }
    if (mix !== undefined) ins['mix'] = new Float32Array(len).fill(mix)
    k.process(len, ins, out.subarray(d, d + len), { sampleRate: sr })
  }
  return out
}

/** Deterministic pseudo-random, so a failure is reproducible. */
function noise(n: number, seed = 12345): Float32Array {
  const a = new Float32Array(n)
  let s = seed
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    a[i] = (s / 0x7fffffff) * 2 - 1
  }
  return a
}

/** The textbook answer: too slow to ship, exactly right. */
function directConvolve(x: Float32Array, ir: Float32Array): Float32Array {
  const scale = normScale(ir)
  const y = new Float32Array(x.length)
  for (let i = 0; i < x.length; i++) {
    let acc = 0
    for (let j = 0; j < ir.length && j <= i; j++) acc += ir[j]! * scale * x[i - j]!
    y[i] = acc
  }
  return y
}

describe('ifft', () => {
  it('inverts fft for COMPLEX data too, imaginary part and all', () => {
    /* The convolver only ever reads the real half, so a sign error on the
     * imaginary output is invisible to it — a mutation audit proved that by
     * flipping the final conjugation and watching every other test pass.
     * `ifft` is exported, so its contract is the full inverse, not "whatever
     * the one caller happens to need". */
    const n = 128
    const re = Float64Array.from(noise(n, 11))
    const im = Float64Array.from(noise(n, 22))
    const re0 = Float64Array.from(re)
    const im0 = Float64Array.from(im)
    fft(re, im)
    ifft(re, im)
    for (let i = 0; i < n; i++) {
      expect(re[i]!, `real ${i}`).toBeCloseTo(re0[i]!, 10)
      expect(im[i]!, `imag ${i}`).toBeCloseTo(im0[i]!, 10)
    }
  })

  it('inverts fft — a round trip returns the original', () => {
    const n = 256
    const re = Float64Array.from(noise(n))
    const im = new Float64Array(n)
    const re0 = Float64Array.from(re)
    fft(re, im)
    ifft(re, im)
    for (let i = 0; i < n; i++) {
      expect(re[i]!, `sample ${i}`).toBeCloseTo(re0[i]!, 10)
      expect(im[i]!, `imag ${i}`).toBeCloseTo(0, 10)
    }
  })
})

describe('normScale', () => {
  it('gives a unit-energy scale', () => {
    const ir = new Float32Array([3, 4]) // energy 25
    expect(normScale(ir)).toBeCloseTo(1 / 5, 12)
  })

  it('is 0 for silence or emptiness, meaning "nothing to convolve with"', () => {
    expect(normScale(new Float32Array(64))).toBe(0)
    expect(normScale(new Float32Array(0))).toBe(0)
  })

  it('ignores non-finite samples rather than poisoning the whole IR', () => {
    const ir = new Float32Array([3, NaN, 4])
    expect(normScale(ir)).toBeCloseTo(1 / 5, 12)
  })
})

describe('prepareIr', () => {
  it('cuts the IR into 128-sample partitions', () => {
    expect(prepareIr(new Float32Array(128), 1e9).parts).toBe(1)
    expect(prepareIr(new Float32Array(129), 1e9).parts).toBe(2)
    expect(prepareIr(new Float32Array(512), 1e9).parts).toBe(4)
  })

  it('truncates rather than refusing an over-long IR', () => {
    // cost is linear in length; an unbounded IR would own the audio thread
    expect(prepareIr(new Float32Array(48000), 1280).parts).toBe(10)
  })

  it('always has at least one partition, even for an empty IR', () => {
    expect(prepareIr(new Float32Array(0), 1e9).parts).toBe(1)
  })
})

describe('ConvolveKernel is mathematically correct', () => {
  it('a unit-impulse IR reproduces the input EXACTLY', () => {
    /* The identity of convolution, and the sharpest test there is: any error
     * in the partitioning, the delay line or the overlap-save discard shows
     * up here as something other than the input. */
    const ir = new Float32Array(512)
    ir[0] = 1
    const input = noise(2048)
    const out = run(new ConvolveKernel('ir', bankOf(ir)), input)
    for (let i = LAG; i < input.length; i++) {
      expect(out[i]!, `sample ${i}`).toBeCloseTo(input[i - LAG]!, 6)
    }
  })

  it('matches a DIRECT convolution, sample for sample, over a multi-partition IR', () => {
    /* 700 samples is 6 partitions, so the frequency-delay line actually wraps
     * — which is where an index bug would live. */
    const ir = noise(700, 999)
    const input = noise(4096, 4242)
    const out = run(new ConvolveKernel('ir', bankOf(ir)), input)
    const ref = directConvolve(input, ir)
    for (let i = LAG; i < input.length; i++) {
      expect(out[i]!, `sample ${i}`).toBeCloseTo(ref[i - LAG]!, 5)
    }
  })

  it('matches direct convolution for an IR shorter than one partition too', () => {
    const ir = noise(37, 7)
    const input = noise(2048, 31)
    const out = run(new ConvolveKernel('ir', bankOf(ir)), input)
    const ref = directConvolve(input, ir)
    for (let i = LAG; i < input.length; i++) {
      expect(out[i]!, `sample ${i}`).toBeCloseTo(ref[i - LAG]!, 5)
    }
  })

  it('a two-tap IR produces the signal plus one delayed copy', () => {
    // the audible version of the same claim: this is an echo, and it lands
    // exactly where the second tap says
    const ir = new Float32Array(512)
    ir[0] = 1
    ir[300] = 1
    const input = new Float32Array(2048)
    input[500] = 1
    const out = run(new ConvolveKernel('ir', bankOf(ir)), input)
    const hits: number[] = []
    for (let i = 0; i < out.length; i++) if (Math.abs(out[i]!) > 0.1) hits.push(i)
    expect(hits).toEqual([500 + LAG, 800 + LAG])
  })
})

describe('ConvolveKernel behaviour', () => {
  const ir = (): Float32Array => {
    const a = new Float32Array(600)
    const src = noise(600, 5)
    for (let i = 0; i < a.length; i++) a[i] = src[i]! * Math.exp(-i / 150)
    return a
  }

  it('with NO ir loaded it passes the signal through rather than going silent', () => {
    // a missing sample should be an unprocessed sound, not a hole in the mix
    const input = noise(1024)
    const out = run(new ConvolveKernel('missing', bankOf(ir())), input)
    for (let i = 0; i < input.length; i++) expect(out[i]!).toBe(input[i]!)
  })

  it('mix 0 is the dry signal', () => {
    const input = noise(1024)
    const out = run(new ConvolveKernel('ir', bankOf(ir())), input, 128, 0)
    for (let i = 0; i < input.length; i++) expect(out[i]!).toBeCloseTo(input[i]!, 6)
  })

  it('mix 1 is NOT the dry signal — the node actually does something', () => {
    const input = noise(2048)
    const out = run(new ConvolveKernel('ir', bankOf(ir())), input)
    let diff = 0
    for (let i = LAG; i < input.length; i++) diff += Math.abs(out[i]! - input[i - LAG]!)
    expect(diff / input.length).toBeGreaterThan(0.01)
  })

  it('normalisation keeps the level sane whatever the IR is scaled to', () => {
    /* Two IRs identical but for a 100x gain must convolve to the same thing,
     * or `mix` would mean something different for every sample you load. */
    const a = ir()
    const b = Float32Array.from(a, (v) => v * 100)
    const input = noise(2048)
    const outA = run(new ConvolveKernel('ir', bankOf(a)), input)
    const outB = run(new ConvolveKernel('ir', bankOf(b)), input)
    for (let i = 0; i < outA.length; i += 37) expect(outB[i]!).toBeCloseTo(outA[i]!, 5)
  })

  it('gives the same answer across block sizes, including ragged ones', () => {
    const input = noise(4096)
    const ref = run(new ConvolveKernel('ir', bankOf(ir())), input, 128)
    for (const block of [1, 7, 64, 333, 1024]) {
      const got = run(new ConvolveKernel('ir', bankOf(ir())), input, block)
      for (let i = 0; i < input.length; i += 53) {
        expect(got[i]!, `block ${block} sample ${i}`).toBeCloseTo(ref[i]!, 5)
      }
    }
  })

  it('never emits a non-finite sample, even fed NaN', () => {
    const k = new ConvolveKernel('ir', bankOf(ir()))
    const out = new Float32Array(512)
    k.process(256, { in: new Float32Array(256).fill(NaN) }, out.subarray(0, 256), { sampleRate: sr })
    k.process(256, { in: noise(256) }, out.subarray(256), { sampleRate: sr })
    expect(out.every((v) => Number.isFinite(v))).toBe(true)
  })

  it('reset() clears the tail rather than ringing into the next thing', () => {
    const k = new ConvolveKernel('ir', bankOf(ir()))
    run(k, noise(2048))
    k.reset()
    const out = run(k, new Float32Array(2048))
    let p = 0
    for (const v of out) p = Math.max(p, Math.abs(v))
    expect(p, 'the old tail rang on after a reset').toBe(0)
  })
})
