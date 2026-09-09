/* Is this patch a VOICE? Render it and look, rather than deciding by ear
 * that it needs more of something.
 *
 *   pnpm tsx scripts/measure-voice.ts            # audit the chant preset
 *
 * A vowel is not a vibe: it is peaks in a spectral envelope at the
 * frequencies the vowel names. formant() has those frequencies in a table
 * (engine/src/dsp/fx2.ts), so a patch built on it can be held to them.
 *
 * WHY THIS EXISTS. Building the `chant` preset, three separate instincts
 * about how to thicken a formant voice were all wrong, and each one was
 * wrong in a way only a measurement showed:
 *  - mixing a narrow pulse into the saw PHASE-CANCELS: 9 dB quieter, and the
 *    envelope peaks slid off the vowel entirely (202/404/680 Hz for a vowel
 *    asking for 730/1090/2440).
 *  - blending dry signal under the filtered voice for "body" lets the
 *    fundamental drown the formants: peaks fell to the low harmonics.
 *  - tube saturation on the source muddied them the same way.
 * The plain saw beat all three, and puts its peaks within ~20 cents.
 *
 * It also reports the things a spectrum alone will not say: level and crest
 * (a bank of resonators rings, and rings into clipping before its RMS looks
 * hot), and whether the vibrato actually moves the PITCH.
 *
 * TWO TRAPS THIS SCRIPT ALREADY FELL INTO, kept as comments where they bit:
 * peak-picking a raw spectrum finds the harmonics of the source rather than
 * the formants (see `envelope`), and counting zero crossings reads a
 * formant-rich 65 Hz saw as 720 Hz (see `pitchTrack`).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { compile } from '../packages/rondo/src/index'
import { renderStagedMix } from '../packages/app/src/editor/resample'
import { encodeWav16 } from '../packages/engine/src/index'

/** The engine's own table (dsp/fx2.ts), so this checks the patch against the
 *  filter it is built on rather than against a number I remembered. */
const VOWELS: Record<string, [number, number, number]> = {
  a: [730, 1090, 2440],
  e: [530, 1840, 2480],
  i: [270, 2290, 3010],
  o: [570, 840, 2410],
  u: [300, 870, 2240],
}

/* ------------------------------------------------------------------ analysis */

/** Naive DFT magnitude at one frequency (Goertzel would be faster; this runs
 *  a few thousand times, not a few million). */
function magAt(x: Float32Array, sr: number, f: number): number {
  const w = (2 * Math.PI * f) / sr
  let re = 0
  let im = 0
  for (let i = 0; i < x.length; i++) {
    // Hann, so a strong neighbour does not smear across the whole sweep
    const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (x.length - 1))
    const v = x[i]! * win
    re += v * Math.cos(w * i)
    im -= v * Math.sin(w * i)
  }
  return Math.sqrt(re * re + im * im) / x.length
}

/* A harmonic source puts a peak every f0 Hz, so peak-picking a raw spectrum
 * finds the HARMONICS and never the formants — the first version of this
 * harness confidently reported the three loudest partials of a 65 Hz saw and
 * called them a vowel. What a formant is, is a peak in the ENVELOPE: the
 * shape the harmonics sit under. So: energy in 1/6-octave bands, which is
 * wide enough at these pitches to hold several harmonics and smooth them
 * into that shape, then peak-pick THAT, keeping peaks a minimum distance
 * apart so one broad formant is not reported as three.
 */
function envelope(x: Float32Array, sr: number): { hz: number; db: number }[] {
  const out: { hz: number; db: number }[] = []
  const step = Math.pow(2, 1 / 12) // half-band overlap of a 1/6-octave band
  for (let f = 180; f < 3600; f *= step) {
    const lo = f / Math.pow(2, 1 / 12)
    const hi = f * Math.pow(2, 1 / 12)
    let energy = 0
    let n = 0
    // sum a few probes across the band rather than one line through it
    for (let g = lo; g <= hi; g *= 1.01) {
      const m = magAt(x, sr, g)
      energy += m * m
      n++
    }
    out.push({ hz: f, db: 10 * Math.log10(energy / Math.max(n, 1) + 1e-24) })
  }
  return out
}

