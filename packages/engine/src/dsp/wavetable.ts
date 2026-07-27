import type { DspContext, Kernel } from './types'
import { flush } from './util'
import { fft } from '../analysis'

/* ------------------------------------------------------------------------- *
 * Anti-aliased morphing wavetable oscillator (Serum-style).
 *
 * A table is a bank of single-cycle FRAMES (single-cycle waveforms). `pos`
 * (0..1) scans/morphs between adjacent frames; `freq` sets the pitch. The
 * output is band-limited: for every frame we precompute a set of MIPMAPS, one
 * per octave band, each keeping only the harmonics that stay below Nyquist for
 * that band. At runtime the current `freq` (and ctx.sampleRate) picks the
 * mipmap — higher notes read a mipmap with fewer harmonics, so a played note
 * never contains a harmonic above Nyquist and cannot alias.
 *
 * Why mipmaps beat polyblep here: an arbitrary single-cycle wave has no
 * closed-form band-limited step to correct (unlike saw/square). Building each
 * frame ADDITIVELY (sum of sine harmonics) makes band-limiting exact and free:
 * a mipmap is just the same frame resynthesised with the out-of-band harmonics
 * dropped. We synthesise via an inverse FFT (reusing analysis.ts's fft) rather
 * than a naive O(harmonics x samples) sum, so the whole bank builds in a few ms.
 *
 * Tables are pure data — generated procedurally on first use and cached at
 * module level, keyed by name. The harmonic CONTENT of the mipmaps is fixed
 * (defined by harmonic count, not sample rate); only the mipmap SELECTION uses
 * the runtime freq & ctx.sampleRate, so one cached bank serves any sample rate.
 *
 * Memory: FRAMES x MIPMAPS x FRAME_SIZE x 4 bytes ~= 8 x 11 x 2048 x 4 ~= 0.7 MB
 * per table. Read path is allocation-free; state is just the phase accumulator
 * (reset() zeros it), and — like the phase oscillators in osc.ts — the phase is
 * flushed at block end so a NaN freq poisons at most one block.
 * ------------------------------------------------------------------------- */

/** Samples per single-cycle frame. Power of two so phase->index wraps with a
 *  bit mask, and so the highest representable harmonic is FRAME_SIZE/2. */
export const WAVETABLE_FRAME_SIZE = 2048

/** Harmonics kept by the richest (lowest-band) mipmap. FRAME_SIZE/2 is the
 *  Nyquist of the frame itself. */
const MAX_HARMONICS = WAVETABLE_FRAME_SIZE / 2 // 1024
const LOG2_MAX_HARMONICS = Math.log2(MAX_HARMONICS) // 10
/** One mipmap per octave: harmonic count halves each step (1024,512,...,1). */
const NUM_MIPMAPS = LOG2_MAX_HARMONICS + 1 // 11

/** Built-in table names. */
export const WAVETABLE_TABLES = ['basic', 'harmonic', 'pwm'] as const
export type WavetableName = (typeof WAVETABLE_TABLES)[number]

/* Custom-table limits (shared by defineWavetable, the wire message, and the
 * rondo `wavedef` grammar): a table is 1..MAX_FRAMES frames, each frame
 * 1..MAX_PARTIALS harmonic partial AMPLITUDES (finite, |a| <= AMP_LIMIT —
 * negative amplitudes are legal phase flips, how a triangle gets its shape). */
export const WAVETABLE_MAX_FRAMES = 64
export const WAVETABLE_MAX_PARTIALS = 32
export const WAVETABLE_AMP_LIMIT = 16
const TABLE_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/

/** frames[frame][mipmap] -> a single-cycle Float32Array of FRAME_SIZE samples.
 *  mipmap 0 holds all harmonics; mipmap m holds MAX_HARMONICS >> m of them. */
type Bank = Float32Array[][]

const isName = (name: string): name is WavetableName =>
  (WAVETABLE_TABLES as readonly string[]).includes(name)

