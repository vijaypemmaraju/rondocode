import type { DspContext, Kernel, SampleBankRO } from './types'
import { clamp } from './util'
import { fft } from '../analysis'

/* ------------------------------------------------------------------------- *
 * CONVOLUTION: play a signal THROUGH a recorded space.
 *
 * `reverb` is algorithmic — a network of delays and allpasses tuned to sound
 * like a room. It is cheap, it is tweakable in real time (`room`, `damp`), and
 * it sounds like itself. Convolution is the other kind: you hand it the
 * IMPULSE RESPONSE of an actual space (or a plate, or a speaker cabinet, or a
 * snare drum) and it reproduces that thing exactly, because the impulse
 * response IS the space, completely. What you cannot do is turn a knob and
 * make the room bigger; you would need a different measurement.
 *
 * THE IR IS A SAMPLE, resolved from the same bank `sample()` reads, so a
 * loaded WAV works and so does a generated one. `hall` ships built in.
 *
 * WHY THIS IS NOT A for-LOOP. Direct convolution costs one multiply per IR
 * sample per output sample: a 1-second IR at 48 kHz is 48,000 multiplies for
 * every sample you produce, which is roughly two thousand times realtime. The
 * standard answer is UNIFORM PARTITIONED OVERLAP-SAVE:
 *
 *   the IR is cut into blocks of B samples and each is FFT'd once, up front
 *   the input keeps a frequency-delay line of its last P block spectra
 *   each block, the output spectrum is the sum of P complex products, and one
 *     inverse FFT turns it back into audio
 *
 * That trades P*B multiplies for P complex multiply-accumulates plus two
 * transforms, and it is what makes a real IR affordable.
 *
 * IT COSTS ONE PARTITION OF LATENCY — 128 samples, 2.67 ms at 48 kHz. That is
 * not an implementation shortcut but the method: you cannot transform a block
 * of input before you have all of it. Zero-latency convolvers avoid it by
 * convolving the head of the IR directly and only partitioning the tail, which
 * is a much larger machine for 2.67 ms. Worth knowing about if this ever goes
 * in front of a performer monitoring themselves.
 *
 * THE IR IS NORMALISED TO UNIT ENERGY. Convolving with a raw IR multiplies
 * level by roughly the square root of its energy, which for a big hall is a
 * lot; a node whose output level depends on how loud someone recorded a
 * starter pistol is not usable. Normalising means `mix` means the same thing
 * whatever IR you point it at.
 * ------------------------------------------------------------------------- */

/** Partition size. Matches the engine's render quantum so a block of input
 *  produces exactly one block of output with no extra buffering. */
const PART = 128
/** Transform length: twice the partition, which is what overlap-save needs to
 *  keep the circular convolution's wrap-around in the half we discard. */
const NFFT = PART * 2

/** Longest IR used, seconds. A cap is necessary rather than tidy: cost is
 *  linear in IR length, and past a few seconds one convolver would own the
 *  audio thread. Longer IRs are truncated, not refused. */
const MAX_IR_SEC = 4

export interface ConvolveConfig {
  /* No construction-time fields. `mix` is a per-sample SIGNAL input — it was
   * declared `sig` in the rondo registry while this read it as a number, so
   * `convolve hall mix:(lfo .2 -> 0..1)` compiled, ran, and silently used the
   * default. The API said you could automate it; the kernel disagreed. */
}

/** In-place inverse FFT, built from the forward one by conjugation:
 *  ifft(x) = conj(fft(conj(x))) / n. Sharing the forward transform means
 *  there is one FFT in the engine rather than two that can disagree. */
export function ifft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  for (let i = 0; i < n; i++) im[i] = -im[i]!
  fft(re, im)
  const inv = 1 / n
  for (let i = 0; i < n; i++) {
    re[i] = re[i]! * inv
    im[i] = -im[i]! * inv
  }
}

/** Scale factor that gives an impulse response unit energy. 0 for an empty or
 *  silent IR, which the caller reads as "nothing to convolve with". */
export function normScale(ir: Float32Array): number {
  let e = 0
  for (const v of ir) if (Number.isFinite(v)) e += v * v
  return e > 0 ? 1 / Math.sqrt(e) : 0
}

/** The IR, cut into partitions and transformed once. */
interface PreparedIr {
  /** The buffer this was built from — identity is the cache key. */
  source: Float32Array
  re: Float64Array[]
  im: Float64Array[]
  parts: number
}

/** Cut `ir` into PART-sized blocks, normalise, and transform each. Exported
 *  because the partitioning is the part worth testing on its own. */
export function prepareIr(ir: Float32Array, maxSamples: number): PreparedIr {
  const scale = normScale(ir)
  const len = Math.min(ir.length, maxSamples)
  const parts = Math.max(1, Math.ceil(len / PART))
  const re: Float64Array[] = []
  const im: Float64Array[] = []
  for (let p = 0; p < parts; p++) {
    const r = new Float64Array(NFFT)
    const i = new Float64Array(NFFT)
    for (let k = 0; k < PART; k++) {
      const idx = p * PART + k
      const v = idx < len ? ir[idx]! : 0
      r[k] = Number.isFinite(v) ? v * scale : 0
    }
    fft(r, i)
    re.push(r)
    im.push(i)
  }
  return { source: ir, re, im, parts }
}