/** The peaks of that envelope, loudest first, at least a third of an octave
 *  apart so one broad formant counts once. */
function peaks(x: Float32Array, sr: number, count: number): { hz: number; db: number }[] {
  const env = envelope(x, sr)
  const local: { hz: number; db: number }[] = []
  for (let i = 1; i < env.length - 1; i++) {
    if (env[i]!.db >= env[i - 1]!.db && env[i]!.db >= env[i + 1]!.db) local.push(env[i]!)
  }
  const kept: { hz: number; db: number }[] = []
  for (const p of local.sort((a, b) => b.db - a.db)) {
    if (kept.every((k) => Math.abs(Math.log2(p.hz / k.hz)) > 1 / 3)) kept.push(p)
    if (kept.length === count) break
  }
  return kept.sort((a, b) => a.hz - b.hz)
}

const rms = (x: Float32Array): number => {
  let s = 0
  for (const v of x) s += v * v
  return Math.sqrt(s / x.length)
}
const peak = (x: Float32Array): number => {
  let m = 0
  for (const v of x) m = Math.max(m, Math.abs(v))
  return m
}

/* Pitch by AUTOCORRELATION, not by counting zero crossings: a formant stack
 * on a saw crosses zero many times per period, and the crossing count read
 * 720 Hz for a 65 Hz note. The vibrato figure is the point of this, so it has
 * to be a pitch and not a brightness. */
function pitchTrack(x: Float32Array, sr: number): { min: number; max: number; centsSpread: number; frames: number } {
  const frame = Math.floor(sr * 0.06)
  const minLag = Math.floor(sr / 500)
  const maxLag = Math.floor(sr / 40)
  const hz: number[] = []
  for (let s = 0; s + frame + maxLag < x.length; s += frame) {
    let best = 0
    let bestLag = 0
    let zero = 0
    for (let i = 0; i < frame; i++) zero += x[s + i]! * x[s + i]!
    if (zero < 1e-9) continue
    for (let lag = minLag; lag <= maxLag; lag++) {
      let acc = 0
      for (let i = 0; i < frame; i += 2) acc += x[s + i]! * x[s + i + lag]!
      if (acc > best) {
        best = acc
        bestLag = lag
      }
    }
    if (bestLag > 0 && best / (zero / 2) > 0.3) hz.push(sr / bestLag)
  }
  if (hz.length === 0) return { min: 0, max: 0, centsSpread: 0, frames: 0 }
  const min = Math.min(...hz)
  const max = Math.max(...hz)
  return { min, max, centsSpread: 1200 * Math.log2(max / Math.max(min, 1e-6)), frames: hz.length }
}

/* --------------------------------------------------------------------- run */

/** Render and take the sustained body's envelope. */
function bodyOf(source: string, cycles: number): { body: Float32Array; left: Float32Array; right: Float32Array; sr: number; perSynth: Record<string, { events: number; rms: number }> } {
  const mix = renderStagedMix(source, cycles, undefined, { tailSec: 1 })
  if ('error' in mix) throw new Error(mix.error)
  const from = Math.floor(mix.left.length * 0.35)
  return {
    body: mix.left.subarray(from, Math.min(from + Math.floor(mix.sampleRate * 0.5), mix.left.length)),
    left: mix.left,
    right: mix.right,
    sr: mix.sampleRate,
    perSynth: mix.perSynth,
  }
}

