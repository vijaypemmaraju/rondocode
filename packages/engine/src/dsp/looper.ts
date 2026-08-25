import type { DspContext, Kernel } from './types'
import { clamp } from './util'

export interface LooperConfig {
  /** Maximum loop length in seconds (sets the buffer size). Default 10. */
  maxTime?: number
  /** Register this pedal in ctx.loopers under `name`, so the host can BOUNCE
   *  its loop out (engine message `bounceLoop`) into the sample bank. Name a
   *  looper in a POST chain or bus: a voice-graph looper constructs once per
   *  voice and each registration overwrites the last. (A post chain runs two
   *  mono instances, L then R — the R instance wins, and a bounce is mono
   *  like every other sample.) */
  name?: string
}

/** LOOP PEDAL. Inputs 'in', 'rec' (gate), 'feedback' (clamped to [0, 1],
 *  default 1), 'mix' (loop level, clamped to [0, 1], default 1) and 'clear'
 *  (trigger). Output is the DRY INPUT PLUS the loop: out = in + mix * loop.
 *  A pedal never mutes the player, so unlike delay's wet/dry crossfade the
 *  dry path here is untouched at every mix setting; mix is the LOOP's level.
 *
 *  The state machine is the one every hardware pedal ships:
 *
 *  - EMPTY: output is the dry input. A rising edge on 'rec' starts the FIRST
 *    RECORDING, and the time 'rec' then stays high IS the loop length — there
 *    is no length setting, the performance defines it, which is why a
 *    pattern- or knob-driven gate quantizes the loop for free.
 *  - The falling edge ends the first recording: its length is latched and
 *    playback starts immediately from the top.
 *  - PLAYING: the loop repeats, sample-exact (the read head advances by one
 *    sample per sample — no resampling, so layer N is bit-identical on every
 *    pass while feedback is 1).
 *  - OVERDUB: any later time 'rec' is high, the input is SUMMED onto the loop
 *    as it plays: buf = buf * feedback + in. Feedback applies only to these
 *    overdub writes — parked at 1 the pedal holds every layer forever;
 *    lowered, each pass of overdubbing fades what came before (the
 *    frippertronics decay), and NOT overdubbing never erodes anything.
 *  - A rising edge on 'clear' wipes the loop and returns to EMPTY. The next
 *    'rec' press defines a brand-new length. (First recording always ASSIGNS
 *    into the buffer rather than summing, so clear does not need to zero it.)
 *
 *  If the first recording runs past the buffer (maxTime seconds), the loop
 *  closes at the buffer length and starts playing — memory full behaves like
 *  a pedal, not like an error.
 *
 *  Writes go through the same soft knee as delay (identity for |v| <= 1,
 *  asymptote at ±2, value- and slope-matched at the join), so a tall stack of
 *  overdubbed layers saturates smoothly instead of clipping; with feedback
 *  <= 1 and bounded input every write stays below ±2.
 *
 *  Lifecycle: kernels are NOT reset on retrigger or steal (voice.ts), so a
 *  loop on a spine survives the held-note idiom's retriggers; in a post
 *  chain or bus it survives note traffic entirely. A REBUILD (edited graph
 *  structure) makes fresh kernels and the loop is gone — which is also the
 *  escape hatch when a take goes wrong and 'clear' is not wired.
 *
 *  Buffer allocation: eager when ctx is passed at construction (the compiler
 *  does), lazy on first process() otherwise — either way it is the one
 *  allocation the kernel ever makes.
 *
 *  NaN hygiene, stricter than delay's: a NaN in a delay line recirculates
 *  toward the write head and gets caught within a round trip, but a looper
 *  HOLDS content forever, so a missed NaN would replay every pass for the
 *  rest of the session. Every write is summed into a per-block accumulator
 *  (one add, no branch — NaN poisons a sum) and checked once at block end;
 *  if it is non-finite the buffer CONTENT is zeroed (the loop length
 *  survives — a silent loop that keeps time beats a pedal that forgets the
 *  song's length). */
