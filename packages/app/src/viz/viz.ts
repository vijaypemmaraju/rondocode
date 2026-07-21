import type { AudioSession } from '../audio/AudioSession'
import type { EditorHandle } from '../editor/editor'
import { C_ACCENT, C_ACCENT_ALT } from '../ui/palette'
import { icon } from '../ui/icons'
import { tooltip } from '../ui/tooltip'
import { createMixer } from './mixer'
import { detectBuses } from '../editor/buses'

/* ------------------------------------------------------------------------- *
 * Viz panel: a collapsible strip between the editor and the transport bar
 * holding an oscilloscope, a log-frequency spectrum, and the mixer strip
 * (mixer.ts). A "viz" toggle lives in the topbar; the panel defaults OPEN
 * on >=600px viewports and CLOSED below (phones: editor space wins).
 *
 * Audio data comes from AudioSession.analyser — which is null when the
 * analyser tap could not be built (fail-open, see AudioSession). Null
 * analyser means blank canvases; the mixer still works.
 *
 * The scope/spectrum render loop runs ONLY while the panel is open AND the
 * transport is playing (state fanout via editor.onState) — closed or
 * stopped, no rAF is scheduled at all. Channel meters are painted directly
 * from meters events (~27ms cadence, a few style writes) while the panel is
 * open, so they correctly decay to zero after stop.
 * ------------------------------------------------------------------------- */

export const VIZ_OPEN_MIN_WIDTH = 600
export const SPECTRUM_MIN_HZ = 40
export const SPECTRUM_MAX_HZ = 16000

// ---- pure helpers (unit tested) -----------------------------------------

/** CSS px → device px for a crisp canvas backing store (min 1). */
export const dprSize = (cssPx: number, dpr: number): number => Math.max(1, Math.round(cssPx * dpr))

/** Log-frequency bar index for `freq` (0..bars-1, clamped): every bar spans
 *  the same RATIO of frequencies, so octaves get equal width. */
export const freqToBar = (
  freq: number,
  bars: number,
  minHz: number = SPECTRUM_MIN_HZ,
  maxHz: number = SPECTRUM_MAX_HZ,
): number => {
  if (bars <= 0) return 0
  const t = Math.log(freq / minHz) / Math.log(maxHz / minHz)
  return Math.min(bars - 1, Math.max(0, Math.floor(t * bars)))
}

/** FFT bin span [lo, hi) feeding bar `bar`. Always non-empty (hi > lo): low
 *  bars whose log slice is narrower than one bin still get their nearest
 *  bin instead of vanishing. */
export const barBinRange = (
  bar: number,
  bars: number,
  binCount: number,
  binHz: number,
  minHz: number = SPECTRUM_MIN_HZ,
  maxHz: number = SPECTRUM_MAX_HZ,
): [number, number] => {
  const ratio = maxHz / minHz
  const f0 = minHz * Math.pow(ratio, bar / bars)
  const f1 = minHz * Math.pow(ratio, (bar + 1) / bars)
  const lo = Math.min(binCount - 1, Math.max(0, Math.floor(f0 / binHz)))
  const hi = Math.min(binCount, Math.max(lo + 1, Math.ceil(f1 / binHz)))
  return [lo, hi]
}

// ---- panel --------------------------------------------------------------

export interface VizHandle {
  dispose(): void
}