export async function measure(name: string, source: string, opts: { cycles?: number; vowel?: string; outDir?: string; reference?: string } = {}): Promise<void> {
  const cycles = opts.cycles ?? 4
  const cur = bodyOf(source, cycles)
  const { body, left, sr } = cur
  if (opts.outDir !== undefined) {
    writeFileSync(`${opts.outDir}/${name}.wav`, Buffer.from(encodeWav16(left, cur.right, sr)))
  }
  const r = rms(body)
  const p = peak(left)
  const found = peaks(body, sr, 3)
  const track = pitchTrack(body, sr)
  const stems = Object.entries(cur.perSynth).map(([k, v]) => `${k}:${v.events}ev/${v.rms.toFixed(3)}`).join(' ')

  console.log(`\n=== ${name} ===`)
  console.log(`  level      rms ${(20 * Math.log10(r + 1e-12)).toFixed(1)} dB   peak ${p.toFixed(3)}   crest ${(20 * Math.log10(p / (r + 1e-12))).toFixed(1)} dB`)
  // On a HELD note this is the vibrato; on a melody it is the melody, so the
  // number is only a vibrato reading when the render is one note long.
  console.log(`  pitch      ${track.min.toFixed(0)}-${track.max.toFixed(0)} Hz, spread ${track.centsSpread.toFixed(0)} cents`)
  console.log(`  stems      ${stems}`)
  console.log(`  formants   ${found.map((f) => `${f.hz.toFixed(0)}Hz ${f.db.toFixed(0)}dB`).join('   ')}`)
  if (opts.vowel !== undefined) {
    /* The honest question is not "where are the three loudest peaks" but "is
     * there energy where this vowel's formants are, and how far below F1 is
     * it". A vowel whose F2 sits 25 dB under its F1 is not heard as that
     * vowel; it is heard as a hum. That number is the one that decides how
     * the source has to be built, so it is the one printed. */
    const want = VOWELS[opts.vowel]!
    const env = envelope(body, sr)
    const at = (e: { hz: number; db: number }[], hz: number): number =>
      e.reduce((best, b) => (Math.abs(Math.log2(b.hz / hz)) < Math.abs(Math.log2(best.hz / hz)) ? b : best), e[0]!).db
    console.log(`  vowel '${opts.vowel}'  wants ${want.join(' / ')} Hz`)
    if (opts.reference !== undefined) {
      /* THE measurement. Absolute energy at a formant says as much about the
       * source's harmonic spacing as about the filter -- at a bass pitch a
       * formant can sit between two harmonics and read as a hole. Rendering
       * the same patch with the vowel filter taken out and subtracting gives
       * the filter's own gain, which is the thing being judged. */
      const ref = envelope(bodyOf(opts.reference, cycles).body, sr)
      const gain = want.map((w) => at(env, w) - at(ref, w))
      console.log(`  filter gain   ${gain.map((d, k) => `F${k + 1} ${d >= 0 ? '+' : ''}${d.toFixed(0)}dB`).join('   ')}   (vs the same patch with no formant)`)
      // and what it does to the region BETWEEN formants, which is what makes
      // a vowel legible rather than merely bright
      for (const hz of [1500, 3000]) {
        const d = at(env, hz) - at(ref, hz)
        console.log(`                ${hz}Hz ${d >= 0 ? '+' : ''}${d.toFixed(0)}dB`)
      }
    }
    const near = want.map((w) => {
      const q = found.reduce<{ hz: number; db: number } | null>((b, c) => (b === null || Math.abs(Math.log2(c.hz / w)) < Math.abs(Math.log2(b.hz / w)) ? c : b), null)
      return q === null ? '--' : `${Math.round(1200 * Math.log2(q.hz / w))}c`
    })
    console.log(`  nearest peak  ${near.join('   ')}`)
  }
}

/** How far apart two vowels end up, in the bands where they differ. /a/ and
 *  /i/ have F2s an octave apart, so 1090 Hz and 2290 Hz are where a listener
 *  tells them apart, and this is how hard the vowel control pulls them.
 *
 *  NOTE what this does NOT measure. Both renders share a source, so the
 *  source's own spectrum cancels out of the difference: every source scores
 *  the same here, which is exactly what six of them did when I first ran
 *  this expecting it to rank them. Use `presence` for the source question. */
