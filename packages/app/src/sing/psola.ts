/* ------------------------------------------------------------------------- *
 * TD-PSOLA — time-domain pitch-synchronous overlap-add. Retunes + retimes a
 * voice segment onto a target pitch WITHOUT shifting formants, so a spoken
 * syllable can be sung on a note and stay intelligible. The browser half of the
 * `sing()` pipeline (Supertonic speaks → PSOLA sings). Public-domain algorithm,
 * ported from the offline Python prototype and verified against it.
 *
 * The load-bearing detail: grains MUST be centered on glottal EPOCHS (pitch
 * marks). Placing epoch-centered grains at output marks spaced 1/f0Out is what
 * changes the pitch; arbitrary grain centers only time-stretch. See psola().
 * ------------------------------------------------------------------------- */

/** Estimate a segment's median fundamental (Hz) by autocorrelation. Returns 0
 *  when unvoiced / too short (caller should fall back to a global/neighbour f0).
 *  Good enough for clean TTS voice; not a full pYIN. */
export function estimateF0(x: Float32Array, sr: number, fmin = 75, fmax = 500): number {
  const minLag = Math.floor(sr / fmax)
  const maxLag = Math.min(Math.floor(sr / fmin), x.length - 1)
  if (maxLag <= minLag + 1) return 0
  // frame-wise ACF, take the median of confident frames
  const frame = Math.min(x.length, Math.floor(0.04 * sr))
  const hop = Math.max(1, Math.floor(frame / 2))
  const f0s: number[] = []
  for (let start = 0; start + frame <= x.length; start += hop) {
    let e0 = 0
    for (let i = 0; i < frame; i++) e0 += x[start + i]! * x[start + i]!
    if (e0 < 1e-6) continue
    let bestLag = 0
    let best = 0
    for (let lag = minLag; lag <= maxLag; lag++) {
      let s = 0
      for (let i = 0; i + lag < frame; i++) s += x[start + i]! * x[start + i + lag]!
      const nc = s / e0
      if (nc > best) {
        best = nc
        bestLag = lag
      }
    }
    if (best > 0.4 && bestLag > 0) f0s.push(sr / bestLag)
  }
  if (f0s.length === 0) return 0
  f0s.sort((a, b) => a - b)
  return f0s[f0s.length >> 1]!
}

const hann = (n: number): Float32Array => {
  const w = new Float32Array(n)
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))
  return w
}

/** Unvoiced fallback: plain OLA time-stretch to `outLen` (no pitch change). */
export function olaStretch(x: Float32Array, outLen: number, sr: number): Float32Array {
  const out = new Float32Array(outLen)
  if (x.length < 2 || outLen < 2) return out
  const norm = new Float32Array(outLen)
  const g = Math.min(x.length, Math.max(256, Math.floor(0.03 * sr)))
  const hop = Math.max(1, g >> 2)
  const win = hann(g)
  const ratio = x.length / outLen
  let inp = 0
  for (let op = 0; op < outLen; op += hop) {
    const i0 = Math.floor(inp)
    const L = Math.min(g, x.length - i0, outLen - op)
    for (let k = 0; k < L; k++) {
      out[op + k]! += x[i0 + k]! * win[k]!
      norm[op + k]! += win[k]!
    }
    inp += hop * ratio
  }
  for (let i = 0; i < outLen; i++) if (norm[i]! > 1e-6) out[i]! /= norm[i]!
  return out
}

/** Glottal epochs: successive |x| peaks spaced ~one pitch period apart — the
 *  centers PSOLA grains must sit on. */
function pitchMarks(x: Float32Array, sr: number, f0: number): number[] {
  const Pa = sr / f0
  const n = x.length
  if (n < 2 * Pa) return []
  const argmaxAbs = (lo: number, hi: number): number => {
    let bi = lo
    let bv = -1
    for (let i = lo; i < hi; i++) {
      const a = Math.abs(x[i]!)
      if (a > bv) {
        bv = a
        bi = i
      }
    }
    return bi
  }
  const marks = [argmaxAbs(0, Math.floor(1.5 * Pa))]
  while (marks[marks.length - 1]! + Math.floor(1.4 * Pa) < n) {
    const lo = marks[marks.length - 1]! + Math.floor(0.6 * Pa)
    const hi = marks[marks.length - 1]! + Math.floor(1.4 * Pa)
    marks.push(argmaxAbs(lo, hi))
  }
  return marks
}

/** TD-PSOLA: place epoch-centered grains at synthesis marks spaced 1/f0Out →
 *  output pitch = f0Out, formants preserved, time-scaled by `timeStretch`
 *  (outputLen / inputLen). f0In ≤ 0 → unvoiced OLA fallback. */
export function psola(
  x: Float32Array,
  sr: number,
  timeStretch: number,
  f0Out: number,
  f0In: number,
): Float32Array {
  const outLen = Math.max(1, Math.round(x.length * timeStretch))
  if (f0In <= 0) return olaStretch(x, outLen, sr)
  const marks = pitchMarks(x, sr, f0In)
  if (marks.length < 3) return olaStretch(x, outLen, sr)
  const Ps = sr / f0Out
  const pad = Math.floor((2 * sr) / f0In) + 8
  const out = new Float32Array(outLen + 2 * pad)
  const norm = new Float32Array(outLen + 2 * pad)
  for (let ts = 0; ts < outLen; ts += Ps) {
    const ta = ts / timeStretch
    // nearest epoch
    let mi = 0
    let bd = Infinity
    for (let i = 0; i < marks.length; i++) {
      const d = Math.abs(marks[i]! - ta)
      if (d < bd) {
        bd = d
        mi = i
      }
    }
    const mm = marks[mi]!
    const P = mi + 1 < marks.length ? marks[mi + 1]! - mm : mm - marks[mi - 1]!
    const wh = Math.max(4, P)
    const glen = 2 * wh
    const win = hann(glen)
    const o0 = pad + Math.round(ts) - wh
    for (let k = 0; k < glen; k++) {
      const xi = mm - wh + k
      if (xi < 0 || xi >= x.length) continue
      const oi = o0 + k
      out[oi]! += x[xi]! * win[k]!
      norm[oi]! += win[k]!
    }
  }
  const res = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const nn = norm[pad + i]!
    res[i] = nn > 1e-6 ? out[pad + i]! / nn : 0
  }
  return res
}
