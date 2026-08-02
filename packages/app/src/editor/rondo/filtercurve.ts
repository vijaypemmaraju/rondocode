/* Filter response curves — seeing |H(f)| under svf / ladder / dualsvf / eq
 * lines, with draggable handles that rewrite the literals.
 *
 * THE CURVE MUST NOT LIE. The magnitude responses here are exact analytic
 * transfer functions of the ENGINE's kernels, not sketches:
 *
 *  - svf/dualsvf: the Simper TPT SVF is the bilinear transform of the analog
 *    SVF with prewarped cutoff, so |H| is the analog prototype evaluated at
 *    s = j * tan(pi f/sr) / tan(pi fc/sr) with k = 2 - 2*res (numerators per
 *    output tap: lp 1, bp s, hp s^2, notch 1+s^2, peak 1-s^2, allpass
 *    1 - ks + s^2, all over s^2 + ks + 1). dualsvf serial multiplies the two
 *    stage responses (complex), parallel sums them.
 *  - ladder: the engine's simplified Moog linearized (tanh ~ identity at
 *    small signal): four one-pole stages H1(z) = g/(1 - (1-g)z^-1) with
 *    g = 1 - exp(-2*pi*fc/sr), inside a feedback loop with a ONE-SAMPLE
 *    delay on the s4 tap: H = H1^4 / (1 + 4*res * z^-1 * H1^4).
 *  - eq: the RBJ biquad coefficients (a verbatim copy of the engine's
 *    setCoeffs — eq.ts) evaluated as H(z) per band, cascaded (complex mul).
 *
 * filtercurve.test.ts pins each formula against Goertzel measurements of the
 * real engine kernels driven with probe sines (notch kills center, lp slope,
 * dualsvf serial 24 dB/oct, shelf plateaus...), so a drift in either module
 * fails the suite.
 *
 * This module must NOT import @rondocode/engine statically (it sits in the
 * docs page's eager graph — see wavetable.ts's module doc), which is exactly
 * why the math is replicated here and pinned by tests.
 *
 * HONESTY RULES (scanner): handles write LITERAL args only. A signal-driven
 * cutoff (an lfo, an env binding) draws the curve at the arg's static
 * fallback when one exists — a knob binding's DEF — with NO handle for that
 * arg (the text stays the only write surface for signals). When no static
 * value exists at all the line gets no curve: drawing a made-up cutoff would
 * lie. Live overlay of the playing response is deliberately out of scope for
 * v1 — the curve is static at the written values. */

import { EditorView, WidgetType } from '@codemirror/view'
import { formatNumber } from '../widgets/rewrite'
import { LiveWriter, attachGesture } from './gesture'
import type { Drag } from './gesture'
import { EQ_TYPE_CYCLES, SVF_MODES } from './enums'
import { inkOf, paintOnAttach } from './paint'
import { buzz } from './widgets'
import type { Hooks, KnobMatch } from './widgets'

const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v)

/* ------------------------------- complex ---------------------------------- */

export interface Cplx { re: number; im: number }

const cMul = (a: Cplx, b: Cplx): Cplx => ({ re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re })
const cAdd = (a: Cplx, b: Cplx): Cplx => ({ re: a.re + b.re, im: a.im + b.im })
const cDiv = (a: Cplx, b: Cplx): Cplx => {
  const d = b.re * b.re + b.im * b.im || 1e-30
  return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d }
}
export const cAbs = (a: Cplx): number => Math.hypot(a.re, a.im)

/* ---------------------------- transfer functions --------------------------- */

export type SvfModeName = 'lp' | 'hp' | 'bp' | 'notch' | 'peak' | 'allpass'

/** Complex response of the engine's Simper SVF at `f` Hz (mode/cutoff/res as
 *  the kernel clamps them). Exact for SvfKernel — pinned by test. */
