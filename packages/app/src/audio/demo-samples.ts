/* Procedurally-generated default samples so the sampler works out of the box
 * (no file upload needed to try `sample()`). These are real PCM buffers fed
 * through the engine's sample path — exactly what a loaded WAV would be — they
 * just happen to be synthesized here rather than recorded. Users load their own
 * drums/vox/breaks via the editor's "+ sample" button. */

/** A warm choral "ooh" one-shot at A3 (220 Hz) — additive formant synthesis
 *  with dark, wide formants and a lowpass roll-off so it's round and breathy
 *  rather than buzzy. Two slightly detuned voices thicken it. Use with
 *  sample(gate, 'vox', { root: 57 }) to play it melodically as a chop. */
export function makeVox(sampleRate: number): Float32Array {
  const dur = 1.3
  const n = Math.round(dur * sampleRate)
  const out = new Float32Array(n)
  const f0 = 220 // A3
  // "ooh" formants — low & wide (darker, rounder than "aah"): [freq, gain, bw]
  const formants = [
    [320, 1.0, 90],
    [800, 0.45, 110],
    [2200, 0.1, 160],
  ]
  const harmonics = 28
  const gains: number[] = []
  for (let h = 1; h <= harmonics; h++) {
    const f = f0 * h
    let g = 0
    for (const [ff, fg, bw] of formants) {
      const d = (f - ff!) / bw!
      g += fg! / (1 + d * d)
    }
    gains.push(g / (1 + h * h * 0.01)) // steeper top rolloff -> less buzz
  }
  let lp = 0
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate
    const vib = 1 + 0.004 * Math.sin(2 * Math.PI * 5 * t) * Math.min(1, t / 0.4)
    let s = 0
    for (let h = 1; h <= harmonics; h++) {
      const ph = 2 * Math.PI * f0 * h * vib * t
      s += gains[h - 1]! * (Math.sin(ph) + 0.7 * Math.sin(ph * 1.006)) // detuned pair
    }
    lp += (s - lp) * 0.35 // one-pole lowpass: shave the harsh highs
    // soft attack, long sustain, gentle release
    const env = Math.min(1, t / 0.09) * (t > dur - 0.35 ? Math.max(0, (dur - t) / 0.35) : 1)
    out[i] = lp * env
  }
  let peak = 0
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]!))
  if (peak > 0) for (let i = 0; i < n; i++) out[i]! *= 0.8 / peak
  return out
}

/** A smooth, evolving harmonic tone at A3 (220 Hz) — a warm additive pad with
 *  gently detuned partials and no formants/noise, so it GRANULATES cleanly into
 *  a dreamy wash (vs. the uncanny smear you get granulating the vocal). */
export function makePad(sampleRate: number): Float32Array {
  const dur = 3.5
  const n = Math.round(dur * sampleRate)
  const out = new Float32Array(n)
  const f0 = 220
  const harm = [1, 2, 3, 4, 5, 6]
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate
    let s = 0
    for (let k = 0; k < harm.length; k++) {
      const h = harm[k]!
      const det = 1 + 0.0015 * Math.sin(2 * Math.PI * (0.2 + 0.11 * k) * t) // slow shimmer
      s += (1 / (h * h * 0.5 + 0.5)) * Math.sin(2 * Math.PI * f0 * h * det * t)
    }
    out[i] = s
  }
  let peak = 0
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]!))
  if (peak > 0) for (let i = 0; i < n; i++) out[i]! *= 0.8 / peak
  return out
}

/** A ~1.8 s noise uplifter (riser): band-passed white noise whose centre pitch
 *  and amplitude sweep upward — the classic EDM build transition. One-shot it
 *  over a build with sample(gate, 'riser'). */
