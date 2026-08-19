import { describe, expect, it } from 'vitest'
import { ChorusKernel } from '../src/dsp/chorus'
import { PhaserKernel } from '../src/dsp/fx2'
import { FlangerKernel } from '../src/dsp/flanger'
import { ctl } from '../src/dsp/util'

/* ------------------------------------------------------------------------- *
 * The three modulation effects read rate/depth/feedback/mix ONCE at
 * construction, so no LFO and no knob could ride them — on exactly the three
 * nodes people most want to automate. `reverb.mix`, `delay.mix`,
 * `supersaw.detune` and `ladder.res` were all signals; these were not, and the
 * rondo registry said `num` for them, honestly, which is how it went unnoticed.
 *
 * They are per-sample inputs now. These tests assert the property that makes
 * that true rather than the plumbing: a control that CHANGES over the block
 * must produce different audio from the same control held constant. A kernel
 * that read its input once at sample 0 would pass every "does it accept an
 * input" test and fail every one of these.
 * ------------------------------------------------------------------------- */

const sr = 48000

/** A signal that ramps 0..1 across the block — the simplest thing a constant
 *  cannot imitate. */
const ramp = (n: number, lo: number, hi: number): Float32Array => {
  const a = new Float32Array(n)
  for (let i = 0; i < n; i++) a[i] = lo + ((hi - lo) * i) / (n - 1)
  return a
}

const constant = (n: number, v: number): Float32Array => new Float32Array(n).fill(v)

const saw = (n: number, hz: number): Float32Array => {
  const a = new Float32Array(n)
  for (let i = 0; i < n; i++) a[i] = 2 * (((i * hz) / sr) % 1) - 1
  return a
}

/** Run a kernel over a signal, block by block, with fixed control inputs. */
function run(
  k: { process: (n: number, i: Record<string, Float32Array>, o: Float32Array, c: { sampleRate: number }) => void },
  input: Float32Array,
  controls: Record<string, Float32Array>,
): Float32Array {
  const out = new Float32Array(input.length)
  const BLOCK = 128
  for (let d = 0; d < input.length; d += BLOCK) {
    const len = Math.min(BLOCK, input.length - d)
    const ins: Record<string, Float32Array> = { in: input.subarray(d, d + len) }
    for (const [k2, v] of Object.entries(controls)) ins[k2] = v.subarray(d, d + len)
    k.process(len, ins, out.subarray(d, d + len), { sampleRate: sr })
  }
  return out
}

const meanAbsDiff = (a: Float32Array, b: Float32Array): number => {
  let s = 0
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i]! - b[i]!)
  return s / a.length
}

describe('ctl (how a kernel reads a control that may be a signal)', () => {
  it('uses the input when there is one', () => {
    expect(ctl(new Float32Array([0.25]), 0, 0.9, 0, 1)).toBe(0.25)
  })

  it('falls back to the constructor value when there is not', () => {
    expect(ctl(undefined, 0, 0.9, 0, 1)).toBe(0.9)
  })

  it('clamps, so a signal cannot reach further than a number could', () => {
    expect(ctl(new Float32Array([5]), 0, 0.5, 0, 1)).toBe(1)
    expect(ctl(new Float32Array([-5]), 0, 0.5, 0, 1)).toBe(0)
  })

  it('falls back rather than propagating a non-finite sample', () => {
    expect(ctl(new Float32Array([NaN]), 0, 0.4, 0, 1)).toBe(0.4)
  })
})

const N = sr / 2

/* Each case: the kernel, the control, its constant value, and the range a
 * ramp sweeps. A held control and a moving one must not agree. */
const CASES: {
  node: string
  make: () => { process: (n: number, i: Record<string, Float32Array>, o: Float32Array, c: { sampleRate: number }) => void }
  control: string
  held: number
  from: number
  to: number
}[] = [
  { node: 'chorus', make: () => new ChorusKernel({}), control: 'rate', held: 0.6, from: 0.1, to: 6 },
  { node: 'chorus', make: () => new ChorusKernel({}), control: 'depth', held: 0.003, from: 0, to: 0.03 },
  { node: 'chorus', make: () => new ChorusKernel({}), control: 'mix', held: 0.5, from: 0, to: 1 },
  { node: 'phaser', make: () => new PhaserKernel({}), control: 'rate', held: 0.5, from: 0.1, to: 8 },
  { node: 'phaser', make: () => new PhaserKernel({}), control: 'depth', held: 0.7, from: 0, to: 1 },
  { node: 'phaser', make: () => new PhaserKernel({}), control: 'feedback', held: 0.4, from: 0, to: 0.85 },
  { node: 'phaser', make: () => new PhaserKernel({}), control: 'mix', held: 0.5, from: 0, to: 1 },
  { node: 'flanger', make: () => new FlangerKernel({}), control: 'rate', held: 0.3, from: 0.05, to: 5 },
  { node: 'flanger', make: () => new FlangerKernel({}), control: 'depth', held: 0.7, from: 0, to: 1 },
  { node: 'flanger', make: () => new FlangerKernel({}), control: 'feedback', held: 0.7, from: -0.9, to: 0.9 },
  { node: 'flanger', make: () => new FlangerKernel({}), control: 'mix', held: 0.5, from: 0, to: 1 },
]