export function svfResponse(mode: SvfModeName, f: number, fc: number, res: number, sr: number): Cplx {
  const g = Math.tan((Math.PI * clamp(fc, 1, 0.49 * sr)) / sr)
  const k = 2 - 2 * clamp(res, 0, 0.98)
  const w = Math.tan((Math.PI * clamp(f, 0.01, 0.499 * sr)) / sr) / g
  const den: Cplx = { re: 1 - w * w, im: k * w }
  let num: Cplx
  switch (mode) {
    case 'lp': num = { re: 1, im: 0 }; break
    case 'bp': num = { re: 0, im: w }; break
    case 'hp': num = { re: -w * w, im: 0 }; break
    case 'notch': num = { re: 1 - w * w, im: 0 }; break
    case 'peak': num = { re: 1 + w * w, im: 0 }; break
    default: num = { re: 1 - w * w, im: -k * w } // allpass
  }
  return cDiv(num, den)
}

/** Complex response of the engine's ladder (linearized small-signal; the
 *  kernel's tanh only bends it at drive). Exact in the linear regime —
 *  pinned by test. */
export function ladderResponse(f: number, fc: number, res: number, sr: number): Cplx {
  const g = 1 - Math.exp((-2 * Math.PI * clamp(fc, 1, 0.45 * sr)) / sr)
  const fb = 4 * clamp(res, 0, 1.1)
  const w = (2 * Math.PI * clamp(f, 0.01, 0.499 * sr)) / sr
  const zInv: Cplx = { re: Math.cos(w), im: -Math.sin(w) }
  const h1 = cDiv({ re: g, im: 0 }, { re: 1 - (1 - g) * zInv.re, im: -(1 - g) * zInv.im })
  const h4 = cMul(cMul(h1, h1), cMul(h1, h1))
  const den = cAdd({ re: 1, im: 0 }, cMul({ re: fb, im: 0 }, cMul(zInv, h4)))
  return cDiv(h4, den)
}

/** Complex response of the engine's dualsvf: serial = A then B (complex
 *  product), parallel = A + B on the dry input (complex sum). One shared res. */
export function dualSvfResponse(
  routing: 'serial' | 'parallel',
  a: SvfModeName, b: SvfModeName,
  f: number, fcA: number, fcB: number, res: number, sr: number,
): Cplx {
  const ha = svfResponse(a, f, fcA, res, sr)
  const hb = svfResponse(b, f, fcB, res, sr)
  return routing === 'parallel' ? cAdd(ha, hb) : cMul(ha, hb)
}

export type EqBandTypeName = 'lowshelf' | 'highshelf' | 'peak' | 'lp' | 'hp'

export interface EqBandSpec {
  type: EqBandTypeName
  freq: number
  gain?: number
  q?: number
}

/** Normalized RBJ biquad coefficients for one eq band — a verbatim copy of
 *  the engine's setCoeffs (eq.ts), same clamps and defaults. Pinned by test. */
