import type { DspContext, Kernel } from './types'
import { clamp } from './util'

export interface FlangerConfig {
  /** Sweep rate in Hz. Clamped to [0.001, 20]. Default 0.3. */
  rate?: number
  /** Sweep depth 0..1 — how far up the 0.3 ms .. 8 ms delay range the sweep
   *  reaches. 0 parks the delay at its 0.3 ms floor (a static, very high comb).
   *  Default 0.7. */
  depth?: number
  /** Feedback around the delay, -0.95..0.95. This is what makes it a FLANGER:
   *  it turns the comb's notches into resonant peaks. Negative feedback moves
   *  the notches to the odd harmonics (the hollower, "through-zero"-ish
   *  colour). Default 0.7. */
  feedback?: number
  /** Dry/wet blend 0..1: out = in*(1-mix) + wet*mix. 0.5 (default) is the
   *  classic maximum-notch-depth setting. */
  mix?: number
}

const TWO_PI = 2 * Math.PI
/** Delay sweep floor and ceiling, in seconds. Short — that is the whole point:
 *  the comb's first notch sits at 1/(2*delay), i.e. 1.7 kHz at the floor and
 *  62 Hz at the ceiling, so the notches sweep ACROSS the audible band. */
const MIN_DELAY = 0.0003
const MAX_DELAY = 0.008
/** Inaudible-tail floor (~ -80 dBFS): once input AND output have both stayed
 *  below this for a full buffer length, the resonator has drained and the ring
 *  buffer is scrubbed to exact 0. A feedback line decays only ~feedback per
 *  round trip, so a silent tail would otherwise ring near-forever. Same device
 *  as comb.ts, with one difference that matters here: comb's output IS its
 *  buffer content, but this kernel's output is `dry + mix*read`, so between
 *  the input stopping and the delayed tap emerging (up to 8 ms) BOTH are quiet
 *  while real audio is still in flight inside the line. Draining on a single
 *  quiet block would swallow it — hence the full-buffer-length wait. */
const SETTLE_FLOOR = 1e-4

/** Flanger: one short modulated delay tap WITH feedback, mixed against the
 *  dry signal. Input 'in'; rate/depth/feedback/mix are construction config.
 *
 *  Each sample reads the line at a fractional (linear-interpolated) position
 *  `MIN + (MAX-MIN) * depth * (0.5 - 0.5*cos(phase))`, sweeping 0.3 ms .. 8 ms,
 *  and writes back `x + feedback * read` through the same soft knee delay.ts
 *  uses (identity for |v| <= 1, sign(v)*(2 - 1/|v|) above), so runaway
 *  feedback saturates instead of exploding. The output is
 *  `x*(1-mix) + read*mix`.
 *
 *  HOW THIS DIFFERS FROM chorus(), concretely. Chorus is three taps averaged
 *  around an ~11 ms base delay with NO feedback: the three combs' notches land
 *  in different places and average each other away, and with no loop the
 *  transfer magnitude can never exceed unity — it is a thickener. A flanger is
 *  ONE tap, an order of magnitude shorter, fed back on itself: the notches
 *  stay sharp and evenly spaced (harmonically related, which is why it sounds
 *  pitched), and the feedback loop builds RESONANT PEAKS well above unity
 *  between them. Measured from the impulse response with a nearly static
 *  sweep at mix 0.5: chorus tops out at |H| = 1.000 (it cannot exceed unity by
 *  construction), while this kernel at feedback 0.8 peaks at |H| = 2.74 and
 *  notches at 0.22 — that jet-engine whoosh is resonant peaks sweeping, not
 *  just notches.
 *
 *  Stereo: this kernel is mono. In a post chain it runs TWICE, once per side;
 *  the right instance (marked by a nonzero ctx.spread, see post.ts) starts its
 *  LFO in quadrature, so the two sides sweep a quarter cycle apart and the
 *  flange swirls across the image instead of moving in lockstep.
 *
 *  Buffers: the ring buffer is allocated EAGERLY at construction from
 *  ctx.sampleRate (like delay.ts), so steady-state process() is
 *  allocation-free; without ctx it allocates lazily on the first process().
 *
 *  Hygiene: the block-end pass zeroes the buffer on a non-finite write, and
 *  drains the line to exact 0 once input and output have BOTH stayed silent
 *  for a full buffer length (see SETTLE_FLOOR — the wait is what keeps audio
 *  still in flight from being erased), so the feedback loop cannot idle on
 *  denormals. */
