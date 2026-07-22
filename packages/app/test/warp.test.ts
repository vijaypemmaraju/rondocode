import { describe, it, expect } from 'vitest'
import { parseMelodyMini, syllableSegments, assembleGuide, type Seg } from '../src/sing/warp'

const mtof = (m: number): number => 440 * 2 ** ((m - 69) / 12)

describe('parseMelodyMini', () => {
  it('resolves pitch + tempo-aware durations through the pattern engine', () => {
    const m = parseMelodyMini('c4 d4 e4 f4', 1) // 4 notes, 1 cycle/sec -> 0.25s each
    expect(m.map((n) => n.midi)).toEqual([60, 62, 64, 65])
    for (const n of m) expect(n.dur).toBeCloseTo(0.25, 3)
  })
  it('honours @-elongation (a held note is proportionally longer)', () => {
    const m = parseMelodyMini('c4 c4 g4@2', 1) // weights 1,1,2 over 1 cycle
    expect(m[0]!.dur).toBeCloseTo(0.25, 3)
    expect(m[2]!.dur).toBeCloseTo(0.5, 3) // twice as long
  })
})

describe('assembleGuide: vowels land on the beat, f0 on the grid', () => {
  // Build a synthetic spoken clip + vowel-probability curve with n clean, evenly
  // spaced syllables (onset=silence marker 0, vowel=marker i+1, coda=silence), so
  // we can assert where each vowel's audio and pitch land — no models involved.
  const sr = 16000
  const cps = 1
  const notes = parseMelodyMini('c4 d4 e4 f4 g4', cps) // 5 notes, 0.2s each
  const n = notes.length
  const perSyl = Math.round(0.2 * sr)
  const onN = Math.round(0.04 * sr)
  const voN = Math.round(0.12 * sr)
  const spoken = new Float32Array(n * perSyl)
  for (let i = 0; i < n; i++) for (let k = 0; k < voN; k++) spoken[i * perSyl + onN + k] = i + 1
  const probFps = 50
  const pf = Math.round((spoken.length / sr) * probFps)
  const prob = new Float32Array(pf)
  for (let i = 0; i < n; i++) {
    const vs = (i * perSyl + onN) / sr
    const ve = (i * perSyl + onN + voN) / sr
    for (let f = 0; f < pf; f++) {
      const t = f / probFps
      if (t >= vs && t < ve) prob[f] = 1
    }
  }
  const segs: Seg[] = syllableSegments(spoken, sr, prob, probFps, n)
  const { guide, f0, fps } = assembleGuide(segs, notes, sr)
  const tgt = Math.round(0.2 * sr)

  it('produces exactly the musical length', () => {
    expect(Math.abs(guide.length - tgt * n)).toBeLessThanOrEqual(n)
  })

  it('starts every vowel (bar the first pickup) on its beat', () => {
    for (let i = 1; i < n; i++) {
      const s = guide[i * tgt + Math.round(0.02 * sr)] ?? 0
      expect(Math.abs(s - (i + 1))).toBeLessThan(0.5) // this syllable's marker, not a neighbour's
    }
  })

  it('places the melody f0 exactly on the beat grid', () => {
    for (let i = 0; i < n; i++) {
      const mid = Math.floor(((i * tgt + tgt / 2) / sr) * fps)
      const cents = 1200 * Math.log2((f0[mid] ?? 0) / mtof(notes[i]!.midi))
      expect(Math.abs(cents)).toBeLessThan(1)
    }
  })
})