/* --------------------------- frame construction --------------------------- *
 * Each frame is described by a harmonic-amplitude spectrum a[h] (h = 1..). We
 * synthesise band-limited versions by inverse-FFT of that spectrum truncated to
 * each mipmap's harmonic count.
 * ------------------------------------------------------------------------- */

/** Inverse real FFT of a pure-sine spectrum: given amplitudes a[h] for
 *  harmonic h, return the time signal sum_h a[h]*sin(2*pi*h*n/N). Uses the
 *  forward fft via ifft(X) = conj(fft(conj(X)))/N; only harmonics 1..maxH are
 *  used (the band limit). */
const synthFrame = (amps: Float64Array, maxH: number): Float32Array => {
  const N = WAVETABLE_FRAME_SIZE
  const re = new Float64Array(N)
  const im = new Float64Array(N)
  const limit = Math.min(maxH, N / 2 - 1)
  // A real sine sin(2*pi*h*n/N) has spectrum X[h] = -i*(N/2)*a, X[N-h] = +i*(N/2)*a.
  // We want the ifft, so pre-conjugate the input (negate im): the sign flips.
  for (let h = 1; h <= limit; h++) {
    const a = amps[h]!
    if (a === 0) continue
    im[h] = (N / 2) * a
    im[N - h] = -(N / 2) * a
  }
  fft(re, im)
  const frame = new Float32Array(N)
  for (let i = 0; i < N; i++) frame[i] = re[i]! / N
  return frame
}

/** Build every octave mipmap for one frame from its full harmonic spectrum,
 *  then normalise the whole frame so the peak magnitude across ALL its mipmaps
 *  is 1 (keeps morph output bounded and frames peak-matched).
 *
 *  `topH` is the highest harmonic the spectrum actually contains: every mipmap
 *  whose harmonic budget is >= topH keeps ALL of it, so those slots ALIAS one
 *  shared frame instead of re-running the iFFT. For a custom table (<= 32
 *  partials) that cuts 11 syntheses per frame down to ~6 — cheap enough to
 *  rebuild live while a widget drag rewrites the partials. */
const buildFrameMipmaps = (amps: Float64Array, topH = MAX_HARMONICS): Float32Array[] => {
  const mips: Float32Array[] = []
  const unique: Float32Array[] = []
  let shared: Float32Array | undefined
  let peak = 0
  for (let m = 0; m < NUM_MIPMAPS; m++) {
    const maxH = MAX_HARMONICS >> m
    if (maxH >= topH && shared !== undefined) {
      mips.push(shared)
      continue
    }
    const frame = synthFrame(amps, maxH)
    if (maxH >= topH) shared = frame
    for (let i = 0; i < frame.length; i++) {
      const a = Math.abs(frame[i]!)
      if (a > peak) peak = a
    }
    mips.push(frame)
    unique.push(frame)
  }
  const scale = peak > 0 ? 1 / peak : 1
  for (const frame of unique) {
    for (let i = 0; i < frame.length; i++) frame[i] = frame[i]! * scale
  }
  return mips
}

/* ------------------------------ table specs ------------------------------- */

const NUM_FRAMES = 8

/** Harmonic spectrum a[h] for a named classic wave (unnormalised; sign encodes
 *  phase, which shapes the waveform but not the magnitude spectrum). */
const classic = (kind: 'sine' | 'tri' | 'saw' | 'square'): Float64Array => {
  const a = new Float64Array(MAX_HARMONICS + 1)
  for (let h = 1; h <= MAX_HARMONICS; h++) {
    switch (kind) {
      case 'sine':
        a[h] = h === 1 ? 1 : 0
        break
      case 'tri':
        a[h] = h % 2 === 1 ? ((h - 1) / 2) % 2 === 0 ? 1 / (h * h) : -1 / (h * h) : 0
        break
      case 'saw':
        a[h] = 1 / h
        break
      case 'square':
        a[h] = h % 2 === 1 ? 1 / h : 0
        break
    }
  }
  return a
}

