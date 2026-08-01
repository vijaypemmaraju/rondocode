import type { SchedulerEvent } from '@rondocode/pattern'
import {
  follow, MAX_CHANNELS, VIZ_GLOBALS, VIZ_PARAM_FIELD, VIZ_PARAM_PREFIX, VIZ_SYNTH_GLOBALS, vizLayout,
} from './api'

/* ------------------------------------------------------------------------- *
 * Reusable WebGPU shader renderer — the engine behind the editor's visuals
 * AND the docs page's inline previews. It owns the GPU device, the shader
 * compile/swap, the audio→uniform packing and the rAF loop; the CALLER feeds
 * it data through opts (audio clock, analyser, sample rate) and drives it with
 * setVisual / pushEvents / setCps / setMeters / setParams / setActive. No
 * editor or DOM chrome here.
 *
 * The shader API is DECLARED IN ./api.ts, not here: this file derives the
 * struct, the globals, the fs() assigns and the uniform indices from that one
 * list. See the note at the top of api.ts for what went wrong when it didn't.
 * ------------------------------------------------------------------------- */

const SPEC_BINS = 1024
const WAVE_SAMPLES = 2048
/** Max per-synth channels, and max params — each an array<vec4f, 4>. */
const MAX_HITS = MAX_CHANNELS

const LAYOUT = vizLayout()
/** One vec4f array per per-synth global, plus one for the params. */
const CHAN_FIELDS = [...VIZ_SYNTH_GLOBALS.map((g) => g.field), VIZ_PARAM_FIELD]
/** Float index where each vec4f block starts. */
const BLOCK_AT: Record<string, number> = {}
CHAN_FIELDS.forEach((f, i) => { BLOCK_AT[f] = LAYOUT.base + i * MAX_CHANNELS })
const UNI_FLOATS = LAYOUT.base + CHAN_FIELDS.length * MAX_CHANNELS

/** A synth or param name → a valid WGSL identifier suffix. */
const sanitizeIdent = (name: string): string => {
  const id = name.replace(/[^A-Za-z0-9_]/g, '_')
  return /^[A-Za-z_]/.test(id) ? id : `_${id}`
}

/** Build the WGSL prelude for the current synth/param set: bindings, the audio
 *  API as module globals (one per VIZ_GLOBALS row, plus the per-synth and
 *  per-param ones), helpers, the fullscreen vertex stage, and an fs() that
 *  publishes uniforms into the globals then calls the user's render(uv).
 *
 *  Every part of this is derived from shaderviz/api.ts — see the note there on
 *  why the list is not written out again here. */
export function buildPrelude(synthNames: string[], paramNames: string[] = []): string {
  const decls: string[] = []
  const assigns: string[] = []
  /** Declare `<prefix><id>` for each name, reading from `field`'s vec4f array. */
  const channelBlock = (names: string[], prefix: string, field: string): void => {
    const seen = new Set<string>()
    names.slice(0, MAX_CHANNELS).forEach((name, i) => {
      const id = sanitizeIdent(name)
      if (seen.has(id)) return
      seen.add(id)
      decls.push(`var<private> ${prefix}${id}: f32;`)
      assigns.push(`  ${prefix}${id} = uni.${field}[${Math.floor(i / 4)}][${i % 4}];`)
    })
  }
  for (const g of VIZ_SYNTH_GLOBALS) channelBlock(synthNames, g.prefix, g.field)
  channelBlock(paramNames, VIZ_PARAM_PREFIX, VIZ_PARAM_FIELD)
  return `
struct U {
${LAYOUT.fields.join('\n')}
${CHAN_FIELDS.map((f) => `  ${f}: array<vec4f, ${MAX_CHANNELS / 4}>,`).join('\n')}
};
@group(0) @binding(0) var<uniform> uni: U;
@group(0) @binding(1) var specTex: texture_2d<f32>;
@group(0) @binding(2) var waveTex: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;

${VIZ_GLOBALS.map((g) => `var<private> ${g.name}: ${g.type};`).join('\n')}
${decls.join('\n')}

fn spectrum(x: f32) -> f32 { return textureSampleLevel(specTex, samp, vec2f(clamp(x, 0.0, 1.0), 0.5), 0.0).r; }
fn waveform(x: f32) -> f32 { return textureSampleLevel(waveTex, samp, vec2f(clamp(x, 0.0, 1.0), 0.5), 0.0).r * 2.0 - 1.0; }

struct VSOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VSOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VSOut;
  let xy = p[i];
  o.pos = vec4f(xy, 0.0, 1.0);
  o.uv = vec2f((xy.x + 1.0) * 0.5, (xy.y + 1.0) * 0.5);
  return o;
}

@fragment fn fs(in: VSOut) -> @location(0) vec4f {
${VIZ_GLOBALS.map((g) => `  ${g.name} = uni.${g.name};`).join('\n')}
${assigns.join('\n')}
  let c = render(in.uv);
  return vec4f(c.rgb, 1.0);
}
`
}

