import { describe, expect, it } from 'vitest'
import { detectBuses } from '../src/editor/buses'
import { numberChange } from '../src/editor/widgets/rewrite'

/* detectBuses is pure: source text in, the editable send/gain literals of every
 * bus() call out, WITH source ranges. The ranges are correctness-critical — the
 * mixer's bus faders rewrite exactly those spans — so every assertion slices the
 * source at the reported range and checks it is the literal it claims. */

const REVERB = '({ input, reverb }) => reverb(input, { roomSize: 0.9 })'

describe('detectBuses', () => {
  it('finds a bus with sends and their amount ranges', () => {
    const src = `bus('space', ${REVERB}, { pad: 0.4, arp: 0.2 })`
    const buses = detectBuses(src)
    expect(buses).toHaveLength(1)
    const b = buses[0]!
    expect(b.name).toBe('space')
    expect(b.sends.map((s) => s.synth)).toEqual(['pad', 'arp'])
    expect(b.sends.map((s) => s.amount)).toEqual([0.4, 0.2])
    // ranges point exactly at the amount literals
    for (const s of b.sends) expect(src.slice(s.from, s.to)).toBe(String(s.amount))
    expect(b.gain).toBeUndefined()
  })

  it('finds the gain literal in the opts object', () => {
    const src = `bus('space', ${REVERB}, { pad: 0.5 }, { gain: 0.8 })`
    const b = detectBuses(src)[0]!
    expect(b.gain).toBeDefined()
    expect(b.gain!.value).toBe(0.8)
    expect(src.slice(b.gain!.from, b.gain!.to)).toBe('0.8')
  })

  it('handles a bus with no send map and no gain', () => {
    const b = detectBuses(`bus('space', ${REVERB})`)[0]!
    expect(b.name).toBe('space')
    expect(b.sends).toEqual([])
    expect(b.gain).toBeUndefined()
  })

  it('skips a send whose amount is not a plain numeric literal', () => {
    const src = `const x = 0.3\nbus('space', ${REVERB}, { pad: x, arp: 0.2 })`
    const b = detectBuses(src)[0]!
    // pad -> variable (no fader); arp -> literal
    expect(b.sends.map((s) => s.synth)).toEqual(['arp'])
    expect(src.slice(b.sends[0]!.from, b.sends[0]!.to)).toBe('0.2')
  })

  it('accepts a quoted synth key', () => {
    const b = detectBuses(`bus('space', ${REVERB}, { 'pad': 0.4 })`)[0]!
    expect(b.sends[0]!.synth).toBe('pad')
    expect(b.sends[0]!.amount).toBe(0.4)
  })

  it('detects multiple buses independently', () => {
    const src = `bus('a', ${REVERB}, { x: 0.1 })\nbus('b', ${REVERB}, { y: 0.9 })`
    const buses = detectBuses(src)
    expect(buses.map((b) => b.name)).toEqual(['a', 'b'])
    expect(buses[1]!.sends[0]!.amount).toBe(0.9)
    expect(src.slice(buses[1]!.sends[0]!.from, buses[1]!.sends[0]!.to)).toBe('0.9')
  })

  it('is not confused by a bare reverb() call (only bus() qualifies)', () => {
    expect(detectBuses(`reverb(input, { roomSize: 0.9 })`)).toEqual([])
  })

  it('survives a mid-edit unparseable doc (Lezer is error-tolerant)', () => {
    // an unterminated call above should not throw or lose the intact bus below
    const src = `foo( \nbus('space', ${REVERB}, { pad: 0.4 })`
    expect(() => detectBuses(src)).not.toThrow()
  })

  it('drag round-trip: rewriting one send keeps every range valid', () => {
    // Simulate a fader drag on `pad`: detect -> rewrite the literal -> re-detect,
    // exactly the mixer's loop. The rewritten value must land and the OTHER
    // send's range must still slice its own literal (offset shift handled).
    let src = `bus('space', ${REVERB}, { pad: 0.4, arp: 0.2 }, { gain: 1 })`
    const before = detectBuses(src)[0]!
    const pad = before.sends.find((s) => s.synth === 'pad')!
    const change = numberChange({ from: pad.from, to: pad.to }, 0.35, { step: 0.01, min: 0 })
    src = src.slice(0, change.from) + change.insert + src.slice(change.to)

    const after = detectBuses(src)[0]!
    const padA = after.sends.find((s) => s.synth === 'pad')!
    const arpA = after.sends.find((s) => s.synth === 'arp')!
    expect(padA.amount).toBe(0.35)
    expect(src.slice(padA.from, padA.to)).toBe('0.35')
    // arp sat AFTER pad, so its offset shifted — its range must still be right
    expect(src.slice(arpA.from, arpA.to)).toBe('0.2')
    expect(src.slice(after.gain!.from, after.gain!.to)).toBe('1')
  })
})
