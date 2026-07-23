import type { DspContext, Kernel } from './types'
import { clamp, flush } from './util'

/** Finite value or default — bad band fields (a NaN freq/gain/q from a
 *  live-coded variable) must not poison the coefficients. */
const finiteOr = (v: unknown, def: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : def

/** A parametric-EQ band. `peak` is a bell; `lowshelf`/`highshelf` tilt one end;
 *  `lp`/`hp` are 12 dB/oct cuts (gain ignored). freq in Hz, gain in dB, q is
 *  bell/shelf sharpness (higher = narrower). */
export type EqBandType = 'lowshelf' | 'highshelf' | 'peak' | 'lp' | 'hp'

export interface EqBand {
  type?: EqBandType
  freq?: number
  gain?: number
  q?: number
}

interface Biquad {
  b0: number; b1: number; b2: number; a1: number; a2: number
  x1: number; x2: number; y1: number; y2: number
}

const makeBiquad = (): Biquad => ({ b0: 1, b1: 0, b2: 0, a1: 0, a2: 0, x1: 0, x2: 0, y1: 0, y2: 0 })

/** RBJ audio-EQ cookbook coefficients (normalized by a0) for one band at `sr`. */
const setCoeffs = (bq: Biquad, band: EqBand, sr: number): void => {
  const type = band.type ?? 'peak'
  const freq = clamp(finiteOr(band.freq, 1000), 10, sr * 0.49)
  const gainDb = clamp(finiteOr(band.gain, 0), -48, 48)
  const q = clamp(finiteOr(band.q, 0.707), 0.1, 24)
  const w0 = (2 * Math.PI * freq) / sr
  const cosw = Math.cos(w0)
  const sinw = Math.sin(w0)
  const A = Math.pow(10, gainDb / 40)
  const alpha = sinw / (2 * q)
  let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0
  switch (type) {
    case 'lp':
      b0 = (1 - cosw) / 2; b1 = 1 - cosw; b2 = (1 - cosw) / 2
      a0 = 1 + alpha; a1 = -2 * cosw; a2 = 1 - alpha
      break
    case 'hp':
      b0 = (1 + cosw) / 2; b1 = -(1 + cosw); b2 = (1 + cosw) / 2
      a0 = 1 + alpha; a1 = -2 * cosw; a2 = 1 - alpha
      break
    case 'peak':
      b0 = 1 + alpha * A; b1 = -2 * cosw; b2 = 1 - alpha * A
      a0 = 1 + alpha / A; a1 = -2 * cosw; a2 = 1 - alpha / A
      break
    case 'lowshelf': {
      const s = 2 * Math.sqrt(A) * alpha
      b0 = A * (A + 1 - (A - 1) * cosw + s)
      b1 = 2 * A * (A - 1 - (A + 1) * cosw)
      b2 = A * (A + 1 - (A - 1) * cosw - s)
      a0 = A + 1 + (A - 1) * cosw + s
      a1 = -2 * (A - 1 + (A + 1) * cosw)
      a2 = A + 1 + (A - 1) * cosw - s
      break
    }
    case 'highshelf': {
      const s = 2 * Math.sqrt(A) * alpha
      b0 = A * (A + 1 + (A - 1) * cosw + s)
      b1 = -2 * A * (A - 1 + (A + 1) * cosw)
      b2 = A * (A + 1 + (A - 1) * cosw - s)
      a0 = A + 1 - (A - 1) * cosw + s
      a1 = 2 * (A - 1 - (A + 1) * cosw)
      a2 = A + 1 - (A - 1) * cosw - s
      break
    }
  }
  bq.b0 = b0 / a0
  bq.b1 = b1 / a0
  bq.b2 = b2 / a0
  bq.a1 = a1 / a0
  bq.a2 = a2 / a0
}

/** Parametric EQ: a cascade of RBJ biquads (one per band), run in series on a
 *  mono signal. Bands are construction config (dial it in, not per-sample
 *  automated). An empty band list is a pass-through. */
export class EqKernel implements Kernel {
  private readonly bands: EqBand[]
  private readonly biquads: Biquad[]
  private sr = 0

  constructor(bands: EqBand[]) {
    this.bands = Array.isArray(bands) ? bands : []
    this.biquads = this.bands.map(makeBiquad)
  }

  process(n: number, inputs: Record<string, Float32Array>, out: Float32Array, ctx: DspContext): void {
    const input = inputs['in']!
    if (ctx.sampleRate !== this.sr) {
      this.sr = ctx.sampleRate
      for (let k = 0; k < this.bands.length; k++) setCoeffs(this.biquads[k]!, this.bands[k]!, this.sr)
    }
    const bqs = this.biquads
    const m = bqs.length
    for (let i = 0; i < n; i++) {
      let x = input[i]!
      for (let k = 0; k < m; k++) {
        const bq = bqs[k]!
        const y = bq.b0 * x + bq.b1 * bq.x1 + bq.b2 * bq.x2 - bq.a1 * bq.y1 - bq.a2 * bq.y2
        bq.x2 = bq.x1
        bq.x1 = x
        bq.y2 = bq.y1
        bq.y1 = y
        x = y
      }
      out[i] = Number.isFinite(x) ? x : 0
    }
    // Scrub state so one transient NaN/denormal can't latch a biquad into
    // permanent silence (recover like the core filters, which flush() too).
    for (let k = 0; k < m; k++) {
      const bq = bqs[k]!
      bq.x1 = flush(bq.x1); bq.x2 = flush(bq.x2); bq.y1 = flush(bq.y1); bq.y2 = flush(bq.y2)
    }
  }

  reset(): void {
    for (const bq of this.biquads) {
      bq.x1 = bq.x2 = bq.y1 = bq.y2 = 0
    }
  }
}
