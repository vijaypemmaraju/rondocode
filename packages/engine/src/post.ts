import { BLOCK, compilePost } from './compile'
import type { CompiledPost } from './compile'
import type { GraphSpec } from './graph'
import type { DspContext } from './dsp/types'
import { clamp } from './dsp/util'

/* ------------------------------------------------------------------------- *
 * Per-synth FX post-chain runtime. A synth's POST graph processes the SUMMED
 * voices once per instrument (not once per note) — so a reverb has ONE shared
 * tail and one set of comb/allpass buffers, instead of N of each spun up per
 * simultaneous voice.
 *
 * DSP kernels are mono, but the voice sum is stereo. PostChain runs TWO
 * independent compiled instances of the mono post graph — one for L, one for R
 * — each with its own kernel state. For reverb/chorus the two instances
 * decorrelate the channels (natural stereo width); for a plain filter it is
 * identical processing per side. Memory cost is 2× the post graph per synth
 * (vs N-voices× for a per-voice effect — the whole point).
 *
 * Signal path per synth: voices -> sum to stereo (L,R) -> postL(L), postR(R)
 * -> channel gain/pan -> sidechain duck -> master. processStereo runs in place
 * and is allocation-free (every buffer was built at compile time), so it is
 * safe on the audio thread. The SAME class runs the offline render path
 * (render-runner), so live == offline by construction.
 * ------------------------------------------------------------------------- */

/** Run one mono post instance over `io[0..n)` in place: copy the channel into
 *  the businput buffer, run the kernel steps, copy the result back out. */
const runMono = (cp: CompiledPost, io: Float32Array, n: number, ctx: DspContext): void => {
  const input = cp.input
  for (let i = 0; i < n; i++) input[i] = io[i]!
  const steps = cp.steps
  for (let s = 0; s < steps.length; s++) {
    const st = steps[s]!
    st.kernel.process(n, st.inputs, st.out, ctx)
  }
  const out = cp.out
  for (let i = 0; i < n; i++) io[i] = out[i]!
}

/** Freeverb stereo-spread (reference samples at 44100) applied to the RIGHT
 *  instance so two otherwise-identical reverbs decorrelate on identical
 *  (centered) input — the classic Freeverb width. Filters/delays are unaffected
 *  (their tunings don't depend on spread). */
const STEREO_SPREAD = 23

/** Two mono post-graph instances (L and R) with independent kernel state. */
export class PostChain {
  private readonly left: CompiledPost
  private readonly right: CompiledPost
  private readonly ctx: DspContext

  constructor(post: GraphSpec, ctx: DspContext) {
    this.ctx = ctx
    this.left = compilePost(post, ctx)
    // Right instance carries the stereo-spread so a mono (centered) sum still
    // comes out wide through a post reverb (see STEREO_SPREAD).
    this.right = compilePost(post, { ...ctx, spread: STEREO_SPREAD })
  }

  /** Process the summed stereo bus `L`/`R` (both length >= n, n <= BLOCK) in
   *  place: L through instance A, R through instance B. */
  processStereo(L: Float32Array, R: Float32Array, n: number): void {
    if (n > BLOCK) throw new RangeError(`n (${n}) exceeds BLOCK (${BLOCK})`)
    if (n <= 0) return
    runMono(this.left, L, n, this.ctx)
    runMono(this.right, R, n, this.ctx)
  }

  /** Drive a POST-chain param() by name — sets the value on both mono instances
   *  (clamped to the param spec). Returns true if the name is a post param, so
   *  callers can fall through to the voice pool otherwise. Post params are
   *  driveable exactly like voice params (via .ctrl()), just shared per-synth. */
  setParam(name: string, value: number): boolean {
    const p = this.left.params.get(name)
    if (p === undefined) return false
    const v = clamp(value, p.spec.min, p.spec.max)
    p.buf.fill(v)
    const pr = this.right.params.get(name)
    if (pr !== undefined) pr.buf.fill(v)
    return true
  }

  /** True if `name` is a param declared in the post chain. */
  hasParam(name: string): boolean {
    return this.left.params.has(name)
  }

  /** Reset both instances' kernel state (reverb tails, filter/delay memory). */
  reset(): void {
    for (const cp of [this.left, this.right]) {
      for (let s = 0; s < cp.steps.length; s++) cp.steps[s]!.kernel.reset()
    }
  }
}