export function eqBandCoeffs(band: EqBandSpec, sr: number): { b0: number; b1: number; b2: number; a1: number; a2: number } {
  const freq = clamp(Number.isFinite(band.freq) ? band.freq : 1000, 10, sr * 0.49)
  const gainDb = clamp(band.gain !== undefined && Number.isFinite(band.gain) ? band.gain : 0, -48, 48)
  const q = clamp(band.q !== undefined && Number.isFinite(band.q) ? band.q : 0.707, 0.1, 24)
  const w0 = (2 * Math.PI * freq) / sr
  const cosw = Math.cos(w0)
  const sinw = Math.sin(w0)
  const A = Math.pow(10, gainDb / 40)
  const alpha = sinw / (2 * q)
  let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0
  switch (band.type) {
    case 'lp':
      b0 = (1 - cosw) / 2; b1 = 1 - cosw; b2 = (1 - cosw) / 2
      a0 = 1 + alpha; a1 = -2 * cosw; a2 = 1 - alpha
      break
    case 'hp':
      b0 = (1 + cosw) / 2; b1 = -(1 + cosw); b2 = (1 + cosw) / 2
      a0 = 1 + alpha; a1 = -2 * cosw; a2 = 1 - alpha
      break
    case 'peak':
      b0 = 1 + alpha * A; b1 = -2 * cosw; b2 = 1 - alpha * A
      a0 = 1 + alpha / A; a1 = -2 * cosw; a2 = 1 - alpha / A
      break
    case 'lowshelf': {
      const s = 2 * Math.sqrt(A) * alpha
      b0 = A * (A + 1 - (A - 1) * cosw + s)
      b1 = 2 * A * (A - 1 - (A + 1) * cosw)
      b2 = A * (A + 1 - (A - 1) * cosw - s)
      a0 = A + 1 + (A - 1) * cosw + s
      a1 = -2 * (A - 1 + (A + 1) * cosw)
      a2 = A + 1 + (A - 1) * cosw - s
      break
    }
    case 'highshelf': {
      const s = 2 * Math.sqrt(A) * alpha
      b0 = A * (A + 1 + (A - 1) * cosw + s)
      b1 = -2 * A * (A - 1 + (A + 1) * cosw)
      b2 = A * (A + 1 + (A - 1) * cosw - s)
      a0 = A + 1 - (A - 1) * cosw + s
      a1 = 2 * (A - 1 - (A + 1) * cosw)
      a2 = A + 1 - (A - 1) * cosw - s
      break
    }
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
}

/** Complex response of an eq band cascade at `f` Hz (H(z) per biquad,
 *  multiplied — the engine runs the bands in series). */
export function eqResponse(bands: readonly EqBandSpec[], f: number, sr: number): Cplx {
  const w = (2 * Math.PI * clamp(f, 0.01, 0.499 * sr)) / sr
  const z1: Cplx = { re: Math.cos(w), im: -Math.sin(w) }
  const z2 = cMul(z1, z1)
  let h: Cplx = { re: 1, im: 0 }
  for (const band of bands) {
    const c = eqBandCoeffs(band, sr)
    const num = cAdd({ re: c.b0, im: 0 }, cAdd(cMul({ re: c.b1, im: 0 }, z1), cMul({ re: c.b2, im: 0 }, z2)))
    const den = cAdd({ re: 1, im: 0 }, cAdd(cMul({ re: c.a1, im: 0 }, z1), cMul({ re: c.a2, im: 0 }, z2)))
    h = cMul(h, cDiv(num, den))
  }
  return h
}

/* -------------------------------- geometry -------------------------------- */

/** Frequency axis: log, 20 Hz .. 20 kHz. */
export const F_LO = 20
export const F_HI = 20000
/** Magnitude axis: dB, floor to ceiling. */
export const DB_LO = -36
export const DB_HI = 24

export const freqToX = (f: number, w: number): number =>
  (Math.log(clamp(f, F_LO, F_HI) / F_LO) / Math.log(F_HI / F_LO)) * w

export const xToFreq = (x: number, w: number): number =>
  F_LO * Math.pow(F_HI / F_LO, clamp(x / (w || 1), 0, 1))

export const dbToY = (db: number, h: number): number =>
  ((DB_HI - clamp(db, DB_LO, DB_HI)) / (DB_HI - DB_LO)) * h

export const magToDb = (mag: number): number => 20 * Math.log10(Math.max(mag, 1e-9))

/* -------------------------------- scanning -------------------------------- */

/** A numeric arg's static story: `value` always present (literal, knob DEF
 *  fallback, or the builtin's default); `range` only when the SOURCE text is
 *  a literal number there — the one case a handle may rewrite. */
export interface StaticArg {
  value: number
  range?: { from: number; to: number }
}

export interface FilterScan {
  kind: 'svf' | 'ladder' | 'dualsvf' | 'eq'
  /** the enclosing `synth NAME` (undefined in a bus body). */
  synth?: string
  /** absolute end of the line's code part — where the widget anchors. */
  at: number
  /** cutoff (svf/ladder) or [cutoffA, cutoffB] (dualsvf). Empty for eq. */
  cutoffs: StaticArg[]
  /** shared res — svf default 0, ladder default 0.5 (the rondo registry
   *  default), dualsvf default 0. */
  res: StaticArg
  /** svf output mode / dualsvf per-stage modes + routing. */
  mode: SvfModeName
  routing: 'serial' | 'parallel'
  a: SvfModeName
  b: SvfModeName
  /** eq bands (all fields literal — see the honesty rules). */
  bands: { type: EqBandTypeName; freq: StaticArg; gain?: StaticArg; q?: StaticArg }[]
}

// One editor-side list, shared by the scanners (see enums.ts for why the
// editor mirrors the engine rather than importing it).
const SVF_MODE_SET: ReadonlySet<string> = new Set(SVF_MODES)
const EQ_TYPE_SET: ReadonlySet<string> = new Set(EQ_TYPE_CYCLES.flat())
const NUM_RE = /^-?\d*\.?\d+$/

const stripComment = (raw: string): string => {
  const cm = /(^|\s)#/.exec(raw)
  return cm ? raw.slice(0, cm.index + (cm[1] ? cm[1].length : 0)) : raw
}

interface Token { text: string; from: number }

const tokenize = (s: string, off: number): Token[] => {
  const out: Token[] = []
  const re = /[^ \t]+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s)) !== null) out.push({ text: m[0], from: off + m.index })
  return out
}

