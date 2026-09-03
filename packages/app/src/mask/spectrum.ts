/* ------------------------------------------------------------------------- *
 * The master analyser → the 24 levels a rhythm frame carries.
 *
 * Two pure steps, so the shape of what the mask draws can be tested without
 * an AudioContext:
 *
 *   spectrumBands  folds the analyser's byte spectrum (0..255, its dB floor
 *                  to its ceiling) into 24 log-spaced bands over the same
 *                  40 Hz..16 kHz the panel's spectrum draws, each band the
 *                  loudest bin it covers.
 *
 *   RhythmLevels   turns those into 0..9 the way the mask's own app does it
 *                  (VisualizerView.onWaveFormDataCapture): against a CEILING
 *                  that is the loudest band seen lately and decays slowly,
 *                  so the loudest thing in the mix fills its bar whatever the
 *                  master level is, and a quieter passage grows back into
 *                  the panel over a few seconds instead of sulking at two
 *                  pixels. Two things the app does not do: a FLOOR, so that
 *                  silence is dark rather than nine bars of noise (the app's
 *                  ceiling falls until the noise fills it); and a TILT that
 *                  lifts the high bands, because a dB spectrum of real music
 *                  slopes down some 30 dB from the kick to the hats, and
 *                  without it the top half of every visualizer is dark.
 *
 * The app works on linear magnitudes with a multiplicative decay; this works
 * in the analyser's dB bytes with a subtractive one, which is the same idea
 * in the domain the data comes in.
 * ------------------------------------------------------------------------- */

import { RHYTHM_BANDS, RHYTHM_LEVEL_MAX } from './protocol'

/** The same span the panel's spectrum draws (viz.ts). */
const MIN_HZ = 40
const MAX_HZ = 16000

/** Bin edges for `bands` log-spaced bands: edge i is the first bin of band i,
 *  edge `bands` the end. A band narrower than a bin at the bottom shares the
 *  bin with its neighbour rather than being empty. */
const bandEdges = (bands: number, binHz: number): Int32Array => {
  const edges = new Int32Array(bands + 1)
  for (let i = 0; i <= bands; i++) edges[i] = Math.floor((MIN_HZ * Math.pow(MAX_HZ / MIN_HZ, i / bands)) / binHz)
  return edges
}

let edgeCache: { binHz: number; edges: Int32Array } | null = null

/** `freq` is what getByteFrequencyData filled; `binHz` the width of one bin
 *  (sampleRate / fftSize). Returns 24 band peaks, 0..255. */
export function spectrumBands(freq: Uint8Array, binHz: number, out: Float32Array = new Float32Array(RHYTHM_BANDS)): Float32Array {
  if (edgeCache === null || edgeCache.binHz !== binHz) edgeCache = { binHz, edges: bandEdges(RHYTHM_BANDS, binHz) }
  const edges = edgeCache.edges
  for (let b = 0; b < RHYTHM_BANDS; b++) {
    const lo = Math.min(freq.length, edges[b]!)
    const hi = Math.min(freq.length, Math.max(lo + 1, edges[b + 1]!))
    let peak = 0
    for (let i = lo; i < hi; i++) if (freq[i]! > peak) peak = freq[i]!
    out[b] = peak
  }
  return out
}

export interface RhythmLevelsOpts {
  /** a band at or under this (byte units) is dark; default 80, about -78 dB */
  floor?: number
  /** byte units added to the top band, linearly from 0 at the bottom; default
   *  60, about +16 dB, half the slope of a typical mix */
  tilt?: number
  /** how far the ceiling falls per frame, in byte units; default 1, which at
   *  25 fps is about 7 dB a second */
  decay?: number
}

export class RhythmLevels {
  readonly levels = new Uint8Array(RHYTHM_BANDS)
  private readonly tilted = new Float64Array(RHYTHM_BANDS)
  private ceiling = 0
  private readonly floor: number
  private readonly tilt: number
  private readonly decay: number

  constructor(opts: RhythmLevelsOpts = {}) {
    this.floor = opts.floor ?? 80
    this.tilt = opts.tilt ?? 60
    this.decay = opts.decay ?? 1
  }

  /** `bands` are 24 peaks in byte units (spectrumBands). Returns the levels,
   *  the same array each call. */
  update(bands: ArrayLike<number>): Uint8Array {
    const tilted = this.tilted
    let peak = 0
    for (let i = 0; i < RHYTHM_BANDS; i++) {
      const v = bands[i]! + (this.tilt * i) / (RHYTHM_BANDS - 1)
      tilted[i] = v
      if (v > peak) peak = v // NaN compares false and is left out
    }
    // the ceiling never sits on the floor, or one frame of hiss would be a full panel
    this.ceiling = Math.max(this.ceiling - this.decay, peak, this.floor + 1)
    const span = this.ceiling - this.floor
    for (let i = 0; i < RHYTHM_BANDS; i++) {
      const v = tilted[i]!
      this.levels[i] = v > this.floor ? Math.min(RHYTHM_LEVEL_MAX, Math.ceil((RHYTHM_LEVEL_MAX * (v - this.floor)) / span)) : 0
    }
    return this.levels
  }

  /** Forget the ceiling: the next frame's loudest band is full. */
  reset(): void {
    this.ceiling = 0
  }
}

/** The slice of AnalyserNode this reads, so a test can hand in an array. */
export interface SpectrumSource {
  readonly frequencyBinCount: number
  getByteFrequencyData(out: Uint8Array): void
}

/** An analyser read as rhythm levels: one call per frame. */
export class MaskSpectrum {
  private readonly freq: Uint8Array
  private readonly bands = new Float32Array(RHYTHM_BANDS)
  private readonly norm: RhythmLevels
  private readonly binHz: number

  constructor(private readonly src: SpectrumSource, sampleRate: number, opts: RhythmLevelsOpts = {}) {
    this.freq = new Uint8Array(src.frequencyBinCount)
    this.binHz = sampleRate / (2 * src.frequencyBinCount)
    this.norm = new RhythmLevels(opts)
  }

  levels(): Uint8Array {
    this.src.getByteFrequencyData(this.freq)
    return this.norm.update(spectrumBands(this.freq, this.binHz, this.bands))
  }

  reset(): void {
    this.norm.reset()
  }
}
