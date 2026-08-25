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
  /** TRANSPORT TEMPO in cycles per second, the ONE number tempo-synced kernels
   *  read. Absent = DEFAULT_CPS (0.5, i.e. 120 bpm at four beats per cycle), so
   *  a plain `{ sampleRate }` ctx (tests, older hosts) still syncs sanely.
   *
   *  MUTABLE AND SHARED: the RealtimeEngine owns one ctx object that every
   *  compiled kernel holds a reference to, and a `setCps` message writes this
   *  field in place. Synced kernels therefore re-read it EVERY BLOCK and
   *  re-rate themselves live — a tempo change never recompiles a graph and
   *  never restarts a voice. Read it through `cpsOf(ctx)` so the default and
   *  the positive-finite guard stay in one place. */
  cps?: number
  /** LIVE MIC block: when present, every compiled graph's `mic` node ALIASES
   *  this buffer, so the host writes one block per quantum and all graphs see
   *  it with zero copying. Absent (offline render, tests) a mic node reads a
   *  private zeroed buffer — silence. */
  mic?: Float32Array
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
  /** Custom wavetable banks (name -> frames[frame][mipmap] of single-cycle
   *  Float32Arrays), resolved by name by WavetableKernel. Same shared-store
   *  contract as samples: the engine fills it from loadWavetable messages and
   *  kernels re-resolve per block, so a redefined table is heard without a
   *  synth rebuild. Structural type (not WavetableBankRO) to keep this module
   *  import-free of the wavetable module that imports it. */
  wavetables?: { get(name: string): Float32Array[][] | undefined }
  /** NAMED LOOPER registry: looper kernels whose config carries a `name`
   *  register themselves here at construction, so a bounceLoop message can
   *  find the pedal to copy. Same shared-store contract as samples (the
   *  engine owns one Map on its ctx); typed structurally (object) to keep
   *  this module import-free of the looper module that imports it. */
  loopers?: Map<string, object>
  /** Trained DDSP instrument models, resolved by name by DdspKernel. Same
   *  shared-store contract as samples: the engine fills it from loadDdspModel
   *  messages and kernels re-resolve per block, so a model loaded after
   *  compile becomes audible with no rebuild. Values are parsed DdspModel
   *  objects; typed structurally (object) to keep this module import-free of
   *  the ddsp module that imports it — DdspModelBank is the only writer. */
  ddsp?: { get(name: string): object | undefined }
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