export async function legibility(name: string, sourceA: string, sourceI: string, cycles = 2): Promise<void> {
  const a = bodyOf(sourceA, cycles)
  const i = bodyOf(sourceI, cycles)
  const envA = envelope(a.body, a.sr)
  const envI = envelope(i.body, i.sr)
  const at = (e: { hz: number; db: number }[], hz: number): number =>
    e.reduce((best, b) => (Math.abs(Math.log2(b.hz / hz)) < Math.abs(Math.log2(best.hz / hz)) ? b : best), e[0]!).db
  // /a/ should win at 1090, /i/ should win at 2290. Both differences count.
  const atF2a = at(envA, 1090) - at(envI, 1090)
  const atF2i = at(envI, 2290) - at(envA, 2290)
  const level = 20 * Math.log10(rms(a.body) + 1e-12)
  const crest = 20 * Math.log10(peak(a.left) / (rms(a.body) + 1e-12))
  console.log(
    `${name.padEnd(24)} /a/ leads at 1090Hz by ${atF2a.toFixed(1).padStart(6)} dB   ` +
    `/i/ leads at 2290Hz by ${atF2i.toFixed(1).padStart(6)} dB   ` +
    `(sum ${(atF2a + atF2i).toFixed(1).padStart(6)})   rms ${level.toFixed(1)} crest ${crest.toFixed(1)}`,
  )
}

/** How far F2 sits below F1 once the filter has had its way: the number that
 *  decides whether a vowel is HEARD as that vowel or as a hum. Unlike
 *  `legibility` this does depend on the source, because it is asking whether
 *  the source gave the upper formant anything to ring on. */
export async function presence(name: string, source: string, vowel: keyof typeof VOWELS, cycles = 2): Promise<void> {
  const r = bodyOf(source, cycles)
  const env = envelope(r.body, r.sr)
  const at = (hz: number): number => env.reduce((b, c) => (Math.abs(Math.log2(c.hz / hz)) < Math.abs(Math.log2(b.hz / hz)) ? c : b), env[0]!).db
  const [f1, f2, f3] = VOWELS[vowel]
  console.log(
    `${name.padEnd(28)} /${vowel}/  F2-F1 ${(at(f2) - at(f1)).toFixed(1).padStart(6)} dB   F3-F1 ${(at(f3) - at(f1)).toFixed(1).padStart(6)} dB`,
  )
}

/** Score a candidate voice: how close its spectral peaks land to the vowel it
 *  is asking for, and whether it is loud enough to be an instrument. The
 *  peak-distance is the one that matters -- a patch whose loudest bumps are
 *  not at the vowel's formants is not singing that vowel, however good the
 *  filter in the middle of it is. */
export async function score(name: string, source: string, vowel: keyof typeof VOWELS, cycles = 2): Promise<void> {
  const r = bodyOf(source, cycles)
  const found = peaks(r.body, r.sr, 3)
  const want = VOWELS[vowel]
  const near = want.map((w) => {
    const q = found.reduce<{ hz: number; db: number } | null>((b, c) => (b === null || Math.abs(Math.log2(c.hz / w)) < Math.abs(Math.log2(b.hz / w)) ? c : b), null)
    return q === null ? 9999 : Math.abs(Math.round(1200 * Math.log2(q.hz / w)))
  })
  const worst = Math.max(...near)
  console.log(
    `${name.padEnd(26)} peaks ${found.map((f) => `${f.hz.toFixed(0)}`.padStart(5)).join(' ')} Hz` +
    `   off ${near.map((c) => `${c}c`.padStart(6)).join(' ')}  worst ${String(worst).padStart(4)}c` +
    `   rms ${(20 * Math.log10(rms(r.body) + 1e-12)).toFixed(1).padStart(6)}  peak ${peak(r.left).toFixed(3)}`,
  )
}

/** The pitch over time, coarsely, so a GLIDE can be seen as a ramp rather
 *  than assumed from the presence of the option that is supposed to cause
 *  one. A jump prints as two plateaus; a glide prints as steps between them. */
