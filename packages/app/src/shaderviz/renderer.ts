import type { SchedulerEvent } from '@rondocode/pattern'

/* ------------------------------------------------------------------------- *
 * Reusable WebGPU shader renderer — the engine behind the editor's visuals
 * AND the docs page's inline previews. It owns the GPU device, the shader
 * compile/swap, the audio→uniform packing and the rAF loop; the CALLER feeds
 * it data through opts (audio clock, analyser, sample rate) and drives it with
 * setVisual / pushEvents / setCps / setActive. No editor or DOM chrome here.
 *
 * The shader API (see buildPrelude): module globals time/res/level/bass/mid/
 * treble/cps/phase/hit/beat, spectrum(x)/waveform(x) samplers, and a hit_<synth>
 * envelope per synth in the program.
 * ------------------------------------------------------------------------- */

const SPEC_BINS = 1024
const WAVE_SAMPLES = 2048
/** Max per-synth hit channels (packed as array<vec4f, 4> in the uniform). */
const MAX_HITS = 16
/** Float32 uniform layout: 12 scalars + 16 hit channels = 28 floats (112 B). */
const UNI_FLOATS = 12 + MAX_HITS
const HIT_BASE = 12 // float index where the hit channels start

/** A synth name → a valid WGSL identifier for its hit_<id> global. */
const sanitizeIdent = (name: string): string => {
  const id = name.replace(/[^A-Za-z0-9_]/g, '_')
  return /^[A-Za-z_]/.test(id) ? id : `_${id}`
}

/** Build the WGSL prelude for the current synth set: bindings, the audio API
 *  as module globals (incl. one hit_<name> per synth), helpers, the fullscreen
 *  vertex stage, and an fs() that publishes uniforms into the globals then
 *  calls the user's render(uv). */
function buildPrelude(synthNames: string[]): string {
  const seen = new Set<string>()
  const decls: string[] = []
  const assigns: string[] = []
  synthNames.slice(0, MAX_HITS).forEach((name, i) => {
    const id = sanitizeIdent(name)
    if (seen.has(id)) return
    seen.add(id)
    decls.push(`var<private> hit_${id}: f32;`)
    assigns.push(`  hit_${id} = uni.hits[${Math.floor(i / 4)}][${i % 4}];`)
  })
  return `
struct U {
  res: vec2f, time: f32, dt: f32,
  level: f32, bass: f32, mid: f32, treble: f32,
  cps: f32, phase: f32, hit: f32, beat: f32,
  hits: array<vec4f, 4>,
};
@group(0) @binding(0) var<uniform> uni: U;
@group(0) @binding(1) var specTex: texture_2d<f32>;
@group(0) @binding(2) var waveTex: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;

var<private> time: f32;
var<private> res: vec2f;
var<private> level: f32;
var<private> bass: f32;
var<private> mid: f32;
var<private> treble: f32;
var<private> cps: f32;
var<private> phase: f32;
var<private> hit: f32;
var<private> beat: f32;
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
  time = uni.time; res = uni.res; level = uni.level; bass = uni.bass;
  mid = uni.mid; treble = uni.treble; cps = uni.cps; phase = uni.phase;
  hit = uni.hit; beat = uni.beat;
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
  /** Feed scheduler events so note onsets drive per-synth hit envelopes. */
  pushEvents(evs: SchedulerEvent[]): void
  setCps(cps: number): void
  /** Turn rendering on/off (lazily boots the GPU on first activation). */
  setActive(on: boolean): void
  dispose(): void
}

export interface ShaderRendererOpts {
  /** Audio clock in seconds (drives time + onset scheduling). */
  now: () => number
  /** The analyser to read spectrum/waveform from (null → time-only visuals). */
  analyser: () => AnalyserNode | null
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

  const pending: { at: number; amp: number; name: string }[] = []
  const hitEnvs = new Map<string, number>()
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
    const code = `${buildPrelude(synthNames)}\n${userFrag}`
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

  const resize = (): void => {
    if (!ctx || !device) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const cssW = canvas.clientWidth || window.innerWidth
    const cssH = canvas.clientHeight || window.innerHeight
    const w = Math.max(1, Math.floor(cssW * dpr))
    const h = Math.max(1, Math.floor(cssH * dpr))
    if (canvas.width === w && canvas.height === h) return
    canvas.width = w
    canvas.height = h
  }

  let prevT = 0
  const frame = (): void => {
    raf = 0
    if (disposed || !on || !device || !ctx || !pipeline || !bindGroup || !uniformBuf) return
    resize()

    const analyser = opts.analyser()
    const sampleRate = opts.sampleRate()
    let level = 0
    let bass = 0
    let mid = 0
    let treble = 0
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
      device.queue.writeTexture({ texture: specTex! }, specData, { bytesPerRow: SPEC_BINS }, { width: SPEC_BINS, height: 1 })
      device.queue.writeTexture({ texture: waveTex! }, waveData, { bytesPerRow: WAVE_SAMPLES }, { width: WAVE_SAMPLES, height: 1 })
    }

    const t = opts.now()
    const dt = prevT === 0 ? 0.016 : Math.max(0, t - prevT)
    prevT = t
    while (pending.length > 0 && pending[0]!.at <= t) {
      const o = pending.shift()!
      hitEnvs.set(o.name, Math.max(hitEnvs.get(o.name) ?? 0, o.amp))
    }
    const decay = Math.exp(-dt / 0.12)
    let hitMax = 0
    for (let i = 0; i < MAX_HITS; i++) uni[HIT_BASE + i] = 0
    for (const [name, v] of hitEnvs) {
      const nv = v * decay
      hitEnvs.set(name, nv)
      if (nv > hitMax) hitMax = nv
      const ch = channelOf.get(name)
      if (ch !== undefined) uni[HIT_BASE + ch] = nv
    }
    beatEnv = Math.max(beatEnv * Math.exp(-dt / 0.18), bass)
    const phase = cps > 0 ? (t * cps) % 1 : 0

    uni[0] = canvas.width
    uni[1] = canvas.height
    uni[2] = t
    uni[3] = dt
    uni[4] = level
    uni[5] = bass
    uni[6] = mid
    uni[7] = treble
    uni[8] = cps
    uni[9] = phase
    uni[10] = hitMax
    uni[11] = beatEnv
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
        if (name !== '') pending.push({ at: ev.timeSec, amp, name })
      }
      if (pending.length > 512) pending.splice(0, pending.length - 512)
    },
    setCps(v): void {
      cps = v
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
      window.removeEventListener('resize', onResize)
      device?.destroy?.()
    },
  }
}
