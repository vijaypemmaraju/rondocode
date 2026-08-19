import { describe, expect, it } from 'vitest'
import { DualSvfKernel, EqKernel, LadderKernel, SvfKernel } from '@rondocode/engine'
import type { DspContext, EqBand, Kernel } from '@rondocode/engine'
import {
  DB_HI,
  DB_LO,
  F_HI,
  F_LO,
  cAbs,
  dbToY,
  dualSvfResponse,
  eqResponse,
  freqToX,
  ladderResponse,
  magToDb,
  scanFilters,
  scanHandles,
  scanResponseDb,
  svfResponse,
  xToFreq,
} from '../src/editor/rondo/filtercurve'
import { scanKnobs } from '../src/editor/rondo/widgets'

/* The filter curve must not lie: every analytic |H(f)| here is pinned
 * against a GOERTZEL measurement of the real engine kernel driven with a
 * probe sine at that frequency. Probe frequencies are exact Goertzel bins
 * (f = k*sr/N) so leakage cannot blur the comparison. */

const SR = 48000
const ctx: DspContext = { sampleRate: SR }
const N = 1 << 15 // Goertzel window (settle for N, measure over N)

/** Snap `f` to the nearest exact bin of the measurement window. */
const bin = (f: number): number => (Math.max(1, Math.round((f * N) / SR)) * SR) / N

/** |H(f)| of a kernel: drive with a probe sine, discard the first window
 *  (transient), Goertzel the second (out/in amplitude ratio). */
function measure(kernel: Kernel, f: number, inputs: Record<string, number>, amp = 0.5): number {
  const w = (2 * Math.PI * f) / SR
  const block = 128
  const inBuf = new Float32Array(block)
  const outBuf = new Float32Array(block)
  const fed: Record<string, Float32Array> = { in: inBuf }
  for (const [k, v] of Object.entries(inputs)) fed[k] = new Float32Array(block).fill(v)
  let outRe = 0, outIm = 0, inRe = 0, inIm = 0
  const total = 2 * N
  for (let start = 0; start < total; start += block) {
    for (let i = 0; i < block; i++) inBuf[i] = amp * Math.sin(w * (start + i))
    kernel.process(block, fed, outBuf, ctx)
    if (start >= N) {
      for (let i = 0; i < block; i++) {
        const t = start + i
        const c = Math.cos(w * t)
        const s = Math.sin(w * t)
        outRe += outBuf[i]! * c; outIm += outBuf[i]! * s
        inRe += inBuf[i]! * c; inIm += inBuf[i]! * s
      }
    }
  }
  return Math.hypot(outRe, outIm) / Math.hypot(inRe, inIm)
}

const db = (x: number): number => 20 * Math.log10(Math.max(x, 1e-12))

describe('svfResponse vs SvfKernel (Goertzel)', () => {
  const cases: { mode: 'lp' | 'hp' | 'bp' | 'notch' | 'peak' | 'allpass'; f: number; fc: number; res: number }[] = [
    { mode: 'lp', f: 440, fc: 1000, res: 0.3 },
    { mode: 'lp', f: 4000, fc: 1000, res: 0 },
    { mode: 'hp', f: 250, fc: 2000, res: 0.5 },
    { mode: 'bp', f: 1000, fc: 1000, res: 0.6 },
    { mode: 'peak', f: 1000, fc: 1000, res: 0.7 },
    { mode: 'allpass', f: 3000, fc: 800, res: 0.4 },
    { mode: 'notch', f: 500, fc: 1000, res: 0.2 },
  ]
  for (const c of cases) {
    it(`${c.mode} fc=${c.fc} res=${c.res} @ ${c.f} Hz agrees within 0.1 dB`, () => {
      const f = bin(c.f)
      const meas = measure(new SvfKernel(c.mode), f, { cutoff: c.fc, res: c.res })
      const pred = cAbs(svfResponse(c.mode, f, c.fc, c.res, SR))
      expect(Math.abs(db(meas) - db(pred))).toBeLessThan(0.1)
    })
  }

  it('notch kills its center (predicted AND measured < -40 dB)', () => {
    const fc = bin(1000)
    const meas = measure(new SvfKernel('notch'), fc, { cutoff: fc, res: 0.3 })
    const pred = cAbs(svfResponse('notch', fc, fc, 0.3, SR))
    expect(db(meas)).toBeLessThan(-40)
    expect(db(pred)).toBeLessThan(-60)
  })

  it('lp rolls off at ~12 dB/oct above cutoff', () => {
    const a = cAbs(svfResponse('lp', 4000, 500, 0, SR))
    const b = cAbs(svfResponse('lp', 8000, 500, 0, SR))
    const slope = db(b) - db(a)
    expect(slope).toBeLessThan(-10.5)
    expect(slope).toBeGreaterThan(-14)
  })

  it('allpass is unity magnitude everywhere', () => {
    for (const f of [100, 1000, 5000, 15000]) {
      expect(cAbs(svfResponse('allpass', f, 900, 0.4, SR))).toBeCloseTo(1, 6)
    }
  })
})