/** Resolve one positional/named numeric token to its static story:
 *  literal → value + writable range; a knob-binding name → the knob's DEF
 *  (no range: the signal owns it); anything else → null (no static value). */
const staticArg = (tok: Token | undefined, knobs: ReadonlyMap<string, number>): StaticArg | null => {
  if (tok === undefined) return null
  if (NUM_RE.test(tok.text)) {
    return { value: Number(tok.text), range: { from: tok.from, to: tok.from + tok.text.length } }
  }
  const def = knobs.get(tok.text)
  return def !== undefined ? { value: def } : null
}

/** Find every svf/ladder/dualsvf/eq line with enough static values to draw an
 *  honest curve. `knobs` supplies per-synth knob DEFs (from scanKnobs) for
 *  the signal-driven-cutoff fallback. Pure — unit tested. */
export function scanFilters(text: string, knobs: readonly KnobMatch[] = []): FilterScan[] {
  const out: FilterScan[] = []
  // knob DEF lookup: synth-scoped names ("synth name"); bus knobs don't exist
  const knobDefs = new Map<string, number>()
  for (const k of knobs) {
    if (k.name !== undefined && k.synth !== undefined) knobDefs.set(`${k.synth} ${k.name}`, k.value)
  }
  let off = 0
  let block: string | undefined
  let synth: string | undefined
  for (const raw of text.split('\n')) {
    const line = stripComment(raw)
    const header = /^([a-zA-Z_]\w*)\b(?:[ \t]+([a-zA-Z_]\w*))?/.exec(line)
    if (header !== null && /^\S/.test(line)) {
      block = header[1]
      synth = block === 'synth' ? header[2] : undefined
    }
    if (block !== 'synth' && block !== 'bus') { off += raw.length + 1; continue }
    const m = /^[ \t]+(?:[a-zA-Z_]\w*[ \t]*=[ \t]*)?(svf|ladder|dualsvf|eq)\b/.exec(line)
    if (m === null) { off += raw.length + 1; continue }
    const kind = m[1] as FilterScan['kind']
    const code = line.replace(/[ \t]+$/, '')
    const at = off + code.length
    const toks = tokenize(line.slice(m[0].length), off + m[0].length)
    const scoped = new Map<string, number>()
    if (synth !== undefined) {
      for (const [key, v] of knobDefs) {
        if (key.startsWith(`${synth} `)) scoped.set(key.slice(synth.length + 1), v)
      }
    }
    const scan: FilterScan = {
      kind, at, cutoffs: [], res: { value: kind === 'ladder' ? 0.5 : 0 },
      mode: 'lp', routing: 'serial', a: 'lp', b: 'lp', bands: [],
    }
    if (synth !== undefined) scan.synth = synth
    let ok = true
    if (kind === 'eq') {
      // band groups: type word, then freq [gain] [q] (hp/lp: freq [q]) — all
      // numbers must be literal or the line stays curve-less (honest)
      let i = 0
      while (i < toks.length) {
        const t = toks[i]!
        if (!EQ_TYPE_SET.has(t.text)) { ok = false; break }
        const type = t.text as EqBandTypeName
        i++
        const nums: StaticArg[] = []
        while (i < toks.length && NUM_RE.test(toks[i]!.text)) {
          const tk = toks[i]!
          nums.push({ value: Number(tk.text), range: { from: tk.from, to: tk.from + tk.text.length } })
          i++
        }
        if (nums.length === 0) { ok = false; break } // freq is required
        const band: FilterScan['bands'][number] = { type, freq: nums[0]! }
        if (type === 'hp' || type === 'lp') {
          if (nums.length > 2) { ok = false; break }
          if (nums[1] !== undefined) band.q = nums[1]
        } else {
          if (nums.length > 3) { ok = false; break }
          if (nums[1] !== undefined) band.gain = nums[1]
          if (nums[2] !== undefined) band.q = nums[2]
        }
        scan.bands.push(band)
      }
      if (!ok || scan.bands.length === 0) { off += raw.length + 1; continue }
      out.push(scan)
      off += raw.length + 1
      continue
    }
    // svf/ladder/dualsvf: positionals then named args
    const positional: Token[] = []
    for (let ti = 0; ti < toks.length; ti++) {
      const t = toks[ti]!
      const colon = t.text.indexOf(':')
      if (colon > 0 && /^[a-zA-Z_]\w*$/.test(t.text.slice(0, colon))) {
        const key = t.text.slice(0, colon)
        let vTok: Token = { text: t.text.slice(colon + 1), from: t.from + colon + 1 }
        // `res: .5` — the value can be the NEXT token (the lexer allows it)
        if (vTok.text === '' && ti + 1 < toks.length) vTok = toks[++ti]!
        const value = vTok.text
        if (key === 'res') {
          const sa = staticArg(vTok, scoped)
          // a signal-driven res falls back to the default silently — the
          // curve is still honest at the written cutoffs, just at rest res
          if (sa !== null) scan.res = sa
        } else if (key === 'mode') {
          if (kind === 'svf' && SVF_MODE_SET.has(value)) scan.mode = value as SvfModeName
          if (kind === 'dualsvf' && (value === 'serial' || value === 'parallel')) scan.routing = value
        } else if (key === 'a' && kind === 'dualsvf' && SVF_MODE_SET.has(value)) {
          scan.a = value as SvfModeName
        } else if (key === 'b' && kind === 'dualsvf' && SVF_MODE_SET.has(value)) {
          scan.b = value as SvfModeName
        }
        continue
      }
      positional.push(t)
    }
    const need = kind === 'dualsvf' ? 2 : 1
    if (positional.length !== need) { off += raw.length + 1; continue } // a rich expression — no honest read
    for (const p of positional) {
      const sa = staticArg(p, scoped)
      if (sa === null) { ok = false; break } // no static value at all: no curve
      scan.cutoffs.push(sa)
    }
    if (ok) out.push(scan)
    off += raw.length + 1
  }
  return out
}

