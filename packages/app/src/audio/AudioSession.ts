import type { EngineEvent, EngineMessage } from '@rondocode/engine'
import { MAX_MIC_INPUTS } from '@rondocode/engine'
import workletUrl from './worklet/processor?worker&url'
import { explainChoice, latencyReport, resolveDevice, resolveMicProcessing } from './devices'
import type { DeviceChoice, DeviceInfo, LatencyReport, MicProcessing } from './devices'

/* Main-thread side of the audio stack: owns the AudioContext and the
 * AudioWorkletNode hosting RealtimeEngine (see ./processor.ts), and speaks
 * the EngineMessage/EngineEvent wire protocol over the node's port.
 *
 * Worklet module loading (the Vite-specific part): the `?worker&url` import
 * above. Tried first: bare `new URL('./processor.ts', import.meta.url)` —
 * Vite 5 does NOT bundle that for .ts targets; it inlines the raw TypeScript
 * source as a base64 `data:video/mp2t` asset (broken: uncompiled, bare
 * imports unresolved). `?worker&url` works in both modes: dev serves the
 * transformed module (`/src/audio/processor.ts?worker_file&type=module`),
 * build emits a self-contained ES-module chunk (worker.format: 'es' in
 * vite.config.ts) whose URL lands here. AudioWorklet always loads modules,
 * so a Worker-flavored module URL is exactly what addModule needs. */

/** A sample loaded into the engine, as tracked on the main thread for the UI. */
export interface SampleInfo {
  name: string
  /** length in frames at `sampleRate` */ frames: number
  sampleRate: number
  /** true for the demo samples shipped by default (see BUILT_IN_SAMPLE_NAMES) */ builtIn: boolean
}

export class AudioSession {
  /** Engine → host events (errors, meters), forwarded from the node's port.
   *  Single-listener by design: the Session layer (Task 3.2) owns this and
   *  UI subscribes through it — assigning here is last-writer-wins. */
  onEvent?: (ev: EngineEvent) => void

  /** Visualizer tap (worklet → analyser → destination), or null when the
   *  tap could not be built — viz then simply has no data (see start()). */
  readonly analyser: AnalyserNode | null

  /** Per-side taps for stereo metering, or null when the split could not be
   *  built. Pure taps: NOT connected to the destination. */
  readonly analyserL: AnalyserNode | null
  readonly analyserR: AnalyserNode | null

  /** Main-thread mirror of the samples loaded into the worklet, in load order
   *  (built-ins first). The worklet is the source of truth for playback; this
   *  is just so the UI can list what is loadable by name. */
  private readonly _samples: SampleInfo[] = []
  private readonly sampleListeners = new Set<() => void>()
  /** main-thread copy of each sample's PCM, kept so the UI can preview it
   *  (the worklet's copy is transferred and not readable from here). */
  private readonly _pcm = new Map<string, { data: Float32Array; sampleRate: number }>()
  private _preview: AudioBufferSourceNode | null = null

  private constructor(
    private readonly context: AudioContext,
    private readonly node: AudioWorkletNode,
    /** Output channels the worklet actually opened: 2 on plain stereo, up to
     *  32 on a multichannel interface — what `out SYNTH N..M` can land on. */
    readonly outputChannels: number,
    analyser: AnalyserNode | null,
    analyserL: AnalyserNode | null = null,
    analyserR: AnalyserNode | null = null,
  ) {
    this.analyser = analyser
    this.analyserL = analyserL
    this.analyserR = analyserR
    node.port.onmessage = (e: MessageEvent) => this.onEvent?.(e.data as EngineEvent)
    // refresh the device-label cache when hardware comes or goes, so the
    // `mic device:` completion tracks what is actually plugged in
    try {
      globalThis.navigator?.mediaDevices?.addEventListener?.('devicechange', () => {
        void this.listDevices()
      })
    } catch {
      // no mediaDevices (tests, exotic shells): the cache just stays empty
    }
  }

