import { getCustomWavetables } from '@rondocode/engine'
import { stageCode, runPatterns, renderMix } from '../../../server/src/render-runner'
import type { MixStem } from '../../../server/src/render-runner'
import type { AudioSession } from '../audio/AudioSession'
import { normalize, toMono } from './micrec'

/* RESAMPLE TO LOOP: bounce N cycles of the staged track back into the sample
 * bank as a named take, then chop/loop it like any sample. Compose something
 * freely, tap a cycle count in the samples popover, and `sample(gate, 'take1')`
 * plays it back while you build the next layer on top.
 *
 * The offline render is the SAME staged→renderMix mapping the WAV export
 * uses (renderStagedMix below, shared by both), so a bounced take can never
 * quietly sound different from an exported loop. The take then gets the same
 * treatment a mic recording gets: mono, normalized, loaded via loadSamplePcm. */

/** First free takeN name against the existing sample names. Pure. */
export function nextTakeName(existing: readonly string[]): string {
  const taken = new Set(existing)
  for (let i = 1; ; i++) {
    const name = `take${i}`
    if (!taken.has(name)) return name
  }
}

/** Frame count of exactly `cycles` cycles at `cps`: round(cycles/cps * sr).
 *  Sample-accurate loop length is the whole point of resampling. Pure. */
export function exactLoopFrames(cps: number, cycles: number, sampleRate: number): number {
  return Math.round((cycles / cps) * sampleRate)
}

export interface StagedMix {
  left: Float32Array
  right: Float32Array
  sampleRate: number
  /** the staged tempo the render ran at (cycles per second) */
  cps: number
  /** dB the mix stage scaled the whole bounce down by to reach its 0.89 peak
   *  ceiling; 0 when it stayed under. Carried through because the ONE staged
   *  mapping used to drop it, which left every caller — the WAV bounce, the
   *  stems, the loudness readout, resample-to-loop — unable to say that a
   *  gain edit above the ceiling changes the balance but not the level. */
  normalizeDb: number
  /** Present iff `stems` was requested: each part's contribution to THIS mix
   *  (see renderMix's MixStem). Summed, they reconstruct left/right. */
  stems?: MixStem[]
}

export interface StagedMixOpts {
  /** Also return every synth's (and every send bus's) own audio. */
  stems?: boolean
  /** Render rate in Hz. Default 48000. */
  sampleRate?: number
}

/** Stage `code` and render `cycles` of it offline: stageCode → runPatterns →
 *  renderMix. `samples` is the live engine's loaded sample bank so offline
 *  sample('name') nodes play the same audio.
 *
 *  This is the ONE staged→renderMix option mapping, shared by the WAV export
 *  (bounceLoop) and the resample-to-loop path. A staged feature (samples /
 *  sidechain / masterCompress / buses+sends) that this mapping dropped would
 *  render output that quietly sounds DIFFERENT from the live session — the
 *  audited silently-dropped-option bug class — so both paths must flow
 *  through here, and a test pins that their renderMix options are identical. */
export function renderStagedMix(
  code: string,
  cycles: number,
  samples?: Record<string, { data: Float32Array; sampleRate: number }>,
  opts?: StagedMixOpts,
): StagedMix | { error: string } {
  const staged = stageCode(code)
  if (!staged.ok) return { error: staged.diagnostics.find((d) => d.severity === 'error')?.message ?? 'eval failed' }
  const cps = staged.cps ?? 0.5
  const durationSec = cycles / cps
  const events = runPatterns(staged.patterns, { cycles, cps })
  const tables = getCustomWavetables()
  const mix = renderMix(staged.synths, events, durationSec, {
    sampleRate: opts?.sampleRate ?? 48000,
    // The tempo the events were scheduled at: `sync` lfo/delay nodes rate
    // themselves off it, so an omitted cps would bounce at the wrong speed.
    cps,
    ...(samples ? { samples } : {}),
    ...(staged.sidechain ? { sidechain: staged.sidechain } : {}),
    ...(staged.masterComp ? { masterComp: staged.masterComp } : {}),
    ...(staged.buses.size > 0 ? { buses: staged.buses, sends: staged.sends } : {}),
    // custom wavetables the staged program registered (defineWavetable/wavedef)
    ...(tables.size > 0 ? { wavetables: Object.fromEntries(tables) } : {}),
    ...(opts?.stems ? { stems: true } : {}),
  })
  return {
    left: mix.left,
    right: mix.right,
    sampleRate: mix.sampleRate,
    cps,
    normalizeDb: mix.normalizeDb,
    ...(mix.stems ? { stems: mix.stems } : {}),
  }
}

/** Render `cycles` of `code` into loop-ready mono PCM: offline mix, downmix
 *  to mono, normalize to 0.9 peak (both via micrec's helpers, so a take gets
 *  exactly the mic-recording treatment), then force EXACTLY
 *  exactLoopFrames(cps, cycles, sr) frames. Anything past the loop end
 *  (release/reverb tails that ring past the last cycle) is TRUNCATED — that
 *  is standard resampling behavior; a tail would double up when the loop
 *  repeats — and a short render is zero-padded to length. */
export function renderTakePcm(
  code: string,
  cycles: number,
  samples?: Record<string, { data: Float32Array; sampleRate: number }>,
): { data: Float32Array; sampleRate: number; normalizeDb: number } | { error: string } {
  const mix = renderStagedMix(code, cycles, samples)
  if ('error' in mix) return mix
  const mono = normalize(
    toMono({ numberOfChannels: 2, length: mix.left.length, getChannelData: (c) => (c === 0 ? mix.left : mix.right) }),
  )
  const frames = exactLoopFrames(mix.cps, cycles, mix.sampleRate)
  let data = mono
  if (mono.length !== frames) {
    data = new Float32Array(frames)
    data.set(mono.subarray(0, Math.min(mono.length, frames)))
  }
  return { data, sampleRate: mix.sampleRate, normalizeDb: mix.normalizeDb }
}

export interface ResampleOpts {
  /** the last successfully evaluated program (post-transpile JS in rondo mode) */
  code: string
  cycles: number
  audio: Pick<AudioSession, 'loadedSamples' | 'getSamples' | 'loadSamplePcm'>
}

/** Bounce `cycles` cycles of the staged track into the sample bank as the
 *  next free takeN. Loads it exactly the way a mic take loads (loadSamplePcm,
 *  not built-in, session-lifetime persistence). Returns the take name or an
 *  error message; never throws. */
export function resampleTake({ code, cycles, audio }: ResampleOpts): { name: string; normalizeDb: number } | { error: string } {
  try {
    const res = renderTakePcm(code, cycles, audio.loadedSamples)
    if ('error' in res) return res
    const name = nextTakeName(audio.getSamples().map((s) => s.name))
    audio.loadSamplePcm(name, res.data, res.sampleRate)
    return { name, normalizeDb: res.normalizeDb }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}