describe('ladderResponse vs LadderKernel (Goertzel, linear regime)', () => {
  const cases = [
    { f: 200, fc: 1000, res: 0 },
    { f: 1000, fc: 1000, res: 0.5 },
    { f: 4000, fc: 1000, res: 0.3 },
    { f: 500, fc: 2000, res: 0.9 },
  ]
  for (const c of cases) {
    it(`fc=${c.fc} res=${c.res} @ ${c.f} Hz agrees within 0.2 dB`, () => {
      const f = bin(c.f)
      // tiny amplitude keeps the kernel's tanh in its linear region — the
      // module doc is explicit that the curve is the small-signal response
      const meas = measure(new LadderKernel(), f, { cutoff: c.fc, res: c.res }, 0.001)
      const pred = cAbs(ladderResponse(f, c.fc, c.res, SR))
      expect(Math.abs(db(meas) - db(pred))).toBeLessThan(0.2)
    })
  }

  it('rolls off at ~24 dB/oct well above cutoff', () => {
    const a = cAbs(ladderResponse(4000, 500, 0, SR))
    const b = cAbs(ladderResponse(8000, 500, 0, SR))
    const slope = db(b) - db(a)
    expect(slope).toBeLessThan(-20)
    expect(slope).toBeGreaterThan(-28)
  })
})

describe('dualSvfResponse vs DualSvfKernel (Goertzel)', () => {
  it('serial lp+lp agrees and stacks to ~24 dB/oct', () => {
    const f = bin(4000)
    const meas = measure(new DualSvfKernel({ mode: 'serial', a: 'lp', b: 'lp' }), f, { cutoff: 1000, cutoff2: 1000, res: 0.2 })
    const pred = cAbs(dualSvfResponse('serial', 'lp', 'lp', f, 1000, 1000, 0.2, SR))
    expect(Math.abs(db(meas) - db(pred))).toBeLessThan(0.1)
    const a = cAbs(dualSvfResponse('serial', 'lp', 'lp', 4000, 500, 500, 0, SR))
    const b = cAbs(dualSvfResponse('serial', 'lp', 'lp', 8000, 500, 500, 0, SR))
    const slope = db(b) - db(a)
    expect(slope).toBeLessThan(-21)
    expect(slope).toBeGreaterThan(-28)
  })

  it('serial hp-into-lp band carve agrees at the edges', () => {
    for (const probe of [150, 1200, 9000]) {
      const f = bin(probe)
      const meas = measure(new DualSvfKernel({ mode: 'serial', a: 'hp', b: 'lp' }), f, { cutoff: 400, cutoff2: 4000, res: 0.3 })
      const pred = cAbs(dualSvfResponse('serial', 'hp', 'lp', f, 400, 4000, 0.3, SR))
      expect(Math.abs(db(meas) - db(pred))).toBeLessThan(0.1)
    }
  })

  it('parallel lp+hp leaves the mid hole where the COMPLEX sum dips', () => {
    for (const probe of [100, 1400, 12000]) {
      const f = bin(probe)
      const meas = measure(new DualSvfKernel({ mode: 'parallel', a: 'lp', b: 'hp' }), f, { cutoff: 300, cutoff2: 6000, res: 0.1 })
      const pred = cAbs(dualSvfResponse('parallel', 'lp', 'hp', f, 300, 6000, 0.1, SR))
      expect(Math.abs(db(meas) - db(pred))).toBeLessThan(0.1)
    }
    // the hole is real: mid dips below both pass edges
    const mid = db(cAbs(dualSvfResponse('parallel', 'lp', 'hp', 1400, 300, 6000, 0.1, SR)))
    const lo = db(cAbs(dualSvfResponse('parallel', 'lp', 'hp', 100, 300, 6000, 0.1, SR)))
    const hi = db(cAbs(dualSvfResponse('parallel', 'lp', 'hp', 12000, 300, 6000, 0.1, SR)))
    expect(mid).toBeLessThan(lo - 6)
    expect(mid).toBeLessThan(hi - 6)
  })
})