export async function trajectory(name: string, source: string, cycles = 2): Promise<void> {
  const r = bodyOf(source, cycles)
  const mix = renderStagedMix(source, cycles, undefined, { tailSec: 1 })
  if ('error' in mix) throw new Error(mix.error)
  const x = mix.left
  const sr = mix.sampleRate
  const frame = Math.floor(sr * 0.05)
  const minLag = Math.floor(sr / 500)
  const maxLag = Math.floor(sr / 40)
  const out: string[] = []
  for (let s = 0; s + frame + maxLag < x.length; s += frame * 2) {
    let best = 0
    let bestLag = 0
    let zero = 0
    for (let i = 0; i < frame; i++) zero += x[s + i]! * x[s + i]!
    if (zero < 1e-7) { out.push('   .'); continue }
    for (let lag = minLag; lag <= maxLag; lag++) {
      let acc = 0
      for (let i = 0; i < frame; i += 2) acc += x[s + i]! * x[s + i + lag]!
      if (acc > best) { best = acc; bestLag = lag }
    }
    out.push(bestLag > 0 && best / (zero / 2) > 0.25 ? String(Math.round(sr / bestLag)).padStart(4) : '   .')
  }
  void r
  console.log(`${name}\n  Hz over time: ${out.join(' ')}`)
}

/** Level over time, so a drone that RE-STRIKES every cycle (and pumps) is
 *  visible rather than assumed away. Each column is one second. */
export async function levelOverTime(name: string, source: string, cycles: number): Promise<void> {
  const mix = renderStagedMix(source, cycles, undefined, { tailSec: 1 })
  if ('error' in mix) throw new Error(mix.error)
  const sec = mix.sampleRate
  const cols: string[] = []
  for (let s = 0; s + sec < mix.left.length; s += sec) {
    const db = 20 * Math.log10(rms(mix.left.subarray(s, s + sec)) + 1e-12)
    cols.push(db.toFixed(0).padStart(4))
  }
  console.log(`${name}\n  dB/sec: ${cols.join('')}`)
}

/* ------------------------------------------------------------------- audit */

/** The shipped `chant` preset, read out of the library source the way its own
 *  test does (synthlib.ts reaches the audio worklet through the editor, which
 *  Node cannot import). */
function chantPreset(): { code: string; demoTail: string; rondo: string } {
  const lib = readFileSync(new URL('../packages/app/src/editor/synthlib.ts', import.meta.url).pathname, 'utf8')
  const m = /name: 'chant',[\s\S]*?code: `([\s\S]*?)`,\n\s+demoTail: `([\s\S]*?)`,\n\s+rondo: `([\s\S]*?)`,\n/.exec(lib)
  if (m === null) throw new Error('could not find the chant preset in synthlib.ts')
  return { code: m[1]!, demoTail: m[2]!.replace(/\\n/g, '\n'), rondo: m[3]! }
}

async function audit(): Promise<void> {
  const preset = chantPreset()
  const held = (morph: number): string =>
    `${preset.code}\np('demo', note('c3').sound('chant').dur(0.98).ctrl('vowel', ${morph}))\nsetCps(0.25)`

  console.log('\nEach vowel, held at c3. The peaks should sit on the vowel table.')
  const vowels = [['a', 0], ['e', 0.25], ['i', 0.5], ['o', 0.75], ['u', 1]] as const
  for (const [v, m] of vowels) await score(`vowel ${m} = /${v}/`, held(m), v)

  console.log('\nDoes moving the vowel control actually move the spectrum?')
  await legibility('a vs i', held(0), held(0.5))

  console.log('\nThe preset demo, as the library card plays it.')
  await measure('demo', `${preset.code}\n${preset.demoTail}`, { cycles: 4 })

  console.log('\nThe rondo twin must be the same instrument.')
  const c = compile(`${preset.rondo}\n\nplay chant\n  c3\n\ncps .25\n`)
  if (!c.ok) throw new Error(`the rondo twin does not compile: ${JSON.stringify(c.errors)}`)
  await score('rondo twin, /a/', c.code, 'a')
}

if (process.argv[1]?.endsWith('measure-voice.ts') === true) void audit()
