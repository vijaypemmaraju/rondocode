import type { SampleData, SampleBankRO } from './dsp/types'

/** The engine's sample store: name -> decoded mono PCM. The realtime engine
 *  owns one and exposes it on DspContext.samples; SampleKernels hold a
 *  reference and resolve names against it each block, so a sample loaded after
 *  a synth was compiled becomes audible with no recompile. */
export class SampleBank implements SampleBankRO {
  private readonly map = new Map<string, SampleData>()

  /** Store (or replace) a mono buffer under `name`. Non-finite samples are
   *  scrubbed to 0 so a bad decode can't inject NaN onto the audio path. */
  set(name: string, data: Float32Array, sampleRate: number): void {
    for (let i = 0; i < data.length; i++) {
      if (!Number.isFinite(data[i]!)) data[i] = 0
    }
    this.map.set(name, { data, sampleRate })
  }

  get(name: string): SampleData | undefined {
    return this.map.get(name)
  }

  delete(name: string): void {
    this.map.delete(name)
  }

  has(name: string): boolean {
    return this.map.has(name)
  }

  /** Names currently loaded (for diagnostics/UI). */
  names(): string[] {
    return [...this.map.keys()]
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
