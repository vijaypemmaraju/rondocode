/** One decoded audio buffer: mono PCM at its own sample rate. Stereo sources
 *  are downmixed to mono on load (the voice graph is mono until pan/out). */
export interface SampleData {
  data: Float32Array
  sampleRate: number
}

/** Read-only view of the sample store a SampleKernel resolves names against.
 *  The kernel holds this reference and looks up by name PER BLOCK, so a sample
 *  loaded after the synth was compiled becomes audible without recompiling. */
export interface SampleBankRO {
  get(name: string): SampleData | undefined
}

export interface DspContext {
  sampleRate: number
  /** Freeverb stereo-spread offset in REFERENCE samples (at 44100 Hz), added to
   *  every comb/allpass length. 0/undefined = the standard tuning. The per-synth
   *  post-chain compiles its RIGHT mono instance with a nonzero spread so the two
   *  otherwise-identical reverb instances decorrelate on identical (centered)
   *  input — natural stereo width. Voice-graph reverb passes a plain ctx (spread
   *  0), so per-voice reverb is unchanged. Only ReverbKernel reads it. */
  spread?: number
  /** Loaded audio samples, resolved by name by SampleKernel. Shared mutable
   *  store: the engine populates it from loadSample messages, and already-
   *  compiled kernels see later loads (they resolve by name each block). */
  samples?: SampleBankRO
}

/** One processor instance = one node inside one voice.
 *  process() runs per-sample-capable blocks: inputs/outputs are Float32Array
 *  slices of length n. Inputs are already-resolved buffers (constants are
 *  pre-filled). Mono everywhere except 'pan'/'out' which produce stereo pairs. */
export interface Kernel {
  process(
    n: number,
    inputs: Record<string, Float32Array>,
    out: Float32Array,
    ctx: DspContext,
  ): void
  reset(): void
}