export function makeRiser(sampleRate: number): Float32Array {
  const dur = 1.8
  const n = Math.round(dur * sampleRate)
  const out = new Float32Array(n)
  // state-variable bandpass swept from low to high; noise source
  let lp = 0
  let bp = 0
  let seed = 22222
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return (seed / 0x40000000) - 1
  }
  for (let i = 0; i < n; i++) {
    const t = i / n // 0..1 progress
    const cutoff = 300 + (7000 - 300) * (t * t) // accelerating upward sweep
    const f = (2 * Math.sin(Math.PI * Math.min(0.49, cutoff / sampleRate)))
    const q = 0.6
    const x = rnd()
    lp += f * bp
    const hp = x - lp - q * bp
    bp += f * hp
    // amplitude swells up, then a quick dip right at the top (pre-impact)
    const amp = Math.pow(t, 1.5) * (t > 0.96 ? Math.max(0.2, (1 - t) / 0.04) : 1)
    out[i] = bp * amp
  }
  let peak = 0
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]!))
  if (peak > 0) for (let i = 0; i < n; i++) out[i]! *= 0.85 / peak
  return out
}

/** A 2 s drum loop built as EIGHT equal 0.25 s steps, so it lines up exactly
 *  with `sample(gate, 'break', { slices: 8 })`: note 60 plays step 0, note 61
 *  step 1, and so on. One hit per step (kick, hat, snare, hat, kick, kick,
 *  snare, hat) so every chop is recognizably different, which is the whole
 *  point of a chopper. Stands in for your own bounced take. */
export function makeBreak(sampleRate: number): Float32Array {
  const step = 0.25
  const n = Math.round(8 * step * sampleRate)
  const out = new Float32Array(n)
  let seed = 90210
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x40000000 - 1
  }
  const add = (at: number, dur: number, gen: (t: number) => number): void => {
    const from = Math.round(at * sampleRate)
    const len = Math.round(dur * sampleRate)
    for (let i = 0; i < len && from + i < n; i++) out[from + i]! += gen(i / sampleRate)
  }
  // kick: pitch envelope 130 -> 45 Hz, fast body decay
  const kick = (gain: number) => (t: number): number => {
    const f = 45 + 85 * Math.exp(-t * 45)
    return gain * Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 11)
  }
  // snare: a 190 Hz shell under a noise crack
  const snare = (gain: number) => (t: number): number =>
    gain * (0.45 * Math.sin(2 * Math.PI * 190 * t) + 0.9 * rnd()) * Math.exp(-t * 22)
  // hat: noise through a crude one-pole highpass, very short
  let hlp = 0
  const hat = (gain: number) => (t: number): number => {
    const x = rnd()
    hlp += (x - hlp) * 0.55
    return gain * (x - hlp) * Math.exp(-t * 90)
  }
  const hits: [number, (t: number) => number][] = [
    [0, kick(1)], [1, hat(0.5)], [2, snare(0.8)], [3, hat(0.4)],
    [4, kick(0.9)], [5, kick(0.7)], [6, snare(0.85)], [7, hat(0.5)],
  ]
  // every hit starts ON its step boundary and decays inside it, so a chop is
  // one clean hit and never the tail of the previous one
  for (const [i, gen] of hits) add(i * step, step * 0.95, gen)
  let peak = 0
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]!))
  if (peak > 0) for (let i = 0; i < n; i++) out[i]! *= 0.85 / peak
  return out
}

/** Every built-in sample, as the PCM map the render paths take.
 *
 *  ONE list. The editor and the docs player each enumerated these four by
 *  hand, and the headless renderers had none of them at all — which is why
 *  `pnpm tsx packages/server/scripts/render-example.ts granular` wrote a file
 *  of digital zero: the bank the browser builds at startup simply did not
 *  exist offline. They are pure functions of the sample rate, so there is
 *  nothing stopping a CLI from having exactly what the app has.
 *
 *  Keyed by the name user code plays: `sample(gate, 'break')`. */
export function builtInSamples(sampleRate: number): Record<string, { data: Float32Array; sampleRate: number }> {
  return {
    vox: { data: makeVox(sampleRate), sampleRate },
    riser: { data: makeRiser(sampleRate), sampleRate },
    pad: { data: makePad(sampleRate), sampleRate },
    break: { data: makeBreak(sampleRate), sampleRate },
  }
}
