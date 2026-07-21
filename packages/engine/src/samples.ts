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