/** |H| in dB at `f` for a scan (the one place widget + tests compose it). */
export function scanResponseDb(scan: FilterScan, f: number, sr: number): number {
  if (scan.kind === 'eq') {
    return magToDb(cAbs(eqResponse(scan.bands.map((b) => {
      const spec: EqBandSpec = { type: b.type, freq: b.freq.value }
      if (b.gain !== undefined) spec.gain = b.gain.value
      if (b.q !== undefined) spec.q = b.q.value
      return spec
    }), f, sr)))
  }
  if (scan.kind === 'ladder') return magToDb(cAbs(ladderResponse(f, scan.cutoffs[0]!.value, scan.res.value, sr)))
  if (scan.kind === 'dualsvf') {
    return magToDb(cAbs(dualSvfResponse(
      scan.routing, scan.a, scan.b, f,
      scan.cutoffs[0]!.value, scan.cutoffs[1]!.value, scan.res.value, sr,
    )))
  }
  return magToDb(cAbs(svfResponse(scan.mode, f, scan.cutoffs[0]!.value, scan.res.value, sr)))
}

/* --------------------------------- widget --------------------------------- */

const CURVE = { h: 72, pad: 6, samples: 96 }
/** Display sample rate for the response math. The engine's actual rate can
 *  differ (44.1k/48k hardware) — below ~16 kHz the curves are visually
 *  identical, and the widget cannot know the device rate without importing
 *  the engine (see module doc). */