  /** Create the context + worklet graph. Safe to call at page load: the
   *  AudioContext starts SUSPENDED (creating it and loading the worklet module
   *  need no user gesture) and produces no sound until resume(), which the
   *  first Run calls from its click/keypress gesture (the iOS requirement).
   *  Throws on failure; callers surface the message. */
  static async start(): Promise<AudioSession> {
    const context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' })
    if (import.meta.env.DEV) (window as unknown as { __rcCtx: AudioContext }).__rcCtx = context
    try {
      await context.audioWorklet.addModule(workletUrl)
      /* MULTICHANNEL OUT: open every channel the device offers (capped at 32,
       * the engine's MAX_OUT_CHANNELS) so `out lead 3..4` lands on real
       * jacks. 'discrete' stops the graph from remixing routed stems into the
       * master pair. Any failure falls back to plain stereo, which is exactly
       * the pre-multichannel behavior. */
      let chans = 2
      try {
        const want = Math.max(2, Math.min(context.destination.maxChannelCount || 2, 32))
        if (want > 2) {
          context.destination.channelCount = want
          context.destination.channelInterpretation = 'discrete'
        }
        chans = want
      } catch (chErr) {
        console.warn('[audio] multichannel output unavailable; staying stereo', chErr)
        chans = 2
      }
      const node = new AudioWorkletNode(context, 'rondocode-engine', {
        numberOfInputs: MAX_MIC_INPUTS, // 0 = the default LIVE MIC, 1.. = device-named captures (all connected lazily by setMicEnabled)
        numberOfOutputs: 1,
        outputChannelCount: [chans], // the master pair + any routed hardware outs
      })
      if (import.meta.env.DEV) (window as unknown as { __rcNode: AudioWorkletNode }).__rcNode = node
      // Visualizer tap: worklet → analyser → destination. FAIL-OPEN: if the
      // analyser can't be created or wired, fall back to a direct
      // worklet → destination connection — audio must NEVER break because a
      // visualizer couldn't attach. (analyser stays null; viz draws nothing.)
      /* AUDIO PATH: node → destination, direct, all channels. The analysers
       * below are PURE TAPS (never connected onward). The old wiring ran the
       * audio THROUGH the mono analyser, which with a multichannel node would
       * have downmixed every routed stem back into the master pair. */
      node.connect(context.destination)
      let analyser: AnalyserNode | null = null
      let analyserL: AnalyserNode | null = null
      let analyserR: AnalyserNode | null = null
      try {
        const split = context.createChannelSplitter(chans)
        node.connect(split)
        // Master viz: the MASTER PAIR only (channels 0/1), merged and then
        // mono-mixed by the analyser — routed stems are independent feeds and
        // must not color the master picture.
        const merge = context.createChannelMerger(2)
        split.connect(merge, 0, 0)
        split.connect(merge, 1, 1)
        const a = context.createAnalyser()
        a.fftSize = 2048
        a.smoothingTimeConstant = 0.8
        merge.connect(a)
        analyser = a
        // PER-SIDE taps, same reason as ever: an AnalyserNode downmixes to
        // mono, so left/right (and any width measure) need their own.
        const mk = (): AnalyserNode => {
          const s = context.createAnalyser()
          s.fftSize = 1024
          s.smoothingTimeConstant = 0.7
          return s
        }
        const l = mk()
        const r = mk()
        split.connect(l, 0)
        split.connect(r, 1)
        analyserL = l
        analyserR = r
      } catch (tapError) {
        // FAIL-OPEN: audio must never break because a visualizer couldn't
        // attach — the direct node → destination path above already carries it.
        console.warn('[audio] analyser taps failed; visuals draw nothing', tapError)
      }
      // Do NOT resume here: at page load there's no user gesture yet. The
      // context stays suspended (silent) until the first Run calls resume().
      return new AudioSession(context, node, chans, analyser, analyserL, analyserR)
    } catch (e) {
      context.close().catch(() => {})
      throw e
    }
  }

  send(msg: EngineMessage): void {
    this.node.port.postMessage(msg)
  }

  /** Decode an audio file (any format the browser supports — WAV/MP3/etc.) and
   *  load it into the engine under `name`, downmixed to mono. The PCM buffer is
   *  TRANSFERRED to the worklet (zero-copy). Returns the frame count loaded.
   *  Throws if decoding fails (unsupported/corrupt file). */
  // ---- live mic ------------------------------------------------------------
  /** One live capture per input slot: [0] is the default (what a bare mic()
   *  reads), [1..] device-named captures in first-seen order. null = that
   *  slot's device could not be opened. Empty array = mic off. */
  private captures: ({ stream: MediaStream; source: MediaStreamAudioSourceNode } | null)[] = []
  private micWanted = false

  /** Any capture currently open? (Guards the reopen sites.) */
  private micOpen(): boolean {
    return this.captures.some((c) => c !== null)
  }