export class LooperKernel implements Kernel {
  private readonly maxTime: number
  private buf: Float32Array | null = null
  /** Loop length in samples once defined; 0 = EMPTY. */
  private len = 0
  /** Read/write head: source frames into the first recording, then position
   *  inside the loop. */
  private pos = 0
  /** Inside the FIRST recording (the one that defines the length). */
  private firstRec = false
  private prevRec = 0
  private prevClear = 0

  constructor(config: LooperConfig = {}, ctx?: DspContext) {
    this.maxTime = clamp(config.maxTime ?? 10, 0.1, 60)
    if (ctx) this.buf = new Float32Array(Math.ceil(this.maxTime * ctx.sampleRate))
    // named pedal: registered so bounceLoop can find it (see LooperConfig.name)
    if (typeof config.name === 'string' && config.name.length > 0 && ctx?.loopers) {
      ctx.loopers.set(config.name, this)
    }
  }

  /** A copy of the current loop content (exactly the defined length), or null
   *  while EMPTY. Control-plane use only (bounceLoop) — it allocates. */
  snapshot(): Float32Array | null {
    if (this.len === 0 || this.buf === null) return null
    return this.buf.slice(0, this.len)
  }

  process(n: number, inputs: Record<string, Float32Array>, out: Float32Array, ctx: DspContext): void {
    const input = inputs['in']!
    const rec = inputs['rec']!
    const feedback = inputs['feedback']!
    const mix = inputs['mix']!
    const clear = inputs['clear']!
    const buf = this.buf ?? (this.buf = new Float32Array(Math.ceil(this.maxTime * ctx.sampleRate)))
    const cap = buf.length
    let len = this.len
    let pos = this.pos
    let firstRec = this.firstRec
    let prevRec = this.prevRec
    let prevClear = this.prevClear
    let acc = 0
    for (let i = 0; i < n; i++) {
      const r = rec[i]! > 0.5 ? 1 : 0
      const c = clear[i]! > 0.5 ? 1 : 0
      // clear wins over everything, including a first recording in progress
      if (c === 1 && prevClear === 0) {
        len = 0
        pos = 0
        firstRec = false
      }
      prevClear = c
      if (r === 1 && prevRec === 0 && len === 0 && !firstRec) {
        firstRec = true // EMPTY + rec pressed: start defining the loop
        pos = 0
      } else if (r === 0 && prevRec === 1 && firstRec) {
        len = pos // rec released: the length is what was played
        pos = 0
        firstRec = false
      }
      prevRec = r
      const x = input[i]!
      let loop = 0
      if (firstRec) {
        // assign, never sum: a fresh loop must not inherit stale content
        let v = x
        if (v > 1) v = 2 - 1 / v
        else if (v < -1) v = -2 - 1 / v
        buf[pos] = v
        acc += v
        pos++
        if (pos >= cap) {
          len = cap // memory full: close the loop and play, like a pedal
          pos = 0
          firstRec = false
        }
      } else if (len > 0) {
        loop = buf[pos]!
        if (r === 1) {
          let v = loop * clamp(feedback[i]!, 0, 1) + x
          if (v > 1) v = 2 - 1 / v
          else if (v < -1) v = -2 - 1 / v
          buf[pos] = v
          acc += v
        }
        pos++
        if (pos >= len) pos = 0
      }
      const m = clamp(mix[i]!, 0, 1)
      out[i] = x + m * loop
    }
    // NaN hygiene at block end (see class doc): content is zeroed, len survives
    if (!Number.isFinite(acc)) buf.fill(0)
    this.len = len
    this.pos = pos
    this.firstRec = firstRec
    this.prevRec = prevRec
    this.prevClear = prevClear
  }

  reset(): void {
    this.len = 0
    this.pos = 0
    this.firstRec = false
    this.prevRec = 0
    this.prevClear = 0
  }
}
