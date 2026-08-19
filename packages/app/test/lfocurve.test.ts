import { describe, expect, it } from 'vitest'
import { lfoPath, lfoPhase, lfoValue, scanLfos, shLevels, shStep } from '../src/editor/rondo/lfocurve'
import { LfoKernel } from '@rondocode/engine'

/* ------------------------------------------------------------------------- *
 * `lfo` was the one modulation source with nothing to look at. A filter has a
 * response curve, a compressor has its transfer curve, the sidechain has its
 * pump — and the thing that MOVES all of them was five characters of text.
 *
 * A drawing of DSP is only worth having if it is the same math. So the shape
 * functions are checked against LfoKernel itself, not against what a sine
 * "should" look like: if the kernel changes, this fails rather than the
 * picture quietly becoming fiction.
 * ------------------------------------------------------------------------- */

const sr = 48000

/** What the real kernel outputs over one full cycle, sampled at `n` phases. */
function kernelCycle(shape: string, n: number): number[] {
  // 1 Hz at 48k: one cycle is exactly sr samples, so sample i/n of the way in
  const k = new LfoKernel(shape as never)
  const total = sr
  const out = new Float32Array(total)
  const freq = new Float32Array(128).fill(1)
  for (let d = 0; d < total; d += 128) {
    const len = Math.min(128, total - d)
    k.process(len, { freq: freq.subarray(0, len) }, out.subarray(d, d + len), { sampleRate: sr })
  }
  const picked: number[] = []
  for (let i = 0; i < n; i++) picked.push(out[Math.floor((i / n) * total)]!)
  return picked
}

describe('the drawn shape IS the engine shape', () => {
  for (const shape of ['sine', 'tri', 'square', 'saw'] as const) {
    it(`${shape} matches LfoKernel over a full cycle`, () => {
      const N = 32
      const fromKernel = kernelCycle(shape, N)
      for (let i = 0; i < N; i++) {
        expect(lfoValue(shape, i / N), `${shape} at phase ${i}/${N}`).toBeCloseTo(fromKernel[i]!, 4)
      }
    })
  }

  it('every shape is UNIPOLAR 0..1, which is the surprising part', () => {
    /* A `sine` lfo never goes negative. People expect an oscillator to swing
     * about zero, and a drawing that centred it would teach the wrong thing —
     * so this is asserted rather than assumed. */
    for (const shape of ['sine', 'tri', 'square', 'saw', 'rand'] as const) {
      for (let i = 0; i <= 64; i++) {
        const v = lfoValue(shape, i / 64)
        expect(v, `${shape} left 0..1`).toBeGreaterThanOrEqual(0)
        expect(v, `${shape} left 0..1`).toBeLessThanOrEqual(1)
      }
    }
  })
})

describe('the sample-and-hold sequence is the REAL one', () => {
  it('reproduces the kernel xorshift rather than drawing a plausible staircase', () => {
    /* `rand`'s steps come from a seeded generator no argument can change, so
     * the widget can show the actual sequence. If the kernel's seed or its
     * generator moves, this fails — which is the point. */
    const drawn = shLevels(6)
    /* Drive the real kernel fast enough to wrap repeatedly and read the level
     * it HOLDS in each flat stretch. The kernel latches once at construction,
     * so the very first stretch is already a drawn level — it is not a change
     * and would be missed by only watching for changes. */
    const k = new LfoKernel('rand')
    const out = new Float32Array(128)
    const freq = new Float32Array(128).fill(sr / 64) // wraps every 64 samples
    const held: number[] = []
    for (let b = 0; b < 4; b++) {
      k.process(128, { freq }, out, { sampleRate: sr })
      for (let i = 0; i < 128; i++) {
        if (held.length === 0 || out[i] !== held[held.length - 1]) held.push(out[i]!)
      }
    }
    expect(held.length, 'the kernel never latched').toBeGreaterThan(3)
    for (let i = 0; i < Math.min(drawn.length, held.length); i++) {
      expect(held[i]!, `S&H step ${i} differs from the kernel`).toBeCloseTo(drawn[i]!, 6)
    }
  })

  it('shStep is deterministic and stays in 0..1', () => {
    let st = 0x2545f491
    for (let i = 0; i < 200; i++) {
      const s = shStep(st)
      expect(s.level).toBeGreaterThanOrEqual(0)
      expect(s.level).toBeLessThan(1)
      st = s.state
    }
  })
})