/** Linear blend of two spectra. */
const blend = (x: Float64Array, y: Float64Array, t: number): Float64Array => {
  const a = new Float64Array(x.length)
  for (let h = 0; h < a.length; h++) a[h] = x[h]! + t * (y[h]! - x[h]!)
  return a
}

/** 'basic': 8 frames sweeping sine -> triangle -> saw -> square, harmonics
 *  growing richer across the morph. */
const buildBasic = (): Float64Array[] => {
  const sine = classic('sine')
  const tri = classic('tri')
  const saw = classic('saw')
  const square = classic('square')
  const anchors = [sine, tri, saw, square]
  const frames: Float64Array[] = []
  for (let f = 0; f < NUM_FRAMES; f++) {
    const t = (f / (NUM_FRAMES - 1)) * (anchors.length - 1) // 0..3
    const i = Math.min(anchors.length - 2, Math.floor(t))
    frames.push(blend(anchors[i]!, anchors[i + 1]!, t - i))
  }
  return frames
}

/** 'harmonic': a moving formant. Frame k rides a saw-ish base under a Gaussian
 *  emphasis whose centre harmonic climbs by octaves — an evolving, vocal sweep
 *  as different harmonic bands are foregrounded. */
const buildHarmonic = (): Float64Array[] => {
  const frames: Float64Array[] = []
  for (let f = 0; f < NUM_FRAMES; f++) {
    const centre = Math.pow(2, (f / (NUM_FRAMES - 1)) * (LOG2_MAX_HARMONICS - 1)) // 1..512
    const width = Math.max(1, centre * 0.5)
    const a = new Float64Array(MAX_HARMONICS + 1)
    for (let h = 1; h <= MAX_HARMONICS; h++) {
      const bump = Math.exp(-0.5 * ((h - centre) / width) ** 2)
      // keep a little fundamental so the pitch is always present
      a[h] = (1 / h) * (0.2 + bump)
    }
    frames.push(a)
  }
  return frames
}

/** 'pwm': pulse waves of increasing width. Frame k has duty d going 0.5 (square)
 *  -> ~0.08 (thin pulse); harmonic k of a duty-d pulse is ~ sin(pi*k*d)/k. */
const buildPwm = (): Float64Array[] => {
  const frames: Float64Array[] = []
  for (let f = 0; f < NUM_FRAMES; f++) {
    const duty = 0.5 - (f / (NUM_FRAMES - 1)) * 0.42 // 0.5 .. 0.08
    const a = new Float64Array(MAX_HARMONICS + 1)
    for (let h = 1; h <= MAX_HARMONICS; h++) a[h] = Math.sin(Math.PI * h * duty) / h
    frames.push(a)
  }
  return frames
}

const SPECS: Record<WavetableName, () => Float64Array[]> = {
  basic: buildBasic,
  harmonic: buildHarmonic,
  pwm: buildPwm,
}

/** Module-level cache: each table's mipmapped bank is built once, on first use. */
const bankCache = new Map<WavetableName, Bank>()

const getBank = (name: WavetableName): Bank => {
  let bank = bankCache.get(name)
  if (!bank) {
    bank = SPECS[name]().map(buildFrameMipmaps)
    bankCache.set(name, bank)
  }
  return bank
}

/** The mipmapped bank for a named table: frames[frame][mipmap], a single-cycle
 *  Float32Array of WAVETABLE_FRAME_SIZE samples. Exposed for analysis/tests. */
export const getWavetable = (name: WavetableName): Bank => getBank(name)

