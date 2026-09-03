import type { SchedulerEvent } from '@rondocode/pattern'
import { MASK_DRAW_INPUTS } from '@rondocode/rondo'
import { describe, expect, it } from 'vitest'
import { MaskMusic, levelOf, levelsOf, runDraw, silentFrame } from '../src/mask/music'
import { RHYTHM_BANDS } from '../src/mask/protocol'
import { MaskSpectrum } from '../src/mask/spectrum'
import type { SpectrumSource } from '../src/mask/spectrum'

/* The music a `draw` painter reads (mask/music.ts). Two clocks: the AUDIO
 * clock says when a hit lands and where the cycle is; the WALL clock drives
 * the decays and the easing. The tests hold both and step them by hand. */

const ev = (timeSec: number, controls: Record<string, unknown>, cycle?: number): SchedulerEvent =>
  ({ timeSec, durSec: 0.1, controls, ...(cycle !== undefined ? { cycle } : {}) }) as unknown as SchedulerEvent

const rig = (spectrum: MaskSpectrum | null = null): { music: MaskMusic; clock: { audio: number; wall: number } } => {
  const clock = { audio: 0, wall: 100 }
  const music = new MaskMusic({ now: () => clock.audio, wall: () => clock.wall, spectrum })
  music.frame() // the first frame has no last frame to measure from; prime it
  return { music, clock }
}

describe('MaskMusic', () => {
  it('names exactly the inputs the `draw` block unpacks', () => {
    // the rondo prelude (`const { … } = m`) and the frame are two copies of
    // one list; a field added to either without the other is a painter that
    // reads undefined, or a prelude that throws
    expect(Object.keys(silentFrame()).sort()).toEqual([...MASK_DRAW_INPUTS].sort())
    const { music } = rig()
    expect(Object.keys(music.frame()).sort()).toEqual([...MASK_DRAW_INPUTS].sort())
  })

  it('a hit lands on the audio clock and decays on the wall clock', () => {
    const { music, clock } = rig()
    music.setSynths(['kick', 'hat'])
    music.pushEvents([ev(1, { sound: 'kick', note: 36, gain: 0.8 })])
    // not yet: the event is in the future, and known synths read 0 meanwhile
    expect(music.frame().hit).toEqual({ kick: 0, hat: 0 })
    clock.audio = 1
    clock.wall += 0.016
    expect(music.frame().hit['kick']).toBeCloseTo(0.8 * Math.exp(-0.016 / 0.12), 6)
    // 80 ms later on the wall it has fallen by exp(-80/120) more
    clock.wall += 0.08
    expect(music.frame().hit['kick']).toBeCloseTo(0.8 * Math.exp(-0.096 / 0.12), 6)
    expect(music.frame().hit['hat']).toBe(0)
  })

  it('a hit is a note on a synth: automation, the mask lane and unnamed events open no gate', () => {
    const { music, clock } = rig()
    music.pushEvents([
      ev(0, { sound: 'bass', gain: 0.5 }), // a sound with no note: automation
      ev(0, { sound: 'mask', note: 1 }), // the mask's own lane
      ev(0, { note: 60 }), // no sound at all
    ])
    clock.wall += 0.016
    expect(music.frame().hit).toEqual({})
  })

  it('a second hit while one rings takes the louder, never adds', () => {
    const { music, clock } = rig()
    music.pushEvents([ev(0, { sound: 'kick', note: 36, gain: 0.9 }), ev(0, { sound: 'kick', note: 36, gain: 0.4 })])
    clock.wall += 0.001
    expect(music.frame().hit['kick']).toBeCloseTo(0.9 * Math.exp(-0.001 / 0.12), 6)
  })

  it('eases the meters: fast up, slow down, and the master and duck with them', () => {
    const { music, clock } = rig()
    music.setMeters({ channels: { bass: 1 }, master: 1, duck: 0.2 })
    clock.wall += 0.05
    const up = music.frame()
    expect(up.lvl['bass']).toBeGreaterThan(0.85) // 50 ms against a 22 ms attack
    expect(up.lvl['bass']).toBeLessThan(1)
    expect(up.level).toBeCloseTo(up.lvl['bass']!, 6)
    expect(up.duck).toBeLessThan(0.21) // the duck snaps down in 3 ms
    music.setMeters({ channels: { bass: 0 }, master: 0, duck: 1 })
    clock.wall += 0.05
    const down = music.frame()
    expect(down.lvl['bass']).toBeGreaterThan(0.5) // 50 ms against a 110 ms release
    expect(down.duck).toBeLessThan(0.9) // and releases over 45 ms
    expect(down.duck).toBeGreaterThan(0.5)
  })

  it('phase follows the audio clock and cycle the last event, rebased on play', () => {
    const { music, clock } = rig()
    music.setCps(0.5)
    music.setPlaying(true)
    clock.audio = 1
    expect(music.frame().phase).toBeCloseTo(0.5, 9)
    expect(music.frame().cycle).toBeCloseTo(0.5, 9)
    // an event carries the scheduler's own cycle number: the counter jumps to it
    music.pushEvents([ev(1, { sound: 'kick', note: 36 }, 7)])
    expect(music.frame().cycle).toBeCloseTo(7, 9)
    clock.audio = 3
    expect(music.frame().cycle).toBeCloseTo(8, 9)
    // stopped: the counter holds; a fresh start rebases it to now
    music.setPlaying(false)
    clock.audio = 9
    expect(music.frame().cycle).toBeCloseTo(8, 9)
    music.setPlaying(true)
    clock.audio = 10
    expect(music.frame().cycle).toBeCloseTo(0.5, 9)
  })

  it('a fresh start clears what was ringing and what was still to land', () => {
    const { music, clock } = rig()
    music.setPlaying(true)
    music.pushEvents([ev(0, { sound: 'kick', note: 36 }), ev(5, { sound: 'kick', note: 36 })])
    clock.wall += 0.016
    expect(music.frame().hit['kick']).toBeGreaterThan(0.5)
    music.setPlaying(false)
    music.setPlaying(true)
    clock.audio = 5
    clock.wall += 0.016
    expect(music.frame().hit).toEqual({})
  })

  it('spec is the spectrum 0..1 and beat its lowest bands, held then decayed', () => {
    const data = new Uint8Array(1024)
    const src: SpectrumSource = { frequencyBinCount: 1024, getByteFrequencyData: (out) => out.set(data) }
    const { music, clock } = rig(new MaskSpectrum(src, 48000))
    data[Math.round(100 / (48000 / 2048))] = 220 // 100 Hz: band 4, within beat's reach
    const f = music.frame()
    expect(f.spec.length).toBe(RHYTHM_BANDS)
    expect(f.spec[4]).toBe(1)
    expect(f.beat).toBe(1)
    data.fill(0)
    clock.wall += 0.09
    music.frame()
    clock.wall += 0.09
    const g = music.frame()
    expect(g.spec[4]).toBe(0)
    expect(g.beat).toBeCloseTo(Math.exp(-1), 6)
    // a high band alone is not a beat
    data[Math.round(8000 / (48000 / 2048))] = 220
    for (let k = 0; k < 20; k++) { clock.wall += 0.1; music.frame() }
    const h = music.frame()
    expect(h.spec[21]).toBe(1)
    expect(h.beat).toBeLessThan(0.01)
  })

  it('clamps a huge wall step, so a backgrounded tab does not snap everything at once', () => {
    const { music, clock } = rig()
    music.pushEvents([ev(0, { sound: 'kick', note: 36 })])
    clock.wall += 0.016
    music.frame()
    clock.wall += 30
    // the step is clamped to 100 ms: still ringing
    expect(music.frame().hit['kick']).toBeCloseTo(Math.exp(-0.116 / 0.12), 6)
  })
})

