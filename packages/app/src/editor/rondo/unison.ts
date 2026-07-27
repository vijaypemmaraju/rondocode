/* Unison fan — a small display-only glyph on `synth` headers carrying
 * unison>1: one vertical stroke per sub-voice, x = the voice's detune
 * position THROUGH the curve exponent, height = its blend gain, octave
 * voices tinted. The geometry replicates the engine VoicePool's unison
 * layout exactly (voice.ts — fracs, curve warp, blend fade, octave lift),
 * with the same clamps, so the picture is the cluster you hear.
 *
 * Display-only on purpose: the header numbers already scrub — the glyph is
 * the read-back, not another write surface. Pure geometry here; the thin
 * widget DOM lives in widgets.ts. */

const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v)

export interface UnisonScan {
  /** absolute end of the header line's code part — where the glyph anchors. */
  at: number
  synth: string
  unison: number
  /** total detune spread in cents (display/tooltip only — the layout's x is
   *  the NORMALIZED position; detune scales all voices alike). Default 15. */
  detune: number
  curve: number
  blend: number
  octaves: number
}

/** Strip a rondo ` # comment` (line start or whitespace-preceded '#'). */
const stripComment = (raw: string): string => {
  const cm = /(^|\s)#/.exec(raw)
  return cm ? raw.slice(0, cm.index + (cm[1] ? cm[1].length : 0)) : raw
}

/** A named numeric header option (`unison:5`, `unison: 5`). */
const headerNum = (line: string, key: string): number | undefined => {
  const m = new RegExp(`\\b${key}:[ \\t]*(-?\\d*\\.?\\d+)`).exec(line)
  return m !== null ? Number(m[1]) : undefined
}

/** Find every `synth NAME … unison:N …` header with unison > 1. Defaults
 *  mirror the engine's DEFAULT_VOICE_OPTS (detune 15, curve 1, blend 1,
 *  octaves 0). Pure — unit tested. */
export function scanUnisonHeaders(text: string): UnisonScan[] {
  const out: UnisonScan[] = []
  let off = 0
  for (const raw of text.split('\n')) {
    const line = stripComment(raw)
    const m = /^synth[ \t]+([a-zA-Z_]\w*)\b/.exec(line)
    if (m !== null) {
      const unison = headerNum(line, 'unison')
      if (unison !== undefined && unison > 1) {
        const code = line.replace(/[ \t]+$/, '')
        out.push({
          at: off + code.length,
          synth: m[1]!,
          unison,
          detune: headerNum(line, 'detune') ?? 15,
          curve: headerNum(line, 'curve') ?? 1,
          blend: headerNum(line, 'blend') ?? 1,
          octaves: headerNum(line, 'octaves') ?? 0,
        })
      }
    }
    off += raw.length + 1
  }
  return out
}

export interface FanStroke {
  /** detune position through the curve, -1..+1 (0 = center voice). */
  x: number
  /** blend gain 0..1 (1 at center, `blend` at the outermost pair). */
  h: number
  /** this voice plays +12 semitones (octave stacking). */
  octave: boolean
}

/** The engine's unison layout as glyph strokes — the SAME per-voice math as
 *  VoicePool's constructor (voice.ts), same clamps: unison floor-clamped to
 *  1..9, curve to [0.2, 5], blend to [0, 1], octaves floored to [0, 9];
 *  octave lift on every `octaves`-th voice in layout order when octaves >= 2.
 *  Pure — unit tested against hand-computed layouts. */
export function unisonFan(unison: number, curve: number, blend: number, octaves: number): FanStroke[] {
  const N = Math.floor(clamp(Number.isFinite(unison) ? unison : 1, 1, 9))
  const c = clamp(Number.isFinite(curve) ? curve : 1, 0.2, 5)
  const b = clamp(Number.isFinite(blend) ? blend : 1, 0, 1)
  const oct = Math.floor(clamp(Number.isFinite(octaves) ? octaves : 0, 0, 9))
  const strokes: FanStroke[] = []
  for (let j = 0; j < N; j++) {
    const frac = N === 1 ? 0 : (j / (N - 1)) * 2 - 1 // -1..+1, linear
    const warped = c === 1 || frac === 0 ? frac : Math.sign(frac) * Math.abs(frac) ** c
    strokes.push({
      x: warped,
      h: b === 1 ? 1 : 1 - (1 - b) * Math.abs(frac),
      octave: oct >= 2 && (j + 1) % oct === 0,
    })
  }
  return strokes
}