/** Shown when the program has no visual() yet — reactive out of the box. */
export const DEFAULT_FRAG = /* wgsl */ `fn render(uv: vec2f) -> vec4f {
  let p = uv * 2.0 - 1.0;
  let r = length(p);
  let ang = atan2(p.y, p.x) / 6.2831853 + 0.5;
  let s = spectrum(fract(ang));
  let radius = 0.34 + s * 0.42 + beat * 0.12;
  let ring = smoothstep(0.03, 0.0, abs(r - radius));
  let w = waveform(uv.x);
  let line = smoothstep(0.025, 0.0, abs(p.y - w * 0.6));
  let glow = level * 0.5 / (r * 2.2 + 0.25);
  let base = vec3f(0.15 + treble * 0.9, 0.55 + mid * 0.6, 0.75 + bass * 0.5);
  let col = base * (ring + line) + vec3f(0.06, 0.85, 0.6) * glow;
  return vec4f(col, 1.0);
}`

export interface ShaderRenderer {
  /** Swap the user fragment (null = the built-in reactive default) + the synth
   *  set that maps to hit_<name> channels. */
  setVisual(wgsl: string | null, synths: string[]): void
  /** Feed scheduler events: note onsets drive the per-synth hit/note/velocity
   *  globals, and each event's own cycle number anchors `cycle`. */
  pushEvents(evs: SchedulerEvent[]): void
  setCps(cps: number): void
  /** Transport running or not (also re-bases `cycle` on a fresh start). */
  setPlaying(playing: boolean): void
  /** Engine meters: per-synth RMS, and the sidechain/mic levels when present. */
  setMeters(m: { channels: Record<string, number>; duck?: number; mic?: number }): void
  /** Live macro / knob / switch values, by name. A changed SET of names
   *  rebuilds the shader (each one is a named global); changed values do not. */
  setParams(values: Record<string, number>): void
  /** Pointer position in uv space (0..1, y up). */
  setPointer(x: number, y: number): void
  /** Fire the `click` envelope. */
  pressPointer(): void
  /** Turn rendering on/off (lazily boots the GPU on first activation). */
  setActive(on: boolean): void
  /** Frame pacing over the last ~2 s, for the `?fps=1` readout. `cpuMs` is
   *  the time this loop itself spends; a gap between that and the frame
   *  interval is someone else on the main thread, or the GPU. */
  stats(): { fps: number; p95Ms: number; worstMs: number; cpuMs: number; drops: number }
  dispose(): void
}