export class FlangerKernel implements Kernel {
  private readonly rate: number
  private readonly depth: number
  private readonly feedback: number
  private readonly mix: number
  private buf: Float32Array | null = null
  private writeIdx = 0
  /** LFO phase in radians, [0, 2*pi). */
  private phase = 0
  /** Consecutive samples with input AND output under SETTLE_FLOOR. */
  private quiet = 0
  /** The phase this instance STARTS at (quadrature on the right side), so
   *  reset() restores the stereo offset instead of collapsing both sides to 0. */
  private readonly phase0: number

  constructor(config: FlangerConfig = {}, ctx?: DspContext) {
    this.rate = clamp(config.rate ?? 0.3, 0.001, 20)
    this.depth = clamp(config.depth ?? 0.7, 0, 1)
    this.feedback = clamp(config.feedback ?? 0.7, -0.95, 0.95)
    this.mix = clamp(config.mix ?? 0.5, 0, 1)
    if (ctx) this.buf = new Float32Array(Math.ceil(MAX_DELAY * ctx.sampleRate) + 2)
    // Quadrature start on the RIGHT post instance so the two mono flangers
    // don't sweep identically from identical (centered) input — see class doc.
    this.phase0 = (ctx?.spread ?? 0) > 0 ? Math.PI / 2 : 0
    this.phase = this.phase0
  }

  process(n: number, inputs: Record<string, Float32Array>, out: Float32Array, ctx: DspContext): void {
    const input = inputs['in']!
    const sr = ctx.sampleRate
    const buf = this.buf ?? (this.buf = new Float32Array(Math.ceil(MAX_DELAY * sr) + 2))
    const len = buf.length
    const maxDelay = len - 2
    const base = MIN_DELAY * sr
    const span = (MAX_DELAY - MIN_DELAY) * this.depth * sr
    const fb = this.feedback
    const mix = this.mix
    const dry = 1 - mix
    const inc = (TWO_PI * this.rate) / sr
    let p = this.phase
    let w = this.writeIdx
    let inPeak = 0
    let outPeak = 0

    for (let i = 0; i < n; i++) {
      const x = input[i]!
      const ax = x < 0 ? -x : x
      if (ax > inPeak) inPeak = ax
      let d = base + span * (0.5 - 0.5 * Math.cos(p))
      if (!(d >= 1)) d = 1
      else if (d > maxDelay) d = maxDelay
      const di = Math.floor(d)
      const frac = d - di
      let r0 = w - di
      if (r0 < 0) r0 += len
      let r1 = r0 - 1
      if (r1 < 0) r1 += len
      const read = buf[r0]! + frac * (buf[r1]! - buf[r0]!)
      const y = x * dry + read * mix
      out[i] = y
      const ay = y < 0 ? -y : y
      if (ay > outPeak) outPeak = ay
      // recirculate through delay.ts's slope-matched soft knee
      let v = x + fb * read
      if (v > 1) v = 2 - 1 / v
      else if (v < -1) v = -2 - 1 / v
      buf[w] = v
      w++
      if (w >= len) w = 0
      p += inc
      if (p >= TWO_PI) p -= TWO_PI
    }

    // Block-end hygiene: zero the buffer on a poison write, and drain a fully
    // silent resonator to exact 0 once nothing can still be in flight (see
    // SETTLE_FLOOR).
    const last = buf[w === 0 ? len - 1 : w - 1]!
    if (!Number.isFinite(last)) {
      buf.fill(0)
      this.quiet = 0
    } else if (inPeak < SETTLE_FLOOR && outPeak < SETTLE_FLOOR) {
      this.quiet += n
      if (this.quiet >= len) buf.fill(0)
    } else {
      this.quiet = 0
    }
    this.writeIdx = w
    this.phase = Number.isFinite(p) ? p : 0
  }

  reset(): void {
    this.writeIdx = 0
    this.phase = this.phase0
    this.quiet = 0
    this.buf?.fill(0)
  }
}
