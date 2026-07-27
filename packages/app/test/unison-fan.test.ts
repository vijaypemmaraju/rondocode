import { describe, expect, it } from 'vitest'
import { scanUnisonHeaders, unisonFan } from '../src/editor/rondo/unison'

/* The unison fan glyph's pure parts: header scanning and the per-voice
 * layout geometry (which replicates the engine VoicePool's unison layout —
 * fracs, curve warp, blend fade, octave lift — with the same clamps). The
 * widget DOM is display-only and stays untested. */

describe('scanUnisonHeaders', () => {
  it('finds unison headers with all shaping opts and the anchor at line end', () => {
    const doc = 'synth super unison:5 detune:25 curve:2 blend:.6 octaves:2\n  supersaw\n'
    const [u] = scanUnisonHeaders(doc)
    expect(u).toEqual({
      at: doc.indexOf('octaves:2') + 'octaves:2'.length,
      synth: 'super',
      unison: 5,
      detune: 25,
      curve: 2,
      blend: 0.6,
      octaves: 2,
    })
  })

  it('defaults mirror the engine (detune 15, curve 1, blend 1, octaves 0)', () => {
    const [u] = scanUnisonHeaders('synth s1 unison:3\n  saw\n')
    expect(u).toMatchObject({ unison: 3, detune: 15, curve: 1, blend: 1, octaves: 0 })
  })

  it('mixes with mono/glide and tolerates a space after the colon', () => {
    const [u] = scanUnisonHeaders('synth acid mono glide:.08 unison: 7 detune: 12\n  saw\n')
    expect(u).toMatchObject({ synth: 'acid', unison: 7, detune: 12 })
  })

  it('unison 1 / absent / non-literal gets no glyph; comments are ignored', () => {
    expect(scanUnisonHeaders('synth s1 unison:1\n  saw\n')).toEqual([])
    expect(scanUnisonHeaders('synth s1\n  saw\n')).toEqual([])
    expect(scanUnisonHeaders('synth s1 unison:n\n  saw\n')).toEqual([])
    expect(scanUnisonHeaders('# synth s1 unison:5\n')).toEqual([])
    // the anchor stops before a trailing comment
    const doc = 'synth s1 unison:2  # wide\n  saw\n'
    expect(scanUnisonHeaders(doc)[0]!.at).toBe(doc.indexOf('unison:2') + 'unison:2'.length)
  })
})

describe('unisonFan', () => {
  it('lays voices evenly from -1 to +1 at curve 1', () => {
    expect(unisonFan(5, 1, 1, 0).map((s) => s.x)).toEqual([-1, -0.5, 0, 0.5, 1])
    expect(unisonFan(2, 1, 1, 0).map((s) => s.x)).toEqual([-1, 1])
  })

  it('curve > 1 pulls inner voices toward the center, edges stay at ±1', () => {
    const xs = unisonFan(5, 2, 1, 0).map((s) => s.x)
    expect(xs).toEqual([-1, -0.25, 0, 0.25, 1])
    // < 1 pushes them outward
    const wide = unisonFan(5, 0.5, 1, 0).map((s) => s.x)
    expect(wide[1]!).toBeCloseTo(-Math.sqrt(0.5), 12)
    expect(Math.abs(wide[1]!)).toBeGreaterThan(0.5)
  })

  it('blend fades stroke height linearly to the edge gain', () => {
    expect(unisonFan(3, 1, 0.5, 0).map((s) => s.h)).toEqual([0.5, 1, 0.5])
    const hs = unisonFan(5, 1, 0.2, 0).map((s) => s.h)
    const want = [0.2, 0.6, 1, 0.6, 0.2]
    hs.forEach((h, i) => expect(h).toBeCloseTo(want[i]!, 12))
    expect(unisonFan(4, 1, 1, 0).every((s) => s.h === 1)).toBe(true)
  })

  it('octave stacking tints every Nth voice in layout order (engine rule)', () => {
    // voice.ts: mul *= 2 when octaves >= 2 && (j+1) % octaves === 0
    expect(unisonFan(4, 1, 1, 2).map((s) => s.octave)).toEqual([false, true, false, true])
    expect(unisonFan(6, 1, 1, 3).map((s) => s.octave)).toEqual([false, false, true, false, false, true])
    // octaves < 2 never lifts (0 and 1 are both "off", like the engine)
    expect(unisonFan(4, 1, 1, 1).some((s) => s.octave)).toBe(false)
  })

  it('applies the engine clamps (unison 1..9 floored, curve 0.2..5, blend 0..1)', () => {
    expect(unisonFan(12, 1, 1, 0)).toHaveLength(9)
    expect(unisonFan(2.9, 1, 1, 0)).toHaveLength(2)
    expect(unisonFan(1, 1, 1, 0)).toEqual([{ x: 0, h: 1, octave: false }])
    const clamped = unisonFan(3, 0.1, -1, 0)
    expect(clamped.map((s) => s.x)).toEqual(unisonFan(3, 0.2, 0, 0).map((s) => s.x))
    expect(clamped[0]!.h).toBe(0) // blend clamped to 0
  })
})