/* --------------------------- custom tables -------------------------------- *
 * A custom table is pure data: FRAMES of harmonic partial amplitudes
 * (frames[f][i] = amplitude of harmonic i+1). Synthesis reuses the exact
 * band-limited machinery above, so custom tables get the same mipmapped
 * anti-aliasing as the built-ins. Three legs, mirroring samples:
 *   - WavetableBank: the store a REALTIME engine owns (adopt-or-publish on
 *     ctx.wavetables), filled by loadWavetable wire messages.
 *   - the module-global registry: defineWavetable(), living in the EVAL realm
 *     (main thread / node). The eval layer owns its lifecycle exactly like
 *     custom scales: snapshot -> clear -> run -> restore-on-failure, so it
 *     mirrors the last successful eval.
 *   - renderOffline's `wavetables` option threads specs into an offline ctx
 *     (and the kernel additionally falls back to the registry, which shares
 *     the offline render's realm).
 * ------------------------------------------------------------------------- */

/** Throw a TypeError unless `frames` is a valid partial-amplitude spec:
 *  1..WAVETABLE_MAX_FRAMES frames, each 1..WAVETABLE_MAX_PARTIALS finite
 *  numbers with |a| <= WAVETABLE_AMP_LIMIT. `what` prefixes messages. */
export function validateWavetableFrames(what: string, frames: unknown): asserts frames is number[][] {
  if (!Array.isArray(frames) || frames.length < 1 || frames.length > WAVETABLE_MAX_FRAMES) {
    throw new TypeError(`${what}: frames must be 1..${WAVETABLE_MAX_FRAMES} arrays of partial amplitudes`)
  }
  for (const frame of frames as unknown[]) {
    if (!Array.isArray(frame) || frame.length < 1 || frame.length > WAVETABLE_MAX_PARTIALS) {
      throw new TypeError(`${what}: each frame is 1..${WAVETABLE_MAX_PARTIALS} partial amplitudes`)
    }
    for (const a of frame as unknown[]) {
      if (typeof a !== 'number' || !Number.isFinite(a) || Math.abs(a) > WAVETABLE_AMP_LIMIT) {
        throw new TypeError(
          `${what}: partial amplitudes must be finite numbers with |a| <= ${WAVETABLE_AMP_LIMIT}, got ${String(a)}`,
        )
      }
    }
  }
}

/** Validate a custom-table NAME: a word that does not shadow a built-in. */
const validateTableName = (what: string, name: unknown): string => {
  if (typeof name !== 'string' || !TABLE_NAME_RE.test(name)) {
    throw new TypeError(`${what}: name must be a word (letter, then letters/digits/_), got ${JSON.stringify(name)}`)
  }
  if (isName(name)) {
    throw new RangeError(`${what}: '${name}' shadows a built-in wavetable (${WAVETABLE_TABLES.join(', ')}) — pick another name`)
  }
  return name
}

/** Bank builds keyed by the spec's JSON — re-evals redefine the same tables
 *  every run (registry cleared each eval), so this keeps redefinition free.
 *  Small bounded cache; oldest entry evicted. */
const partialBankCache = new Map<string, Bank>()
const PARTIAL_BANK_CACHE_MAX = 32

/** Synthesize the mipmapped bank for a (validated) partial spec. */
const buildBankFromPartials = (frames: readonly (readonly number[])[]): Bank => {
  const key = JSON.stringify(frames)
  const hit = partialBankCache.get(key)
  if (hit !== undefined) return hit
  const bank = frames.map((partials) => {
    const amps = new Float64Array(MAX_HARMONICS + 1)
    for (let h = 1; h <= partials.length; h++) amps[h] = partials[h - 1]!
    return buildFrameMipmaps(amps, partials.length)
  })
  if (partialBankCache.size >= PARTIAL_BANK_CACHE_MAX) {
    partialBankCache.delete(partialBankCache.keys().next().value as string)
  }
  partialBankCache.set(key, bank)
  return bank
}

/** Read-only view a kernel resolves custom banks against (see DspContext). */
export interface WavetableBankRO {
  get(name: string): Bank | undefined
}