describe('eqResponse vs EqKernel (Goertzel)', () => {
  const run = (bands: EqBand[], probe: number): { meas: number; pred: number } => {
    const f = bin(probe)
    const meas = measure(new EqKernel(bands), f, {})
    const pred = cAbs(eqResponse(bands as never, f, SR))
    return { meas, pred }
  }

  it('peak boosts its center by its gain', () => {
    const { meas, pred } = run([{ type: 'peak', freq: 1000, gain: 6, q: 2 }], 1000)
    expect(Math.abs(db(meas) - db(pred))).toBeLessThan(0.1)
    expect(db(pred)).toBeCloseTo(6, 1)
  })

  it('hp + highshelf cascade agrees across the band', () => {
    const bands: EqBand[] = [
      { type: 'hp', freq: 170 },
      { type: 'highshelf', freq: 7000, gain: 4 },
    ]
    for (const probe of [60, 400, 3000, 15000]) {
      const { meas, pred } = run(bands, probe)
      expect(Math.abs(db(meas) - db(pred))).toBeLessThan(0.1)
    }
    // shelf plateau: far above the corner the lift approaches the gain
    expect(db(cAbs(eqResponse([{ type: 'highshelf', freq: 7000, gain: 4 }], 20000, SR)))).toBeCloseTo(4, 0)
  })

  it('lowshelf and lp bands agree too', () => {
    for (const probe of [50, 250, 2000]) {
      const { meas, pred } = run([{ type: 'lowshelf', freq: 200, gain: -6, q: 1 }, { type: 'lp', freq: 8000 }], probe)
      expect(Math.abs(db(meas) - db(pred))).toBeLessThan(0.1)
    }
  })
})

/* ------------------------------- scanning --------------------------------- */

const rangeOf = (doc: string, text: string, nth = 0): { from: number; to: number } => {
  let from = -1
  for (let i = 0; i <= nth; i++) from = doc.indexOf(text, from + 1)
  expect(from).toBeGreaterThanOrEqual(0)
  return { from, to: from + text.length }
}