  /** Connect (or disconnect) the device microphone into the engine's input.
   *  LAZY + idempotent: called after every eval with "does the staged code
   *  use mic()?" — the permission prompt only ever appears for code that
   *  actually listens. Failures (denied, no device) leave the engine reading
   *  silence; the synth still runs. */
  /** What the SETTING asks for (persisted rig), and what the CODE asked for
   *  on the last eval. Both are id-or-label; `resolveDevice` owns which wins. */
  private savedInput: string | undefined
  private savedOutput: string | undefined
  /** Every device the CODE names via `mic device:…` — distinct, first-seen
   *  order, one capture slot each (slot 0 stays the default capture). */
  private codeInputs: string[] = []
  /** raw / voice / auto — see resolveMicProcessing. Reopens the capture when
   *  it changes, because the constraints are fixed at getUserMedia time. */
  private micProcessing: MicProcessing = 'auto'
  private micIsMobile = false
  /** The last resolution, so the UI can report a fallback rather than leaving
   *  a missing interface to be discovered by ear. */
  private lastInputChoice: DeviceChoice = { reason: 'default' }
  private lastOutputChoice: DeviceChoice = { reason: 'default' }

  /** Every audio device the browser will admit to, split by direction. Labels
   *  are EMPTY until a getUserMedia permission has been granted at least once
   *  — that is a privacy rule, not a bug, and the picker has to say so rather
   *  than render a list of blanks. */
  async listDevices(): Promise<{ inputs: DeviceInfo[]; outputs: DeviceInfo[]; labelled: boolean }> {
    const md = globalThis.navigator?.mediaDevices
    if (md?.enumerateDevices === undefined) return { inputs: [], outputs: [], labelled: false }
    const all = await md.enumerateDevices()
    const pick = (kind: 'audioinput' | 'audiooutput'): DeviceInfo[] =>
      all.filter((d) => d.kind === kind).map((d) => ({ deviceId: d.deviceId, label: d.label, kind }))
    const inputs = pick('audioinput')
    const outputs = pick('audiooutput')
    // keep the synchronous label cache fresh: `mic device:` completion reads
    // it (labels are blank until the first permission grant — privacy rule)
    this.inputLabels = inputs.map((d) => d.label).filter((l) => l !== '')
    return { inputs, outputs, labelled: [...inputs, ...outputs].some((d) => d.label !== '') }
  }

  /** Connected INPUT labels, from the last listDevices() — synchronous, for
   *  the editor's `mic device:` completion. Empty before the first mic
   *  permission grant (labels are withheld) and refreshed on devicechange. */
  private inputLabels: string[] = []
  inputDeviceLabels(): readonly string[] {
    return this.inputLabels
  }

  /** Raw capture or the voice-processing path. Reopens a live capture, since
   *  the constraints can only be set when the stream is created. */
  async setMicProcessing(mode: MicProcessing, isMobile: boolean): Promise<void> {
    if (mode === this.micProcessing && isMobile === this.micIsMobile) return
    this.micProcessing = mode
    this.micIsMobile = isMobile
    if (this.micOpen()) {
      await this.setMicEnabled(false)
      await this.setMicEnabled(true)
    }
  }

  /** What the capture is actually doing right now, for the options readout. */
  micProcessingActive(): { echoCancellation: boolean; noiseSuppression: boolean } {
    const c = resolveMicProcessing(this.micProcessing, this.micIsMobile)
    return { echoCancellation: c.echoCancellation, noiseSuppression: c.noiseSuppression }
  }

  /** The saved rig. Re-applies immediately, so choosing a device in the
   *  options panel takes effect without a reload. */
  async setPreferredDevices(input?: string, output?: string): Promise<void> {
    this.savedInput = input
    this.savedOutput = output
    await this.applyOutputDevice()
    if (this.micOpen()) {
      // reopen the captures on the newly chosen input
      await this.setMicEnabled(false)
      await this.setMicEnabled(true)
    }
  }