export class ConvolveKernel implements Kernel {
  private prepared: PreparedIr | null = null

  /** Frequency-delay line of past input spectra, newest at `fdlHead`. */
  private fdlRe: Float64Array[] = []
  private fdlIm: Float64Array[] = []
  private fdlHead = 0

  /** The previous partition of input, kept because overlap-save transforms
   *  the last 2B samples each time. */
  private prev = new Float32Array(PART)
  /** Input accumulated toward the next full partition. */
  private inBuf = new Float32Array(PART)
  private inFill = 0
  /** Finished output waiting to be handed back, and how much is unread. */
  private outBuf = new Float32Array(PART)
  private outReady = 0
  private outPos = 0

  private readonly scratchRe = new Float64Array(NFFT)
  private readonly scratchIm = new Float64Array(NFFT)
  private readonly accRe = new Float64Array(NFFT)
  private readonly accIm = new Float64Array(NFFT)

  constructor(
    private readonly name: string,
    private readonly bank: SampleBankRO | undefined,
    _cfg: ConvolveConfig = {},
  ) {}

  /** Resolve the IR, re-preparing only when the bank hands us a new buffer.
   *  Returns false when there is nothing to convolve with. */
  private ensureIr(sr: number): boolean {
    const s = this.bank?.get(this.name)
    if (s === undefined || s.data.length === 0) return false
    if (this.prepared?.source !== s.data) {
      this.prepared = prepareIr(s.data, Math.round(MAX_IR_SEC * sr))
      const p = this.prepared.parts
      this.fdlRe = Array.from({ length: p }, () => new Float64Array(NFFT))
      this.fdlIm = Array.from({ length: p }, () => new Float64Array(NFFT))
      this.fdlHead = 0
      this.prev.fill(0)
      this.inFill = 0
      this.outReady = 0
      this.outPos = 0
    }
    return true
  }

  /** Transform one full partition of input and produce one of output. */
  private crunch(): void {
    const ir = this.prepared!
    const P = ir.parts
    // overlap-save: transform [previous partition | this partition]
    const re = this.scratchRe
    const im = this.scratchIm
    for (let i = 0; i < PART; i++) {
      re[i] = this.prev[i]!
      re[PART + i] = this.inBuf[i]!
      im[i] = 0
      im[PART + i] = 0
    }
    fft(re, im)
    // newest spectrum goes at the head of the delay line
    this.fdlHead = (this.fdlHead - 1 + P) % P
    this.fdlRe[this.fdlHead]!.set(re)
    this.fdlIm[this.fdlHead]!.set(im)

    this.accRe.fill(0)
    this.accIm.fill(0)
    for (let p = 0; p < P; p++) {
      const xr = this.fdlRe[(this.fdlHead + p) % P]!
      const xi = this.fdlIm[(this.fdlHead + p) % P]!
      const hr = ir.re[p]!
      const hi = ir.im[p]!
      const ar = this.accRe
      const ai = this.accIm
      for (let k = 0; k < NFFT; k++) {
        // complex multiply-accumulate: the inner loop of the whole node
        ar[k] = ar[k]! + xr[k]! * hr[k]! - xi[k]! * hi[k]!
        ai[k] = ai[k]! + xr[k]! * hi[k]! + xi[k]! * hr[k]!
      }
    }
    ifft(this.accRe, this.accIm)
    // the FIRST half is circular wrap-around and is discarded; the second is
    // the true linear convolution. That discard IS overlap-save.
    for (let i = 0; i < PART; i++) {
      const v = this.accRe[PART + i]!
      this.outBuf[i] = Number.isFinite(v) ? v : 0
    }
    this.prev.set(this.inBuf)
    this.inFill = 0
    this.outReady = PART
    this.outPos = 0
  }

  process(n: number, inputs: Record<string, Float32Array>, out: Float32Array, ctx: DspContext): void {
    const input = inputs['in']!
    if (!this.ensureIr(ctx.sampleRate)) {
      // no IR loaded: pass the signal through rather than going silent, so a
      // missing sample is an unprocessed sound and not a hole in the mix
      out.set(input.subarray(0, n))
      return
    }
    const mixIn = inputs['mix']
    for (let i = 0; i < n; i++) {
      const x = Number.isFinite(input[i]!) ? input[i]! : 0
      this.inBuf[this.inFill++] = x
      if (this.inFill === PART) this.crunch()
      const w = this.outReady > 0 ? this.outBuf[this.outPos]! : 0
      if (this.outReady > 0) {
        this.outPos++
        if (this.outPos >= PART) this.outReady = 0
      }
      const wet = clamp(mixIn === undefined ? 0.35 : (Number.isFinite(mixIn[i]!) ? mixIn[i]! : 0.35), 0, 1)
      out[i] = (1 - wet) * x + wet * w
    }
  }

  reset(): void {
    this.prev.fill(0)
    this.inBuf.fill(0)
    this.outBuf.fill(0)
    this.inFill = 0
    this.outReady = 0
    this.outPos = 0
    for (const a of this.fdlRe) a.fill(0)
    for (const a of this.fdlIm) a.fill(0)
  }
}