/** The realtime engine's custom-table store: name -> mipmapped bank, filled
 *  by loadWavetable messages. set() validates + synthesizes (throws TypeError/
 *  RangeError on a bad spec — the engine surfaces it as an error event). */
export class WavetableBank implements WavetableBankRO {
  private readonly map = new Map<string, Bank>()

  set(name: string, frames: number[][]): void {
    const n = validateTableName(`loadWavetable`, name)
    validateWavetableFrames(`loadWavetable '${n}'`, frames)
    this.map.set(n, buildBankFromPartials(frames))
  }

  get(name: string): Bank | undefined {
    return this.map.get(name)
  }

  delete(name: string): void {
    this.map.delete(name)
  }

  has(name: string): boolean {
    return this.map.has(name)
  }

  names(): string[] {
    return [...this.map.keys()]
  }
}

interface CustomTable {
  frames: number[][]
  bank: Bank
}

/** A saved copy of the custom-table registry (opaque to callers). */
export type CustomWavetableSnapshot = ReadonlyMap<string, CustomTable>

/** Module-global custom-table registry for the EVAL realm. The eval layer
 *  owns its lifecycle (snapshot -> clear -> run -> restore on failure), so it
 *  always mirrors the LAST SUCCESSFUL eval — same contract as custom scales. */
const customTables = new Map<string, CustomTable>()

/**
 * Register a custom wavetable under `name`: `frames` is an array of FRAMES,
 * each an array of harmonic partial amplitudes (frames[f][i] = harmonic i+1).
 * Band-limited single-cycle frames are synthesized from the partials, so the
 * table anti-aliases exactly like the built-ins. Redefining a name silently
 * replaces it (evals re-run whole programs — idempotence is required);
 * shadowing a built-in table is an error. The numbers are the whole truth:
 * editing an amplitude IS editing the sound.
 */
export function defineWavetable(name: string, frames: number[][]): void {
  const n = validateTableName('defineWavetable()', name)
  validateWavetableFrames(`defineWavetable('${n}')`, frames)
  customTables.set(n, { frames: frames.map((f) => [...f]), bank: buildBankFromPartials(frames) })
}

/** Drop every registered custom table (the eval layer calls this at the start
 *  of each run so removed defineWavetable calls do not linger). */
export function clearCustomWavetables(): void {
  customTables.clear()
}

/** Copy the registry, for restore-on-failed-eval (all-or-nothing staging). */
export function snapshotCustomWavetables(): CustomWavetableSnapshot {
  return new Map(customTables)
}

/** Replace the registry with a snapshot taken earlier. */
export function restoreCustomWavetables(snap: CustomWavetableSnapshot): void {
  customTables.clear()
  for (const [k, v] of snap) customTables.set(k, v)
}

/** The registry's partial specs (name -> frames), for the Session's wire diff
 *  and offline-render threading. Frames are the registry's own copies — read
 *  only. */
export function getCustomWavetables(): ReadonlyMap<string, number[][]> {
  return new Map([...customTables].map(([k, v]) => [k, v.frames]))
}

/** True when `name` resolves to a table in this realm (built-in or registry) —
 *  the eval layer's staging check uses this to catch typos before play. */
export function hasWavetable(name: string): boolean {
  return isName(name) || customTables.has(name)
}

/** The mipmapped bank for ANY table name known in this realm: built-in or
 *  registry custom. The widget layer draws from this. */
export function getWavetableBank(name: string): Bank | undefined {
  if (isName(name)) return getBank(name)
  return customTables.get(name)?.bank
}

/** Morphing, mipmapped wavetable oscillator. Inputs 'freq' (Hz, audio-rate,
 *  clamped to +/-Nyquist) and 'pos' (0..1, morph position, audio-rate, clamped);
 *  output the band-limited morphed waveform, ~[-1, 1]. Config { table } names a
 *  built-in table (default 'basic') or a CUSTOM one (defineWavetable /
 *  loadWavetable); an unknown name throws at construction. Custom banks
 *  re-resolve by name PER BLOCK (like SampleKernel), so redefining a table's
 *  partials is heard live without rebuilding the synth. */