  /** What the code asked for (every `mic device:"…"` name, distinct, in
   *  first-seen order), set from the staged program. Reopens the captures
   *  only when the set actually changes. */
  async setCodeInputDevices(names: string[]): Promise<void> {
    const capped = names.slice(0, MAX_MIC_INPUTS - 1)
    if (capped.length < names.length) {
      console.warn(
        `[mic] ${names.length} devices named; only ${MAX_MIC_INPUTS - 1} named inputs are supported — ignoring: ${names.slice(MAX_MIC_INPUTS - 1).join(', ')}`,
      )
    }
    if (JSON.stringify(capped) === JSON.stringify(this.codeInputs)) return
    this.codeInputs = capped
    if (this.micOpen()) {
      // reopen the captures on the newly named devices
      await this.setMicEnabled(false)
      await this.setMicEnabled(true)
    }
  }

  /** Route the OUTPUT at a chosen device. `setSinkId` is a page-level API and
   *  is not universal (Firefox gated it for years, and a WKWebView shell may
   *  not have it at all), so this is best-effort: no sink support means the OS
   *  default, which is what happened before this existed. */
  private async applyOutputDevice(): Promise<void> {
    const ctx = this.context as AudioContext & { setSinkId?: (id: string) => Promise<void> }
    if (typeof ctx.setSinkId !== 'function') {
      this.lastOutputChoice = { reason: 'default' }
      return
    }
    const { outputs } = await this.listDevices()
    const choice = resolveDevice(undefined, this.savedOutput, outputs)
    this.lastOutputChoice = choice
    try {
      await ctx.setSinkId(choice.deviceId ?? '')
    } catch (e) {
      console.warn('[audio] output device not available', e)
      this.lastOutputChoice = { reason: 'default', ...(this.savedOutput !== undefined ? { fellBackFrom: this.savedOutput } : {}) }
    }
  }

  /** The measured latency budget — reported, never estimated. `outputLatency`
   *  is 0 in plenty of real contexts, which under-reports rather than lies. */
  latency(): LatencyReport {
    const ctx = this.context as AudioContext & { outputLatency?: number }
    // the DEFAULT capture's track: slot 0 is the one the latency panel means
    const track = this.captures[0]?.stream.getAudioTracks()[0]
    const settings = track?.getSettings() as { latency?: number } | undefined
    return latencyReport(
      this.context.sampleRate,
      this.context.baseLatency ?? 0,
      ctx.outputLatency ?? 0,
      settings?.latency ?? 0,
    )
  }

  /** Anything the user should be told about the current routing: an interface
   *  that was asked for and is not here. Empty when all is well. */
  deviceWarnings(): string[] {
    return [
      explainChoice(this.lastInputChoice, 'input'),
      explainChoice(this.lastOutputChoice, 'output'),
    ].filter((m): m is string => m !== null)
  }