const DISPLAY_SR = 48000

interface Handle {
  /** x drives this literal (cutoff / band freq); undefined = not writable. */
  fRange?: { from: number; to: number }
  f0: number
  /** y drives this literal (res / band gain); undefined = not writable. */
  vRange?: { from: number; to: number }
  v0: number
  /** vertical mapping: res 0..1 over the height, or gain in dB. */
  vKind: 'res' | 'gain' | 'none'
}

/** The widget's handles, derived from a scan. Pure — unit tested. */
export function scanHandles(scan: FilterScan): Handle[] {
  if (scan.kind === 'eq') {
    return scan.bands.map((b) => {
      const h: Handle = { f0: b.freq.value, v0: b.gain?.value ?? 0, vKind: b.gain !== undefined ? 'gain' : 'none' }
      if (b.freq.range !== undefined) h.fRange = b.freq.range
      if (b.gain?.range !== undefined) h.vRange = b.gain.range
      return h
    })
  }
  return scan.cutoffs.map((c) => {
    const h: Handle = { f0: c.value, v0: scan.res.value, vKind: 'res' }
    if (c.range !== undefined) h.fRange = c.range
    if (scan.res.range !== undefined) h.vRange = scan.res.range
    return h
  })
}

export class FilterCurveWidget extends WidgetType {
  constructor(
    readonly scan: FilterScan,
    /** identity of everything drawn — a cheap eq() key. */
    readonly key: string,
    readonly width: number,
    readonly hooks: Hooks,
    readonly drag: Drag,
  ) { super() }

  override eq(o: FilterCurveWidget): boolean {
    return o.key === this.key && o.width === this.width
  }