describe('runDraw', () => {
  const m = silentFrame()
  const nib = (a: Uint8Array): string => Array.from(a).join('')

  it('quantises 0..1 to 0..9, with booleans full or empty and nothing dark', () => {
    expect(levelOf(0)).toBe(0)
    expect(levelOf(1)).toBe(9)
    expect(levelOf(0.5)).toBe(5) // 4.5 rounds up
    expect(levelOf(0.049)).toBe(0)
    expect(levelOf(0.06)).toBe(1)
    expect(levelOf(2)).toBe(9)
    expect(levelOf(-1)).toBe(0)
    expect(levelOf(NaN)).toBe(0)
    expect(levelOf(Infinity)).toBe(9)
    const out = runDraw((i) => (i < 3 ? i / 2 : i < 5 ? i === 3 : i < 7 ? null : undefined), m)
    expect(nib(out)).toBe('059' + '90' + '00' + '0'.repeat(17))
  })

  it('calls the painter with the band, the band count and the music', () => {
    const seen: unknown[][] = []
    runDraw((...args) => { seen.push(args); return 0 }, m)
    expect(seen.length).toBe(RHYTHM_BANDS)
    expect(seen[0]).toEqual([0, RHYTHM_BANDS, m])
    expect(seen[23]).toEqual([23, RHYTHM_BANDS, m])
  })

  it('refuses any other answer, naming the band', () => {
    expect(() => runDraw((i) => (i === 5 ? 'tall' : 0), m)).toThrow(/band 5 returned a string/)
    expect(() => runDraw(() => ({}), m)).toThrow(/band 0 returned an object/)
    expect(() => runDraw(() => [1], m)).toThrow(/band 0 returned an object/)
  })

  it('levelsOf quantises a whole spectrum the same way', () => {
    const spec = new Float32Array(RHYTHM_BANDS)
    spec[0] = 1
    spec[1] = 0.5
    spec[23] = 0.3
    expect(nib(levelsOf(spec))).toBe('95' + '0'.repeat(21) + '3')
  })
})