  async setMicEnabled(on: boolean): Promise<void> {
    this.micWanted = on
    if (!on) {
      // every live re-eval lands here for code with no mic; nothing to close
      // and the engine's map is already empty (it is set only with a capture)
      if (this.captures.length === 0) return
      for (const c of this.captures) {
        if (c === null) continue
        try { c.source.disconnect() } catch { /* already gone */ }
        for (const t of c.stream.getTracks()) t.stop()
      }
      this.captures = []
      this.send({ kind: 'setMicMap', map: {} })
      return
    }
    if (this.micOpen()) return // already live
    try {
      /* WHICH inputs. Slot 0 is the DEFAULT capture (what a bare mic() reads;
       * the options setting wins there); slots 1.. open one capture per
       * device the code names, in first-seen order — `resolveDevice` owns the
       * precedence in both cases. Labels are blank before the first
       * permission grant, so the very first open cannot match by name — it
       * takes defaults, and the next open (after `listDevices` can see
       * labels) resolves properly. */
      const { inputs } = await this.listDevices()
      /* RAW by default (phone voice-call DSP smears transients and would
       * colour a vocoder badly) — but on a phone the speaker is two
       * centimetres from the mic, and without echo cancellation a live chain
       * simply howls. resolveMicProcessing owns that choice. */
      const processing = resolveMicProcessing(this.micProcessing, this.micIsMobile)
      const wanted: (string | undefined)[] = [undefined, ...this.codeInputs]
      const opened: ({ stream: MediaStream; source: MediaStreamAudioSourceNode } | null)[] = []
      const map: Record<string, number> = {}
      for (let slot = 0; slot < wanted.length; slot++) {
        const name = wanted[slot]
        const choice = name === undefined
          ? resolveDevice(undefined, this.savedInput, inputs)
          : resolveDevice(name, undefined, inputs)
        if (slot === 0) this.lastInputChoice = choice
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              ...processing,
              ...(choice.deviceId !== undefined ? { deviceId: { exact: choice.deviceId } } : {}),
            },
          })
          // an eval may have turned mic OFF while a permission prompt was open
          if (!this.micWanted) {
            for (const t of stream.getTracks()) t.stop()
            for (const c of opened) {
              if (c === null) continue
              try { c.source.disconnect() } catch { /* already gone */ }
              for (const t of c.stream.getTracks()) t.stop()
            }
            return
          }
          const source = this.context.createMediaStreamSource(stream)
          source.connect(this.node, 0, slot)
          opened.push({ stream, source })
          if (name !== undefined) map[name] = slot
        } catch (e) {
          // one unavailable device must not cost the others their capture
          console.warn(`[mic] input ${name ?? '(default)'} unavailable`, e)
          opened.push(null)
        }
      }
      this.captures = opened
      // device-named mic kernels resolve through this map, per block
      this.send({ kind: 'setMicMap', map })
    } catch (e) {
      console.warn('[mic] unavailable (permission denied?)', e)
    }
  }

  /** Decode audio bytes at the engine's sample rate (mic recordings use this
   *  so their PCM lands exactly like file loads do). */
  decodeAudio(bytes: ArrayBuffer): Promise<AudioBuffer> {
    return this.context.decodeAudioData(bytes)
  }

  async loadSample(name: string, bytes: ArrayBuffer): Promise<number> {
    const buf = await this.context.decodeAudioData(bytes)
    const n = buf.length
    const mono = new Float32Array(n)
    const chans = buf.numberOfChannels
    for (let c = 0; c < chans; c++) {
      const ch = buf.getChannelData(c)
      for (let i = 0; i < n; i++) mono[i]! += ch[i]!
    }
    if (chans > 1) for (let i = 0; i < n; i++) mono[i]! /= chans
    const keep = mono.slice() // main-thread copy for preview (mono is transferred below)
    this.node.port.postMessage(
      { kind: 'loadSample', name, data: mono, sampleRate: buf.sampleRate } satisfies EngineMessage,
      [mono.buffer],
    )
    this._pcm.set(name, { data: keep, sampleRate: buf.sampleRate })
    this.recordSample(name, n, buf.sampleRate, false)
    return n
  }

  /** Load raw mono PCM directly (e.g. a procedurally generated buffer). Pass
   *  builtIn:true for the demo samples so the UI can label them. */
  loadSamplePcm(name: string, data: Float32Array, sampleRate: number, builtIn = false): void {
    const frames = data.length // read before postMessage transfers the buffer
    const keep = data.slice() // main-thread copy for preview (data is transferred below)
    this.node.port.postMessage(
      { kind: 'loadSample', name, data, sampleRate } satisfies EngineMessage,
      [data.buffer],
    )
    this._pcm.set(name, { data: keep, sampleRate })
    this.recordSample(name, frames, sampleRate, builtIn)
  }

  /** Every loaded sample's main-thread PCM (built-ins, files, and baked sing()
   *  clips), keyed by name — the sample bank an OFFLINE bounce needs so its
   *  sample('name') nodes play the same audio the live engine does. */
  get loadedSamples(): Record<string, { data: Float32Array; sampleRate: number }> {
    const out: Record<string, { data: Float32Array; sampleRate: number }> = {}
    for (const [name, pcm] of this._pcm) out[name] = pcm
    return out
  }

  /** Preview a loaded sample through the AudioContext (independent of the
   *  engine graph). Interrupts any current preview. No-op for unknown names. */
  previewSample(name: string): void {
    const pcm = this._pcm.get(name)
    if (!pcm) return
    this.stopPreview()
    const buf = this.context.createBuffer(1, pcm.data.length, pcm.sampleRate)
    buf.getChannelData(0).set(pcm.data)
    const src = this.context.createBufferSource()
    src.buffer = buf
    const gain = this.context.createGain()
    gain.gain.value = 0.9
    src.connect(gain).connect(this.context.destination)
    src.onended = () => {
      if (this._preview === src) this._preview = null
    }
    void this.context.resume()
    src.start()
    this._preview = src
  }

  // ---- live session recording (a PCM tap off the worklet output) ----
  private recNode: ScriptProcessorNode | null = null
  private recSink: GainNode | null = null
  private recL: Float32Array[] = []
  private recR: Float32Array[] = []
  private recStartSec = 0

  /** True while a live session recording is in progress. */
  get isRecording(): boolean {
    return this.recNode !== null
  }

  /** Seconds captured so far (0 when not recording). */
  get recordingSeconds(): number {
    return this.recNode ? this.context.currentTime - this.recStartSec : 0
  }

  /** Start capturing the live output to memory. A ScriptProcessor taps the
   *  worklet (in parallel with the main output) and accumulates stereo PCM;
   *  the sink is silent so this adds no audible path. */
  startRecording(): void {
    if (this.recNode) return
    const ctx = this.context
    const sp = ctx.createScriptProcessor(4096, 2, 2)
    this.recL = []
    this.recR = []
    sp.onaudioprocess = (e: AudioProcessingEvent): void => {
      const buf = e.inputBuffer
      const l = buf.getChannelData(0)
      const r = buf.numberOfChannels > 1 ? buf.getChannelData(1) : l
      this.recL.push(new Float32Array(l))
      this.recR.push(new Float32Array(r))
    }
    const sink = ctx.createGain()
    sink.gain.value = 0
    this.node.connect(sp)
    sp.connect(sink)
    sink.connect(ctx.destination)
    this.recNode = sp
    this.recSink = sink
    this.recStartSec = ctx.currentTime
    void ctx.resume()
  }

  /** Stop recording and return the captured stereo PCM (null if not recording). */
  stopRecording(): { left: Float32Array; right: Float32Array; sampleRate: number } | null {
    const sp = this.recNode
    if (!sp) return null
    sp.onaudioprocess = null
    try {
      this.node.disconnect(sp) // remove only the tap; the main path stays
    } catch {
      /* already gone */
    }
    sp.disconnect()
    this.recSink?.disconnect()
    this.recNode = null
    this.recSink = null
    const merge = (chunks: Float32Array[]): Float32Array => {
      const n = chunks.reduce((a, c) => a + c.length, 0)
      const out = new Float32Array(n)
      let o = 0
      for (const c of chunks) {
        out.set(c, o)
        o += c.length
      }
      return out
    }
    const res = { left: merge(this.recL), right: merge(this.recR), sampleRate: this.context.sampleRate }
    this.recL = []
    this.recR = []
    return res
  }

  /** Stop the current preview, if any. */
  stopPreview(): void {
    if (!this._preview) return
    try {
      this._preview.stop()
    } catch {
      /* already stopped */
    }
    this._preview = null
  }

  /** The samples loaded so far (a copy), built-ins first, then user files. */
  getSamples(): SampleInfo[] {
    return [...this._samples]
  }

  /** Subscribe to sample-list changes (load/remove). Returns an unsubscribe. */
  onSamplesChanged(fn: () => void): () => void {
    this.sampleListeners.add(fn)
    return () => this.sampleListeners.delete(fn)
  }

  /** Drop a loaded sample; synths referencing it fall back to silence. */
  removeSample(name: string): void {
    const i = this._samples.findIndex((s) => s.name === name)
    if (i === -1) return
    this.node.port.postMessage({ kind: 'clearSample', name } satisfies EngineMessage)
    this._samples.splice(i, 1)
    this._pcm.delete(name)
    this.notifySamples()
  }

  private recordSample(name: string, frames: number, sampleRate: number, builtIn: boolean): void {
    const info: SampleInfo = { name, frames, sampleRate, builtIn }
    const i = this._samples.findIndex((s) => s.name === name)
    if (i === -1) this._samples.push(info) // built-ins load first, so stay first
    else this._samples[i] = info // re-loading a name overwrites in place
    this.notifySamples()
  }

  private notifySamples(): void {
    for (const fn of this.sampleListeners) fn()
  }

  get sampleRate(): number {
    return this.context.sampleRate
  }

  /** The AudioContext clock in seconds — the same timeline SchedulerEvent.timeSec
   *  is stamped in, so the karaoke highlighter can locate the playhead in a cycle. */
  get currentTime(): number {
    return this.context.currentTime
  }

  /** Approximate host-side "now" in the engine's frame timeline (the worklet
   *  advances the authoritative clock; meters events carry its exact frame). */
  get currentTimeFrames(): number {
    return this.context.currentTime * this.context.sampleRate
  }

  suspend(): Promise<void> {
    return this.context.suspend()
  }

  resume(): Promise<void> {
    return this.context.resume()
  }
}