describe('scanFilters', () => {
  it('svf: literal cutoff + named res, mode word, exact ranges', () => {
    const doc = 'synth s1\n  svf 900 res:.3 mode:hp\n'
    const [fs] = scanFilters(doc)
    expect(fs).toBeDefined()
    expect(fs!.kind).toBe('svf')
    expect(fs!.mode).toBe('hp')
    expect(fs!.cutoffs[0]).toEqual({ value: 900, range: rangeOf(doc, '900') })
    expect(fs!.res).toEqual({ value: 0.3, range: rangeOf(doc, '.3') })
    expect(fs!.at).toBe(doc.indexOf('mode:hp') + 'mode:hp'.length)
  })

  it('ladder: res defaults to the registry 0.5; a knob cutoff falls back to its DEF (no range)', () => {
    const doc = 'synth s1\n  saw\n  ladder cutoff\n  cutoff = knob 1200 100..6000 log\n'
    const [fs] = scanFilters(doc, scanKnobs(doc))
    expect(fs).toBeDefined()
    expect(fs!.kind).toBe('ladder')
    // the DEF is what gets drawn, and the NAME is kept alongside it: a
    // knob-bound cutoff is the one case the live dot can follow, because a
    // pattern-driven param arrives in NoteEv.controls under that name. Still
    // handle-less — the text stays the only write surface for a binding.
    expect(fs!.cutoffs[0]).toEqual({ value: 1200, knob: 'cutoff' })
    expect(fs!.cutoffs[0]!.range, 'a binding is not draggable').toBeUndefined()
    expect(fs!.res).toEqual({ value: 0.5 })
  })

  it('no static cutoff value at all: NO curve (a made-up cutoff would lie)', () => {
    const doc = 'synth s1\n  wob = lfo 4 tri -> 200..2400\n  svf wob\n'
    expect(scanFilters(doc, scanKnobs(doc))).toEqual([])
  })

  it('dualsvf: two cutoffs, routing + stage modes', () => {
    const doc = 'synth s1\n  dualsvf 400 4000 mode:parallel a:lp b:hp res:.25\n'
    const [fs] = scanFilters(doc)
    expect(fs).toBeDefined()
    expect(fs!.kind).toBe('dualsvf')
    expect(fs!.routing).toBe('parallel')
    expect(fs!.a).toBe('lp')
    expect(fs!.b).toBe('hp')
    expect(fs!.cutoffs.map((c) => c.value)).toEqual([400, 4000])
    expect(fs!.cutoffs[1]!.range).toEqual(rangeOf(doc, '4000'))
  })

  it('eq: bands regrouped hp=freq/q, peak/shelf=freq/gain/q with ranges', () => {
    const doc = 'synth s1\n  post\n    eq hp 170 peak 300 -3 2 highshelf 7000 4\n'
    const [fs] = scanFilters(doc)
    expect(fs).toBeDefined()
    expect(fs!.kind).toBe('eq')
    expect(fs!.bands).toHaveLength(3)
    expect(fs!.bands[0]!.type).toBe('hp')
    expect(fs!.bands[0]!.freq).toEqual({ value: 170, range: rangeOf(doc, '170') })
    expect(fs!.bands[0]!.gain).toBeUndefined()
    expect(fs!.bands[1]!.gain).toEqual({ value: -3, range: rangeOf(doc, '-3') })
    const qFrom = doc.indexOf(' 2 ') + 1 // the lone '2' after the -3 gain
    expect(fs!.bands[1]!.q).toEqual({ value: 2, range: { from: qFrom, to: qFrom + 1 } })
    expect(fs!.bands[2]!.gain!.value).toBe(4)
  })

  it('eq with a non-literal number is skipped whole (honesty rule)', () => {
    expect(scanFilters('synth s1\n  eq peak freq -3 2\n')).toEqual([])
  })

  it('scans bus bodies; ignores comments, play blocks and filter-free lines', () => {
    const doc = [
      'bus space',
      '  svf 2000 res:.2',
      '',
      'play s1',
      '  0 3 5',
      '  # ladder 500 in a comment',
      '',
    ].join('\n')
    const scans = scanFilters(doc)
    expect(scans).toHaveLength(1)
    expect(scans[0]!.kind).toBe('svf')
    expect(scans[0]!.synth).toBeUndefined()
  })

  it('knob DEFs are scoped per synth (no cross-synth leak)', () => {
    const doc = [
      'synth a',
      '  cutoff = knob 500 100..2000',
      '',
      'synth b',
      '  svf cutoff', // no `cutoff` knob in THIS synth
      '',
    ].join('\n')
    expect(scanFilters(doc, scanKnobs(doc))).toEqual([])
  })
})

describe('geometry + handles', () => {
  it('freqToX/xToFreq round-trip on the log axis', () => {
    for (const f of [F_LO, 100, 1000, 12000, F_HI]) {
      expect(xToFreq(freqToX(f, 400), 400)).toBeCloseTo(f, 6)
    }
    expect(freqToX(F_LO, 400)).toBe(0)
    expect(freqToX(F_HI, 400)).toBe(400)
  })

  it('dbToY clamps to the display window', () => {
    expect(dbToY(DB_HI, 72)).toBe(0)
    expect(dbToY(DB_LO, 72)).toBe(72)
    expect(dbToY(0, 72)).toBeGreaterThan(0)
    expect(magToDb(1)).toBe(0)
  })

  it('scanHandles: literal args are writable, fallback args are not', () => {
    const doc = 'synth s1\n  svf 900 res:.3\n  eq hp 170 peak 300 -3 2\n'
    const scans = scanFilters(doc)
    const svfH = scanHandles(scans[0]!)
    expect(svfH).toHaveLength(1)
    expect(svfH[0]!.fRange).toBeDefined()
    expect(svfH[0]!.vRange).toBeDefined()
    expect(svfH[0]!.vKind).toBe('res')
    const eqH = scanHandles(scans[1]!)
    expect(eqH).toHaveLength(2)
    expect(eqH[0]!.vKind).toBe('none') // hp has no gain
    expect(eqH[1]!.vKind).toBe('gain')
    expect(eqH[1]!.vRange).toBeDefined()
  })

  it('scanResponseDb composes the right response per kind', () => {
    const doc = 'synth s1\n  svf 1000 res:.2 mode:notch\n'
    const [fs] = scanFilters(doc)
    expect(scanResponseDb(fs!, 1000, SR)).toBeLessThan(-40) // notch kills center
    expect(scanResponseDb(fs!, 50, SR)).toBeGreaterThan(-1)
  })
})