export class WavetableKernel implements Kernel {
  private phase = 0
  private bank: Bank
  /** set for a custom table: the name to re-resolve each block. */
  private readonly customName: string | undefined
  /** where the custom name resolves: the engine's ctx bank when present
   *  (worklet), else the module registry (offline render / eval realm). */
  private readonly custom: WavetableBankRO | undefined

  constructor(table?: string, ctx?: DspContext) {
    const name = table ?? 'basic'
    if (isName(name)) {
      this.bank = getBank(name)
      this.customName = undefined
      this.custom = undefined
      return
    }
    const ro = ctx?.wavetables as WavetableBankRO | undefined
    const bank = ro?.get(name) ?? customTables.get(name)?.bank
    if (bank === undefined) {
      const custom = [...new Set([...(ro instanceof WavetableBank ? ro.names() : []), ...customTables.keys()])]
      const known = [...WAVETABLE_TABLES, ...custom].join(', ')
      throw new Error(`unknown wavetable '${name}' (known: ${known})`)
    }
    this.bank = bank
    this.customName = name
    this.custom = ro
  }

  process(n: number, inputs: Record<string, Float32Array>, out: Float32Array, ctx: DspContext): void {
    const freq = inputs['freq']!
    const pos = inputs['pos']!
    const size = WAVETABLE_FRAME_SIZE
    const mask = size - 1
    const nyquist = ctx.sampleRate * 0.5
    // custom tables re-resolve per block so a live redefinition (a widget drag
    // rewriting partials) is heard immediately; a table cleared mid-note keeps
    // the last resolved bank (graceful, never silent mid-voice).
    if (this.customName !== undefined) {
      const fresh = this.custom?.get(this.customName) ?? customTables.get(this.customName)?.bank
      if (fresh !== undefined) this.bank = fresh
    }
    const bank = this.bank
    const lastFrame = bank.length - 1

    for (let i = 0; i < n; i++) {
      const f = freq[i]!
      let dt = f / ctx.sampleRate
      if (dt > 0.5) dt = 0.5
      else if (dt < -0.5) dt = -0.5

      // --- mipmap by pitch: keep harmonics with h <= Nyquist/|freq| ---------
      // largest mipmap (most harmonics, count 2^(LOG2-m)) whose harmonics fit.
      const af = f < 0 ? -f : f
      let m = 0
      if (af > 0) {
        const allowed = nyquist / af // max non-aliasing harmonic
        m = Math.ceil(LOG2_MAX_HARMONICS - Math.log2(allowed))
        if (m < 0) m = 0
        else if (m > NUM_MIPMAPS - 1) m = NUM_MIPMAPS - 1
      }

      // --- morph between the two frames bracketing pos ----------------------
      let p = pos[i]!
      if (p < 0) p = 0
      else if (p > 1) p = 1
      const fp = p * lastFrame
      let f0 = fp | 0
      if (f0 > lastFrame) f0 = lastFrame
      const f1 = f0 < lastFrame ? f0 + 1 : f0
      const ffrac = fp - f0

      // --- read: linear interpolation within each frame's mipmap ------------
      const posf = this.phase * size
      const i0 = posf | 0
      const frac = posf - i0
      const i1 = (i0 + 1) & mask
      const tblA = bank[f0]![m]!
      const tblB = bank[f1]![m]!
      const sA = tblA[i0]! + frac * (tblA[i1]! - tblA[i0]!)
      const sB = tblB[i0]! + frac * (tblB[i1]! - tblB[i0]!)
      out[i] = sA + ffrac * (sB - sA)

      this.phase += dt
      this.phase -= Math.floor(this.phase)
    }
    this.phase = flush(this.phase)
  }

  reset(): void {
    this.phase = 0
  }
}