export interface ShaderRendererOpts {
  /** AUDIO clock in seconds: the timeline SchedulerEvent.timeSec is stamped
   *  in. Drives onset dispatch, `phase` and `cycle`. Animation does NOT use
   *  it — see the two-clock note in the frame loop. */
  now: () => number
  /** The analyser to read spectrum/waveform from (null → time-only visuals). */
  analyser: () => AnalyserNode | null
  /** Per-side taps for `left`/`right`/`width`. Optional: an AnalyserNode
   *  downmixes to mono, so without a split these three cannot be measured and
   *  report level/level/0 rather than something invented. */
  analyserL?: () => AnalyserNode | null
  analyserR?: () => AnalyserNode | null
  /** Engine sample rate (for the analyser's bin→Hz mapping). */
  sampleRate: () => number
  /** Surface a shader/GPU error (a string) or clear it (null). */
  onError?: (msg: string | null) => void
  /** Background clear colour (default near-black green). */
  clearColor?: { r: number; g: number; b: number; a: number }
}

/** Create a renderer bound to `canvas`. The canvas is sized to its own CSS box
 *  × devicePixelRatio each frame (fullscreen or contained both work). */
export function createShaderRenderer(canvas: HTMLCanvasElement, opts: ShaderRendererOpts): ShaderRenderer {
  const clear = opts.clearColor ?? { r: 0.02, g: 0.03, b: 0.028, a: 1 }
  const err = (m: string | null): void => opts.onError?.(m)

  let on = false
  let disposed = false
  let raf = 0

  const specData = new Uint8Array(SPEC_BINS)
  const waveData = new Uint8Array(WAVE_SAMPLES)
  // analyser scratch, (re)allocated only when the analyser's sizes change
  let freqBytes = new Uint8Array(0)
  let waveFloats = new Float32Array(0)

  const pending: { at: number; amp: number; name: string; note: number; cycle: number }[] = []
  const hitEnvs = new Map<string, number>()
  /** Last note + velocity seen per synth, held until the next one. */
  const lastNote = new Map<string, number>()
  const lastVel = new Map<string, number>()
  /* Meter values are eased toward their targets rather than written through:
   * see `follow` in ./api.ts for why, and why it is asymmetric. */
  /** Raw targets from the engine, and the smoothed values actually uploaded. */
  let chanTarget: Record<string, number> = {}
  const chanLevels = new Map<string, number>()
  let duckTarget = 1
  let duckLevel = 1
  let micTarget = 0
  let micLevel = 0
  /** Live macro/knob/switch values (see setParams). */
  let paramValues: Record<string, number> = {}
  let paramNames: string[] = []
  /** Previous frame's spectrum, for flux. */
  let prevSpec = new Float32Array(0)
  /** Per-side scratch for the stereo taps, (re)allocated only on a size change. */
  const sides = { l: new Float32Array(0), r: new Float32Array(0) }
  /** RMS of one analyser's time-domain window, scaled so a normal mix sits
   *  mid-range rather than hugging zero. */
  const rmsOf = (a: AnalyserNode, which: 'l' | 'r'): number => {
    if (sides[which].length !== a.fftSize) sides[which] = new Float32Array(a.fftSize)
    const buf = sides[which]
    a.getFloatTimeDomainData(buf)
    let s = 0
    for (let i = 0; i < buf.length; i++) s += buf[i]! * buf[i]!
    return Math.min(1, Math.sqrt(s / Math.max(1, buf.length)) * 3)
  }
  /** Transport: the cycle of the most recent event, advanced by the clock
   *  between events so the value moves smoothly rather than in steps. */
  let cycleAt = 0
  let cycleAtT = 0
  let playing = false
  const pointer = { x: 0.5, y: 0.5 }
  let clickEnv = 0
  let channelOf = new Map<string, number>()
  let beatEnv = 0
  let cps = 0.5

  let device: GPUDevice | null = null
  let ctx: GPUCanvasContext | null = null
  let format: GPUTextureFormat = 'bgra8unorm'
  let uniformBuf: GPUBuffer | null = null
  let specTex: GPUTexture | null = null
  let waveTex: GPUTexture | null = null
  let sampler: GPUSampler | null = null
  // Explicit bind-group layout (NOT layout:'auto'): a user shader that doesn't
  // sample waveform (binding 2) or spectrum (binding 1) would otherwise make
  // the auto-derived layout prune that binding, and createBindGroup — which
  // always binds all four — would throw "binding index N not present", leaving
  // an invalid bind group and a black canvas. A fixed layout keeps all four.
  let bindLayout: GPUBindGroupLayout | null = null
  let pipeLayout: GPUPipelineLayout | null = null
  let pipeline: GPURenderPipeline | null = null
  let bindGroup: GPUBindGroup | null = null
  const uni = new Float32Array(UNI_FLOATS)
  let currentCode = ''
  let wantFrag = DEFAULT_FRAG
  let wantSynths: string[] = []

  const buildPipeline = async (userFrag: string, synthNames: string[]): Promise<void> => {
    if (!device || !ctx) return
    const code = `${buildPrelude(synthNames, paramNames)}\n${userFrag}`
    if (code === currentCode && pipeline) return
    device.pushErrorScope('validation')
    let module: GPUShaderModule
    try {
      module = device.createShaderModule({ code })
    } catch (e) {
      void device.popErrorScope()
      err(`shader error: ${e instanceof Error ? e.message : String(e)}`)
      return
    }
    const info = await module.getCompilationInfo()
    const errs = info.messages.filter((m) => m.type === 'error')
    if (errs.length > 0) {
      const first = errs[0]!
      err(`WGSL error (line ${first.lineNum}): ${first.message}`)
      void device.popErrorScope()
      return
    }
    let next: GPURenderPipeline
    try {
      next = device.createRenderPipeline({
        layout: pipeLayout!,
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
      })
    } catch (e) {
      void device.popErrorScope()
      err(`shader error: ${e instanceof Error ? e.message : String(e)}`)
      return
    }
    const scoped = await device.popErrorScope()
    if (scoped) {
      err(`shader error: ${scoped.message}`)
      return
    }
    pipeline = next
    bindGroup = device.createBindGroup({
      layout: bindLayout!,
      entries: [
        { binding: 0, resource: { buffer: uniformBuf! } },
        { binding: 1, resource: specTex!.createView() },
        { binding: 2, resource: waveTex!.createView() },
        { binding: 3, resource: sampler! },
      ],
    })
    currentCode = code
    err(null)
  }

  /* THE CANVAS BOX IS OBSERVED, NOT MEASURED PER FRAME.
   *
   * `canvas.clientWidth` is a layout read, and reading layout inside the rAF
   * callback forces the browser to flush style and layout right there. On a
   * bare page that is free. With the editor's widgets on screen — piano rolls
   * and envelope editors, each running its own rAF that mutates DOM — layout
   * is dirty every frame, so this read paid for a full recalculation of all of
   * it, once per frame, before a single pixel was drawn. That is why the
   * visuals only went choppy when widgets were visible.
   *
   * A ResizeObserver delivers the same numbers with no read at all. */
  let boxW = 0
  let boxH = 0
  const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver((entries) => {
    const e = entries[0]
    if (e === undefined) return
    const cr = e.contentRect
    boxW = cr.width
    boxH = cr.height
  })
  ro?.observe(canvas)

  const resize = (): void => {
    if (!ctx || !device) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    // the observer has not fired yet on the very first frame, and a canvas
    // with no observer support falls back to the viewport
    const cssW = boxW || window.innerWidth
    const cssH = boxH || window.innerHeight
    const w = Math.max(1, Math.floor(cssW * dpr))
    const h = Math.max(1, Math.floor(cssH * dpr))
    if (canvas.width === w && canvas.height === h) return
    canvas.width = w
    canvas.height = h
  }

  let prevT = 0
  let prevRaw = 0
  /* Frame pacing, for `?fps=1`. Kept always-on and allocation-free: two small
   * ring buffers. Without this the only way to describe a stutter is with an
   * adjective, and three separate "fixes" went in against adjectives. */
  const RING = 120
  const gaps = new Float32Array(RING)
  const cpus = new Float32Array(RING)
  let ringAt = 0
  let ringLen = 0
  const frame = (): void => {
    raf = 0
    const cpu0 = performance.now()
    if (disposed || !on || !device || !ctx || !pipeline || !bindGroup || !uniformBuf) return
    resize()

    const analyser = opts.analyser()
    const sampleRate = opts.sampleRate()
    let level = 0
    let bass = 0
    let mid = 0
    let treble = 0
    let centroid = 0
    let flux = 0
    let peak = 0
    let crest = 0
    if (analyser) {
      if (freqBytes.length !== analyser.frequencyBinCount) freqBytes = new Uint8Array(analyser.frequencyBinCount)
      if (waveFloats.length !== analyser.fftSize) waveFloats = new Float32Array(analyser.fftSize)
      analyser.getByteFrequencyData(freqBytes)
      for (let i = 0; i < SPEC_BINS; i++) {
        specData[i] = freqBytes[Math.min(freqBytes.length - 1, Math.floor((i * freqBytes.length) / SPEC_BINS))]!
      }
      analyser.getFloatTimeDomainData(waveFloats)
      for (let i = 0; i < WAVE_SAMPLES; i++) {
        const v = waveFloats[Math.min(waveFloats.length - 1, Math.floor((i * waveFloats.length) / WAVE_SAMPLES))]!
        waveData[i] = Math.max(0, Math.min(255, Math.round((v * 0.5 + 0.5) * 255)))
      }
      const binOf = (hz: number): number => Math.min(freqBytes.length - 1, Math.round(hz / (sampleRate / analyser.fftSize)))
      const avg = (lo: number, hi: number): number => {
        let s = 0
        for (let i = lo; i <= hi; i++) s += freqBytes[i]!
        return s / (hi - lo + 1) / 255
      }
      bass = avg(binOf(30), binOf(200))
      mid = avg(binOf(200), binOf(2000))
      treble = avg(binOf(2000), binOf(12000))
      level = avg(0, freqBytes.length - 1)

      // CENTROID: the energy-weighted mean bin, as a fraction of the band.
      // Normalized against a 12 kHz ceiling rather than nyquist, because
      // almost nothing musical lives above it and dividing by 24 kHz squashes
      // every real patch into the bottom quarter of the range.
      let wsum = 0
      let msum = 0
      const top = binOf(12000)
      for (let i = 0; i <= top; i++) {
        const m = freqBytes[i]! / 255
        wsum += m * i
        msum += m
      }
      centroid = msum > 1e-6 ? Math.min(1, wsum / msum / Math.max(1, top)) : 0

      // FLUX: summed POSITIVE change since the last frame. Rising energy only
      // — falling energy is a note ending, which is not an onset, and counting
      // it makes every release read as a hit.
      if (prevSpec.length !== freqBytes.length) prevSpec = new Float32Array(freqBytes.length)
      let f = 0
      for (let i = 0; i < freqBytes.length; i++) {
        const m = freqBytes[i]! / 255
        const d = m - prevSpec[i]!
        if (d > 0) f += d
        prevSpec[i] = m
      }
      flux = Math.min(1, f / 24)

      // PEAK and CREST from the time-domain window we already pulled.
      let pk = 0
      let sq = 0
      for (let i = 0; i < waveFloats.length; i++) {
        const v = waveFloats[i]!
        const a = Math.abs(v)
        if (a > pk) pk = a
        sq += v * v
      }
      const rms = Math.sqrt(sq / Math.max(1, waveFloats.length))
      peak = Math.min(1, pk)
      // 1 when a square wave, large when spiky. /8 puts a typical mix near the
      // middle of 0..1 rather than pinned at either end.
      crest = rms > 1e-5 ? Math.min(1, pk / rms / 8) : 0
      device.queue.writeTexture({ texture: specTex! }, specData, { bytesPerRow: SPEC_BINS }, { width: SPEC_BINS, height: 1 })
      device.queue.writeTexture({ texture: waveTex! }, waveData, { bytesPerRow: WAVE_SAMPLES }, { width: WAVE_SAMPLES, height: 1 })
    }

    /* TWO CLOCKS, and conflating them is what made everything move in steps.
     *
     * `opts.now()` is AudioContext.currentTime, which only advances when the
     * audio thread hands the main thread a new render quantum. Read once per
     * frame it does not tick evenly: some frames see the same value as the
     * last (dt = 0) and the next sees a double step. Every decay and every
     * eased meter is scaled by dt, so they froze for a frame and then jumped —
     * animation running in bursts, however smooth the underlying value was.
     *
     * So: the AUDIO clock still decides WHEN a note lands and where the cycle
     * counter is anchored, because events are stamped in that timeline and
     * nothing else would stay in sync. The WALL clock drives everything that
     * merely has to look continuous — `time`, `dt`, the envelope decays, the
     * meter easing. `phase` and `cycle` remain audio-locked, which is what a
     * shader should be using for anything that must land with the music. */
    const tAudio = opts.now()
    const tWall = performance.now() / 1000
    // clamped: a backgrounded tab returns after seconds, and one frame with
    // dt = 4 would snap every envelope to its target at once
    const dt = prevT === 0 ? 0.016 : Math.min(0.1, Math.max(0.0005, tWall - prevT))
    prevT = tWall
    const t = tWall
    while (pending.length > 0 && pending[0]!.at <= tAudio) {
      const o = pending.shift()!
      hitEnvs.set(o.name, Math.max(hitEnvs.get(o.name) ?? 0, o.amp))
      if (Number.isFinite(o.note)) lastNote.set(o.name, o.note)
      lastVel.set(o.name, o.amp)
      // the scheduler's own cycle number, re-based to this moment
      if (o.cycle >= 0) { cycleAt = o.cycle; cycleAtT = o.at }
    }
    const decay = Math.exp(-dt / 0.12)
    let hitMax = 0
    for (const f of CHAN_FIELDS) {
      const at = BLOCK_AT[f]!
      for (let i = 0; i < MAX_CHANNELS; i++) uni[at + i] = 0
    }
    const hitAt = BLOCK_AT['hits']!
    for (const [name, v] of hitEnvs) {
      const nv = v * decay
      hitEnvs.set(name, nv)
      if (nv > hitMax) hitMax = nv
      const ch = channelOf.get(name)
      if (ch !== undefined) uni[hitAt + ch] = nv
    }
    // per-synth level (eased toward the meter), note and velocity (held)
    const lvlAt = BLOCK_AT['lvls']!
    const noteAt = BLOCK_AT['notes']!
    const velAt = BLOCK_AT['vels']!
    for (const [name, ch] of channelOf) {
      const lv = follow(chanLevels.get(name) ?? 0, chanTarget[name] ?? 0, dt, 22, 110)
      chanLevels.set(name, lv)
      uni[lvlAt + ch] = lv
      uni[noteAt + ch] = lastNote.get(name) ?? 0
      uni[velAt + ch] = lastVel.get(name) ?? 0
    }
    // the duck's snap DOWN is the punch, so it is followed almost immediately
    // and only the release is eased
    duckLevel = follow(duckLevel, duckTarget, dt, 45, 3)
    micLevel = follow(micLevel, micTarget, dt, 22, 110)
    // macros / knobs / switches, in their own units
    const ctlAt = BLOCK_AT[VIZ_PARAM_FIELD]!
    for (let i = 0; i < paramNames.length && i < MAX_CHANNELS; i++) {
      uni[ctlAt + i] = paramValues[paramNames[i]!] ?? 0
    }
    beatEnv = Math.max(beatEnv * Math.exp(-dt / 0.18), bass)
    clickEnv *= Math.exp(-dt / 0.12)
    const phase = cps > 0 ? (tAudio * cps) % 1 : 0
    // CYCLE: anchored to the last scheduled event's own cycle number and
    // advanced by the clock in between, so it tracks the TRANSPORT rather than
    // wall time. Deriving it from time*cps alone drifts across a stop/start,
    // which is what every arrangement-aware visual had to do before this.
    const cycleNow = playing ? cycleAt + Math.max(0, (tAudio - cycleAtT) * cps) : cycleAt

    // STEREO. One analyser downmixes to mono, so left/right need their own
    // taps; without them these stay equal and width reads 0 rather than lying.
    let chanL = level
    let chanR = level
    let width = 0
    const aL = opts.analyserL?.()
    const aR = opts.analyserR?.()
    if (aL && aR) {
      chanL = rmsOf(aL, 'l')
      chanR = rmsOf(aR, 'r')
      const sum = chanL + chanR
      width = sum > 1e-5 ? Math.min(1, Math.abs(chanL - chanR) / sum * 2) : 0
    }

    const X = LAYOUT.index
    uni[X['res']!] = canvas.width
    uni[X['res']! + 1] = canvas.height
    uni[X['pointer']!] = pointer.x
    uni[X['pointer']! + 1] = pointer.y
    uni[X['time']!] = t
    uni[X['dt']!] = dt
    uni[X['cps']!] = cps
    uni[X['phase']!] = phase
    uni[X['cycle']!] = cycleNow
    uni[X['playing']!] = playing ? 1 : 0
    uni[X['level']!] = level
    uni[X['bass']!] = bass
    uni[X['mid']!] = mid
    uni[X['treble']!] = treble
    uni[X['centroid']!] = centroid
    uni[X['flux']!] = flux
    uni[X['peak']!] = peak
    uni[X['crest']!] = crest
    uni[X['left']!] = chanL
    uni[X['right']!] = chanR
    uni[X['width']!] = width
    uni[X['duck']!] = duckLevel
    uni[X['mic']!] = micLevel
    uni[X['beat']!] = beatEnv
    uni[X['hit']!] = hitMax
    uni[X['click']!] = clickEnv
    device.queue.writeBuffer(uniformBuf, 0, uni)

    const encoder = device.createCommandEncoder()
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        { view: ctx.getCurrentTexture().createView(), clearValue: clear, loadOp: 'clear', storeOp: 'store' },
      ],
    })
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, bindGroup)
    pass.draw(3)
    pass.end()
    device.queue.submit([encoder.finish()])

    // the RAW gap, not the clamped dt: recording dt made `worst` top out at
    // exactly the 100 ms clamp and hid how bad a stall really was
    gaps[ringAt] = prevRaw === 0 ? dt * 1000 : (tWall - prevRaw) * 1000
    cpus[ringAt] = performance.now() - cpu0
    prevRaw = tWall
    ringAt = (ringAt + 1) % RING
    if (ringLen < RING) ringLen++
    raf = requestAnimationFrame(frame)
  }

  const start = (): void => {
    if (raf === 0 && on && !disposed) raf = requestAnimationFrame(frame)
  }

  const initGpu = async (): Promise<boolean> => {
    if (!('gpu' in navigator) || !navigator.gpu) return false
    const adapter = await navigator.gpu.requestAdapter()
    if (!adapter) return false
    device = await adapter.requestDevice()
    device.lost.then((info) => {
      if (!disposed) err(`GPU device lost: ${info.message}`)
    })
    const gpuCtx = canvas.getContext('webgpu')
    if (!gpuCtx) return false
    ctx = gpuCtx
    format = navigator.gpu.getPreferredCanvasFormat()
    ctx.configure({ device, format, alphaMode: 'opaque' })
    uniformBuf = device.createBuffer({ size: uni.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    const mkTex = (w: number): GPUTexture =>
      device!.createTexture({
        size: { width: w, height: 1 },
        format: 'r8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      })
    specTex = mkTex(SPEC_BINS)
    waveTex = mkTex(WAVE_SAMPLES)
    sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge' })
    bindLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    })
    pipeLayout = device.createPipelineLayout({ bindGroupLayouts: [bindLayout] })
    await buildPipeline(wantFrag, wantSynths)
    return true
  }

  let gpuReady: Promise<boolean> | null = null

  const onResize = (): void => resize()
  window.addEventListener('resize', onResize)

  return {
    setVisual(wgsl, synths): void {
      wantFrag = wgsl ?? DEFAULT_FRAG
      wantSynths = synths
      channelOf = new Map(synths.slice(0, MAX_HITS).map((n, i) => [n, i]))
      if (device) void buildPipeline(wantFrag, wantSynths)
    },
    pushEvents(evs): void {
      for (const ev of evs) {
        const name = typeof ev.controls.sound === 'string' ? ev.controls.sound : ''
        const amp = typeof ev.controls.gain === 'number' ? ev.controls.gain : 1
        const note = typeof ev.controls.note === 'number' ? ev.controls.note : NaN
        const cycle = typeof ev.cycle === 'number' ? ev.cycle : -1
        if (name !== '') pending.push({ at: ev.timeSec, amp, name, note, cycle })
      }
      if (pending.length > 512) pending.splice(0, pending.length - 512)
    },
    setCps(v): void {
      cps = v
    },
    setPlaying(v): void {
      // a fresh start re-bases the cycle counter; without this, stopping and
      // playing again leaves `cycle` wherever the last run left it
      if (v && !playing) { cycleAt = 0; cycleAtT = opts.now() }
      playing = v
    },
    setMeters(m): void {
      // targets only: the frame loop eases toward these (see `follow`)
      chanTarget = m.channels
      duckTarget = m.duck ?? 1
      micTarget = m.mic ?? 0
    },
    setPointer(x, y): void {
      pointer.x = x
      pointer.y = y
    },
    pressPointer(): void {
      clickEnv = 1
    },
    setParams(values): void {
      paramValues = values
      const names = Object.keys(values).sort()
      // the prelude names each ctl_ global, so a CHANGED SET needs a rebuild;
      // the same set with new values does not
      if (names.length !== paramNames.length || names.some((n, i) => n !== paramNames[i])) {
        paramNames = names
        if (device) void buildPipeline(wantFrag, wantSynths)
      }
    },
    stats(): { fps: number; p95Ms: number; worstMs: number; cpuMs: number; drops: number } {
      if (ringLen === 0) return { fps: 0, p95Ms: 0, worstMs: 0, cpuMs: 0, drops: 0 }
      const g = Array.from(gaps.subarray(0, ringLen)).sort((a, b) => a - b)
      const mean = g.reduce((a, b) => a + b, 0) / g.length
      const cpu = Array.from(cpus.subarray(0, ringLen)).reduce((a, b) => a + b, 0) / ringLen
      const r1 = (x: number): number => Math.round(x * 10) / 10
      return {
        fps: r1(1000 / Math.max(0.001, mean)),
        p95Ms: r1(g[Math.min(g.length - 1, Math.floor(g.length * 0.95))]!),
        worstMs: r1(g[g.length - 1]!),
        cpuMs: Math.round(cpu * 100) / 100,
        // anything over 1.5x a 60 Hz frame is a dropped frame by any reading
        drops: g.filter((x) => x > 25).length,
      }
    },
    setActive(v): void {
      on = v
      if (v) {
        if (!gpuReady) {
          gpuReady = initGpu()
          void gpuReady.then((ok) => {
            if (!ok) {
              err('WebGPU not supported in this browser')
              return
            }
            start()
          })
        } else {
          void gpuReady.then((ok) => ok && start())
        }
      } else {
        if (raf) cancelAnimationFrame(raf)
        raf = 0
      }
    },
    dispose(): void {
      disposed = true
      if (raf) cancelAnimationFrame(raf)
      ro?.disconnect()
      window.removeEventListener('resize', onResize)
      device?.destroy?.()
    },
  }
}