export function mountViz(root: HTMLElement, editor: EditorHandle, audio: AudioSession): VizHandle {
  const analyser = audio.analyser

  // ---- DOM: panel pinned to the bottom, toggle in the header controls ----
  const panel = document.createElement('section')
  panel.className = 'viz-panel'
  const canvases = document.createElement('div')
  canvases.className = 'viz-canvases'
  const scopeCanvas = document.createElement('canvas')
  scopeCanvas.className = 'viz-scope'
  const spectrumCanvas = document.createElement('canvas')
  spectrumCanvas.className = 'viz-spectrum'
  canvases.append(scopeCanvas, spectrumCanvas)
  const mixer = createMixer(editor.session, editor.rewrite)
  panel.append(canvases, mixer.el)
  root.append(panel) // bottom of the app column (the transport bar is gone)

  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.className = 'btn viz-toggle'
  toggle.innerHTML = `${icon('sliders')}<span class="btn-label">mixer</span>`
  tooltip(toggle, 'mixer + scopes')
  const controls = root.querySelector('.hdr-controls')
  if (controls) controls.insertBefore(toggle, controls.firstChild)
  else root.querySelector('.topbar')?.append(toggle)

  // ---- canvas sizing ---------------------------------------------------
  const dpr = (): number => window.devicePixelRatio || 1
  const sizeCanvas = (c: HTMLCanvasElement): void => {
    const r = c.getBoundingClientRect()
    if (r.width === 0) return // hidden (narrow-viewport spectrum)
    const w = dprSize(r.width, dpr())
    const h = dprSize(r.height, dpr())
    if (c.width !== w) c.width = w
    if (c.height !== h) c.height = h
  }
  const sizeCanvases = (): void => {
    sizeCanvas(scopeCanvas)
    sizeCanvas(spectrumCanvas)
  }

  // ---- drawing ---------------------------------------------------------
  const timeData = analyser !== null ? new Float32Array(analyser.fftSize) : null
  const freqData = analyser !== null ? new Uint8Array(analyser.frequencyBinCount) : null
  const binHz = analyser !== null ? audio.sampleRate / analyser.fftSize : 0

  const drawScopeLine = (ctx: CanvasRenderingContext2D, w: number, h: number): void => {
    if (analyser === null || timeData === null) return
    analyser.getFloatTimeDomainData(timeData)
    ctx.lineWidth = Math.max(1, Math.floor(dpr()))
    ctx.strokeStyle = C_ACCENT
    ctx.beginPath()
    const n = timeData.length
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * w
      const y = h / 2 - timeData[i]! * 0.45 * h
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
  }

  const drawSpectrumBars = (
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    alpha: number,
  ): void => {
    if (analyser === null || freqData === null) return
    analyser.getByteFrequencyData(freqData)
    const bars = Math.min(96, Math.max(16, Math.floor(w / (7 * dpr()))))
    const barW = w / bars
    ctx.globalAlpha = alpha
    ctx.fillStyle = C_ACCENT_ALT
    for (let bar = 0; bar < bars; bar++) {
      const [lo, hi] = barBinRange(bar, bars, freqData.length, binHz)
      let peak = 0
      for (let i = lo; i < hi; i++) if (freqData[i]! > peak) peak = freqData[i]!
      const barH = (peak / 255) * h
      if (barH > 0) ctx.fillRect(bar * barW, h - barH, Math.max(1, barW - Math.max(1, dpr())), barH)
    }
    ctx.globalAlpha = 1
  }

  const ctx2d = (c: HTMLCanvasElement): CanvasRenderingContext2D | null => c.getContext('2d')

  const draw = (): void => {
    const scopeCtx = ctx2d(scopeCanvas)
    if (scopeCtx === null) return
    const spectrumShown = spectrumCanvas.clientWidth > 0
    scopeCtx.clearRect(0, 0, scopeCanvas.width, scopeCanvas.height)
    // Narrow viewports hide the spectrum canvas (CSS): draw dim bars behind
    // the scope line in the ONE remaining canvas instead.
    if (!spectrumShown) drawSpectrumBars(scopeCtx, scopeCanvas.width, scopeCanvas.height, 0.35)
    drawScopeLine(scopeCtx, scopeCanvas.width, scopeCanvas.height)
    if (spectrumShown) {
      const spCtx = ctx2d(spectrumCanvas)
      if (spCtx !== null) {
        spCtx.clearRect(0, 0, spectrumCanvas.width, spectrumCanvas.height)
        drawSpectrumBars(spCtx, spectrumCanvas.width, spectrumCanvas.height, 0.9)
      }
    }
  }

  // ---- render-loop lifecycle: rAF ONLY while open && playing -----------
  let open = window.innerWidth >= VIZ_OPEN_MIN_WIDTH
  let playing = editor.session.getState().playing
  let disposed = false
  let raf = 0
  let running = false

  const frame = (): void => {
    if (!running) return
    draw()
    raf = requestAnimationFrame(frame)
  }
  const syncLoop = (): void => {
    const want = open && playing && !disposed && analyser !== null
    if (want && !running) {
      running = true
      raf = requestAnimationFrame(frame)
    } else if (!want && running) {
      running = false
      cancelAnimationFrame(raf)
    }
  }
  const setOpen = (v: boolean): void => {
    open = v
    panel.classList.toggle('closed', !v)
    toggle.classList.toggle('active', v)
    toggle.setAttribute('aria-expanded', String(v))
    if (v) sizeCanvases()
    syncLoop()
  }

  toggle.addEventListener('click', () => setOpen(!open))
  const onResize = (): void => {
    if (open) sizeCanvases()
  }
  window.addEventListener('resize', onResize)

  // ---- session wiring --------------------------------------------------
  // The mixer's bus faders edit the bus() literals in the source, so their
  // ranges must track the text: refresh on every doc change (re-detect buses),
  // not only on eval. Synth rows still come from session state.
  let lastSynths: string[] = editor.session.getState().synths
  const refreshMixer = (): void => mixer.refresh(lastSynths, detectBuses(editor.getDoc()))
  const unsubState = editor.onState((s) => {
    playing = s.playing
    lastSynths = s.synths
    refreshMixer()
    syncLoop()
  })
  const unsubDoc = editor.onDoc(() => refreshMixer())
  const unsubEngine = editor.onEngineEvent((ev) => {
    if (ev.kind !== 'meters' || !open) return
    mixer.paintMeters(ev.channels, ev.buses) // event-driven, no rAF: decays to 0 after stop
  })

  refreshMixer()
  setOpen(open)

  return {
    dispose(): void {
      disposed = true
      syncLoop()
      unsubState()
      unsubDoc()
      unsubEngine()
      window.removeEventListener('resize', onResize)
      mixer.dispose()
      panel.remove()
      toggle.remove()
    },
  }
}
