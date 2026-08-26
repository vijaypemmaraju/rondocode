import type { SampleData, SampleBankRO } from './dsp/types'

/**
 * A sample reference split into its family and variant: `bd:3` is variant 3 of
 * the family `bd`, and a bare `bd` is variant 0.
 *
 * ONE PARSER, used by both ends of the store and by the missing-sample
 * diagnostic, because a reference that loads under one reading and resolves
 * under another is the exact bug this replaces: `bd:3` used to become a sound
 * NAMED "bd:3", which matched nothing and played silence without complaint.
 *
 * Only a trailing `:<non-negative integer>` counts. Anything else is part of
 * the name, so a sample genuinely called `my:thing` still works.
 */
export function parseSampleRef(name: string): { base: string; index: number | undefined } {
  const cut = name.lastIndexOf(':')
  if (cut <= 0 || cut === name.length - 1) return { base: name, index: undefined }
  const tail = name.slice(cut + 1)
  if (!/^\d+$/.test(tail)) return { base: name, index: undefined }
  return { base: name.slice(0, cut), index: Number(tail) }
}

/** The canonical name of a variant: variant 0 IS the family name, so a bank
 *  holding one sample reads exactly as it did before variants existed. */
export const sampleRefName = (base: string, index: number): string =>
  index === 0 ? base : `${base}:${index}`

/** The engine's sample store: family -> decoded mono PCM per variant. The
 *  realtime engine owns one and exposes it on DspContext.samples; SampleKernels
 *  hold a reference and resolve names against it each block, so a sample loaded
 *  after a synth was compiled becomes audible with no recompile.
 *
 *  A family is an array indexed by variant, so `bd`, `bd:1` and `bd:2` are one
 *  entry with three slots rather than three unrelated names. Lookups WRAP
 *  (`bd:3` of a three-deep family is `bd`), which is what makes a variant index
 *  patternable: `bd:<0 1 2 3>` cycles through whatever is loaded instead of
 *  falling silent past the end. */
export class SampleBank implements SampleBankRO {
  private readonly map = new Map<string, (SampleData | undefined)[]>()

  /** Store (or replace) a mono buffer under `name`, which may name a variant
   *  (`bd:2`). Non-finite samples are scrubbed to 0 so a bad decode can't
   *  inject NaN onto the audio path. */
  set(name: string, data: Float32Array, sampleRate: number): void {
    for (let i = 0; i < data.length; i++) {
      if (!Number.isFinite(data[i]!)) data[i] = 0
    }
    const { base, index } = parseSampleRef(name)
    let family = this.map.get(base)
    if (family === undefined) {
      family = []
      this.map.set(base, family)
    }
    family[index ?? 0] = { data, sampleRate }
  }

  /**
   * Resolve a reference to PCM. A bare name is variant 0; an index wraps
   * around the family, so it can be driven from a pattern without going
   * silent at the end.
   *
   * A GAP stays undefined rather than sliding to a neighbour: loading `bd`
   * and `bd:5` leaves 1..4 empty, and quietly substituting a different sample
   * for the one that was asked for would be worse than silence, which the
   * missing-sample diagnostic reports anyway.
   */
  get(name: string): SampleData | undefined {
    const { base, index } = parseSampleRef(name)
    const family = this.map.get(base)
    if (family === undefined || family.length === 0) return undefined
    return family[index === undefined ? 0 : index % family.length]
  }

  /** How many variant slots a family spans (its highest index plus one), or 0
   *  when nothing is loaded under that name. */
  depth(name: string): number {
    return this.map.get(parseSampleRef(name).base)?.length ?? 0
  }

  /** Drop one variant, or the whole family when no index is given. */
  delete(name: string): void {
    const { base, index } = parseSampleRef(name)
    if (index === undefined) {
      this.map.delete(base)
      return
    }
    const family = this.map.get(base)
    if (family === undefined) return
    family[index] = undefined
    while (family.length > 0 && family[family.length - 1] === undefined) family.pop()
    if (family.length === 0) this.map.delete(base)
  }

  has(name: string): boolean {
    return this.get(name) !== undefined
  }

  /** Names currently loaded (for diagnostics/UI), one per occupied slot. */
  names(): string[] {
    const out: string[] = []
    for (const [base, family] of this.map) {
      family.forEach((s, i) => {
        if (s !== undefined) out.push(sampleRefName(base, i))
      })
    }
    return out
  }
}

/** Every sample name a graph plays: the `name` config of its `sample` and
 *  `granular` nodes.
 *
 *  Exists because a render with no sample bank is SILENT for those voices and
 *  says nothing about it — an offline bounce of the `granular` example wrote a
 *  file of digital zero and reported success. Callers use this to say which
 *  sample is missing before spending the render, or to explain the silence
 *  after it. */
export function sampleNamesIn(graph: { nodes: { type: string; config?: Record<string, unknown> }[] }): string[] {
  const out = new Set<string>()
  for (const n of graph.nodes) {
    if (n.type !== 'sample' && n.type !== 'granular') continue
    const name = n.config?.['name']
    if (typeof name === 'string' && name.length > 0) out.add(name)
  }
  return [...out]
}

/** True when a graph reads the LIVE MICROPHONE (a `mic` node).
 *
 *  Same purpose as {@link sampleNamesIn}: an offline render has no input
 *  device, so these voices are silent by construction and a sweep that called
 *  that a defect would be crying wolf. The app uses it for a different reason
 *  — deciding whether to ask for microphone permission — and both read this
 *  one walk rather than each writing their own. */
export function usesMicIn(graph: { nodes: { type: string }[] }): boolean {
  return graph.nodes.some((n) => n.type === 'mic')
}

/** EVERY input device a graph's mic() nodes ask for — ids or label parts —
 *  in first-appearance order, each once. Lives beside usesMicIn because it
 *  is the SAME walk over the same node type, and two walks are how they
 *  drift. Multiple devices are real: each opens its own live capture slot
 *  (see the engine's MAX_MIC_INPUTS), so two synths can listen to two
 *  microphones at once. */
export function micDevicesIn(
  graph: { nodes: { type: string; config?: Record<string, unknown> }[] },
): string[] {
  const out: string[] = []
  for (const n of graph.nodes) {
    if (n.type !== 'mic') continue
    const d = n.config?.['device']
    if (typeof d === 'string' && d !== '' && !out.includes(d)) out.push(d)
  }
  return out
}

/** The FIRST device a graph's mic() asks for — the single-device view, kept
 *  for callers that predate multiple inputs. */
export function micDeviceIn(
  graph: { nodes: { type: string; config?: Record<string, unknown> }[] },
): string | undefined {
  return micDevicesIn(graph)[0]
}