  override toDOM(view: EditorView): HTMLElement {
    const scan = this.scan
    const W = this.width
    const H = CURVE.h
    const wrap = document.createElement('span')
    wrap.className = 'rondo-fcurve'
    wrap.setAttribute('role', 'img')
    wrap.setAttribute('aria-label', `${scan.kind} frequency response`)
    const canvas = document.createElement('canvas')
    canvas.style.width = `${W}px`
    canvas.style.height = `${H}px`
    wrap.appendChild(canvas)

    // a live copy of the scan the gesture mutates + redraws from
    const live: FilterScan = JSON.parse(JSON.stringify(scan)) as FilterScan
    const handles = scanHandles(scan)

    const draw = (): void => {
      const g = canvas.getContext('2d')
      if (g === null) return
      const dpr = Math.max(1, Math.min(3, globalThis.devicePixelRatio ?? 1))
      if (canvas.width !== W * dpr) { canvas.width = W * dpr; canvas.height = H * dpr }
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.clearRect(0, 0, W, H)
      const color = inkOf(canvas)
      // grid: decades + the 0 dB line
      g.strokeStyle = color
      g.globalAlpha = 0.14
      g.lineWidth = 1
      for (const f of [100, 1000, 10000]) {
        const x = freqToX(f, W)
        g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke()
      }
      const y0 = dbToY(0, H)
      g.beginPath(); g.moveTo(0, y0); g.lineTo(W, y0); g.stroke()
      // the response
      g.globalAlpha = 1
      g.lineWidth = 1.8
      g.beginPath()
      for (let i = 0; i <= CURVE.samples; i++) {
        const f = xToFreq((i / CURVE.samples) * W, W)
        const y = dbToY(scanResponseDb(live, f, DISPLAY_SR), H)
        if (i === 0) g.moveTo(0, y)
        else g.lineTo((i / CURVE.samples) * W, y)
      }
      g.stroke()
      // handles ride the curve at their frequency
      const liveHandles = scanHandles(live)
      for (const h of liveHandles) {
        const x = freqToX(h.f0, W)
        const y = dbToY(scanResponseDb(live, h.f0, DISPLAY_SR), H)
        g.beginPath()
        g.arc(x, clamp(y, 5, H - 5), 4.5, 0, 2 * Math.PI)
        g.globalAlpha = h.fRange !== undefined ? 1 : 0.4 // dim = not writable
        g.fillStyle = color
        g.fill()
        g.globalAlpha = 1
      }
    }
    // toDOM runs BEFORE CodeMirror inserts this node, and a detached element
    // computes to black — see paint.ts
    paintOnAttach(draw)

    // any writable literal makes the surface a control
    const writable = handles.some((h) => h.fRange !== undefined || h.vRange !== undefined)
    if (!writable) {
      wrap.title = `${scan.kind}: response at the args' static values (signal-driven args have no handle)`
      return wrap
    }
    wrap.classList.add('editable')
    wrap.title = 'drag a handle: sideways = frequency, vertical = ' + (scan.kind === 'eq' ? 'gain' : 'res')

    // ONE LiveWriter spans all this line's writable literals; each move
    // splices the dragged handle's fresh values into the ORIGINAL text at
    // their original offsets (untouched fields keep their source spelling —
    // same trick as EnvWidget's parts).
    attachGesture(wrap, this.drag, 'window', (e) => {
      const rect = canvas.getBoundingClientRect()
      const sx = (e.clientX - rect.left) * (W / rect.width)
      // nearest handle BY X (the y axis crowds at high res/gain)
      let hi = -1
      let best = Infinity
      for (let i = 0; i < handles.length; i++) {
        const d = Math.abs(freqToX(handles[i]!.f0, W) - sx)
        if (d < best) { best = d; hi = i }
      }
      const h = handles[hi]
      if (h === undefined || (h.fRange === undefined && h.vRange === undefined)) return null
      buzz()
      wrap.classList.add('active')
      const ranges = [h.fRange, h.vRange].filter((r): r is { from: number; to: number } => r !== undefined)
      ranges.sort((p, q) => p.from - q.from)
      const regionFrom = ranges[0]!.from
      const regionTo = ranges[ranges.length - 1]!.to
      const writer = new LiveWriter(view, regionFrom, regionTo)
      const orig = writer.text
      const y0px = e.clientY
      let f = h.f0
      let v = h.v0
      const resMax = scan.kind === 'ladder' ? 1.1 : 0.98
      const fmtF = (x: number): string => formatNumber(x, { step: x < 100 ? 0.5 : 1, min: F_LO })
      const fmtV = (x: number): string =>
        h.vKind === 'gain' ? formatNumber(x, { step: 0.5, min: -48 }) : formatNumber(x, { step: 0.01, min: 0 })
      const splice = (): string => {
        const parts: { at: { from: number; to: number }; text: string }[] = []
        if (h.fRange !== undefined) parts.push({ at: h.fRange, text: fmtF(f) })
        if (h.vRange !== undefined) parts.push({ at: h.vRange, text: fmtV(v) })
        parts.sort((p, q) => p.at.from - q.at.from)
        let outText = ''
        let cursor = regionFrom
        for (const p of parts) {
          outText += orig.slice(cursor - regionFrom, p.at.from - regionFrom) + p.text
          cursor = p.at.to
        }
        return outText + orig.slice(cursor - regionFrom)
      }
      const setLive = (): void => {
        if (scan.kind === 'eq') {
          const band = live.bands[hi]!
          band.freq.value = f
          if (band.gain !== undefined) band.gain.value = v
        } else {
          live.cutoffs[hi]!.value = f
          live.res.value = v
        }
      }
      return {
        onMove: (ev) => {
          const mx = (ev.clientX - rect.left) * (W / rect.width)
          if (h.fRange !== undefined) f = clamp(xToFreq(mx, W), F_LO, F_HI)
          if (h.vRange !== undefined) {
            const dv = (y0px - ev.clientY) / H // full height = full range
            v = h.vKind === 'gain' ? clamp(h.v0 + dv * (DB_HI - DB_LO), -24, 24) : clamp(h.v0 + dv, 0, resMax)
          }
          if (!writer.write(splice())) return // a concurrent edit aborted the gesture
          setLive()
          draw()
          this.hooks.requestEval(false)
        },
        onEnd: () => {
          this.drag.ended = true
          wrap.classList.remove('active')
          view.dispatch({}) // empty transaction → plugin rebuilds (fresh ranges)
          this.hooks.requestEval(false)
        },
      }
    })
    return wrap
  }

  override ignoreEvent(): boolean { return true }
}