describe('a control that MOVES sounds different from one that is held', () => {
  const input = saw(N, 220)

  for (const c of CASES) {
    it(`${c.node}.${c.control}`, () => {
      const still = run(c.make(), input, { [c.control]: constant(N, c.held) })
      const moving = run(c.make(), input, { [c.control]: ramp(N, c.from, c.to) })
      expect(
        meanAbsDiff(still, moving),
        `${c.node}.${c.control} is read once instead of per sample — an LFO on it does nothing`,
      ).toBeGreaterThan(1e-4)
    })
  }
})

describe('a control input replaces the constructor value', () => {
  const input = saw(N, 220)

  for (const c of CASES) {
    it(`${c.node}.${c.control}`, () => {
      /* Not the same claim as above: a kernel could honour a MOVING input and
       * still ignore a constant one that differs from its config. */
      const fromConfig = run(c.make(), input, {})
      const fromInput = run(c.make(), input, { [c.control]: constant(N, c.to) })
      expect(
        meanAbsDiff(fromConfig, fromInput),
        `${c.node}.${c.control}: a constant input did not override the constructor value`,
      ).toBeGreaterThan(1e-4)
    })
  }
})

describe('the control is read PER SAMPLE, not once per block', () => {
  /* The distinction a ramp cannot make. The kernels run in 128-sample blocks,
   * so a control read at index 0 STILL moves — once per block — and produces
   * audibly different output from a held one. A mutation audit proved it:
   * changing `ctl(rateIn, i, …)` to `ctl(rateIn, 0, …)` survived every test
   * above.
   *
   * So: ONE block, with a control that sweeps inside it, against a constant
   * equal to that control's FIRST sample. Per-sample reading differs;
   * block-rate reading is bit-identical, because index 0 is all it ever sees.
   */
  const BLOCK = 128
  /* Warm up first: these are delay-line effects and the line starts EMPTY, so
   * in the very first block the wet path is silence and rate/depth cannot
   * matter however they are read. Measured — chorus.rate and chorus.depth both
   * showed exactly 0 difference until the line was primed. */
  const WARMUP = 24
  const input = saw(BLOCK, 220)

  const measuredBlock = (
    k: { process: (n: number, i: Record<string, Float32Array>, o: Float32Array, c: { sampleRate: number }) => void },
    control: string,
    warm: number,
    last: Float32Array,
  ): Float32Array => {
    const scratch = new Float32Array(BLOCK)
    const hold = constant(BLOCK, warm)
    for (let b = 0; b < WARMUP; b++) {
      k.process(BLOCK, { in: input, [control]: hold }, scratch, { sampleRate: sr })
    }
    const out = new Float32Array(BLOCK)
    k.process(BLOCK, { in: input, [control]: last }, out, { sampleRate: sr })
    return out
  }

  for (const c of CASES) {
    it(`${c.node}.${c.control}`, () => {
      const sweeping = ramp(BLOCK, c.from, c.to)
      const held = constant(BLOCK, sweeping[0]!)
      // identical warmup on both sides, so only the LAST block differs
      const a = measuredBlock(c.make(), c.control, sweeping[0]!, sweeping)
      const b = measuredBlock(c.make(), c.control, sweeping[0]!, held)
      expect(
        meanAbsDiff(a, b),
        `${c.node}.${c.control} only sees the first sample of each block — it updates at `
          + `block rate, not sample rate`,
      ).toBeGreaterThan(1e-7)
    })
  }
})

describe('and the defaults did not move', () => {
  /* The migration must not have changed how these sound with no arguments —
   * every shipped example using a bare `chorus` would drift otherwise. */
  const input = saw(N, 220)

  it('a kernel with no inputs matches one fed its own documented defaults', () => {
    const pairs: [string, Float32Array, Float32Array][] = [
      ['chorus', run(new ChorusKernel({}), input, {}),
        run(new ChorusKernel({}), input, { rate: constant(N, 0.6), depth: constant(N, 0.003), mix: constant(N, 0.5) })],
      ['phaser', run(new PhaserKernel({}), input, {}),
        run(new PhaserKernel({}), input, { rate: constant(N, 0.5), depth: constant(N, 0.7), feedback: constant(N, 0.4), mix: constant(N, 0.5) })],
      ['flanger', run(new FlangerKernel({}), input, {}),
        run(new FlangerKernel({}), input, { rate: constant(N, 0.3), depth: constant(N, 0.7), feedback: constant(N, 0.7), mix: constant(N, 0.5) })],
    ]
    for (const [name, a, b] of pairs) {
      expect(meanAbsDiff(a, b), `${name}'s no-argument sound changed`).toBeLessThan(1e-6)
    }
  })
})