describe('scanLfos reads what is written, and skips what it cannot know', () => {
  it('finds a bare lfo and defaults the shape to sine', () => {
    const [s] = scanLfos('  cut = lfo .25 -> 400..5000\n')
    expect(s).toBeDefined()
    expect(s!.shape).toBe('sine')
    expect(s!.rate).toBe(0.25)
    expect(s!.lo).toBe(400)
    expect(s!.hi).toBe(5000)
    expect(s!.sync).toBe(false)
  })

  it('reads the shape word', () => {
    expect(scanLfos('  x = lfo 2 tri\n')[0]!.shape).toBe('tri')
    expect(scanLfos('  x = lfo 2 square\n')[0]!.shape).toBe('square')
    expect(scanLfos('  x = lfo 2 rand\n')[0]!.shape).toBe('rand')
  })

  it('reads sync, which changes what the rate MEANS', () => {
    // synced, the rate is a length in transport cycles rather than Hz
    const [s] = scanLfos('  x = lfo 4 sync:1\n')
    expect(s!.sync).toBe(true)
    expect(s!.rate).toBe(4)
  })

  it('SKIPS a rate it cannot read, rather than drawing a guess', () => {
    /* The honesty rule the filter curves already follow: a picture drawn from
     * a number the program does not use is worse than no picture. */
    expect(scanLfos('  x = lfo speed\n')).toEqual([])
    expect(scanLfos('  x = lfo (knob 2 .1..8)\n')).toEqual([])
  })

  it('ignores a commented-out line', () => {
    expect(scanLfos('  # x = lfo 2 tri\n')).toEqual([])
  })

  it('finds one per line and attaches at the line end', () => {
    const src = 'synth p\n  a = lfo 1\n  b = lfo 3 saw\n'
    const found = scanLfos(src)
    expect(found).toHaveLength(2)
    expect(found[0]!.at).toBeLessThan(found[1]!.at)
    // the widget sits after the line it describes
    expect(src[found[0]!.at]).toBe('\n')
  })
})

describe('lfoPhase: where the cycle is RIGHT NOW', () => {
  it('a free-running LFO takes its phase from seconds', () => {
    expect(lfoPhase({ rate: 2, sync: false }, 0.25, undefined)).toBeCloseTo(0.5, 9)
    expect(lfoPhase({ rate: 0.5, sync: false }, 1, undefined)).toBeCloseTo(0.5, 9)
  })

  it('a SYNCED LFO takes its phase from the transport, not the clock', () => {
    /* The bug `cycleAt` exists to prevent. Wall-clock phase lands wherever the
     * audio clock happens to be after a stop, which is exactly when a marker
     * would be most obviously wrong. `rate` is a length in cycles here: 4 bars
     * per cycle means bar 2 is halfway. */
    expect(lfoPhase({ rate: 4, sync: true }, 999, 2)).toBeCloseTo(0.5, 9)
    expect(lfoPhase({ rate: 4, sync: true }, 999, 6)).toBeCloseTo(0.5, 9)
  })

  it('says nothing rather than guessing when the transport cannot answer', () => {
    expect(lfoPhase({ rate: 4, sync: true }, 1, undefined)).toBeNull()
    expect(lfoPhase({ rate: 2, sync: false }, undefined, 3)).toBeNull()
    expect(lfoPhase({ rate: 0, sync: false }, 1, 1)).toBeNull()
  })

  it('is always inside 0..1', () => {
    for (const t of [0, 0.3, 7.7, 123.456]) {
      const p = lfoPhase({ rate: 3, sync: false }, t, undefined)!
      expect(p).toBeGreaterThanOrEqual(0)
      expect(p).toBeLessThan(1)
    }
  })
})

describe('lfoPath', () => {
  it('draws a square as a STEP, not a ramp', () => {
    // two verticals and two horizontals: the discontinuity is the shape
    const d = lfoPath('square', 100, 40)
    expect(d).toBe('M0 0 L50 0 L50 40 L100 40')
  })

  it('draws saw as one straight line from bottom to top', () => {
    expect(lfoPath('saw', 100, 40)).toBe('M0 40 L100 0')
  })

  it('draws rand as flat steps', () => {
    const d = lfoPath('rand', 80, 40)
    // eight steps, each a horizontal pair
    // eight steps drawn as M + 15 L: a horizontal for each, joined by verticals
    expect((d.match(/L/g) ?? []).length).toBe(15)
    expect(d.startsWith('M0 ')).toBe(true)
  })

  it('a smooth shape stays inside the box', () => {
    const d = lfoPath('sine', 100, 40)
    for (const m of d.matchAll(/[ML](-?\d*\.?\d+) (-?\d*\.?\d+)/g)) {
      expect(Number(m[1])).toBeGreaterThanOrEqual(0)
      expect(Number(m[1])).toBeLessThanOrEqual(100)
      expect(Number(m[2])).toBeGreaterThanOrEqual(-0.001)
      expect(Number(m[2])).toBeLessThanOrEqual(40.001)
    }
  })
})
