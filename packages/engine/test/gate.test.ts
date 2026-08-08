import { describe, expect, it } from 'vitest'
import { GateKernel, gateOpens } from '../src/dsp/gate'

/* A gate turns QUIET things down — the opposite of a compressor, and the
 * problem a live stage has. Two details separate a usable gate from one that
 * is worse than no gate at all, and both are pinned here:
 *
 *   HYSTERESIS — a single threshold makes a signal hovering at the line
 *     stutter open/shut at audio rate, which is far more audible than the
 *     noise being removed.
 *   HOLD — speech is full of momentary dips (the gap inside a "t"); without
 *     hold the gate slams on every one and chops the word apart.
 */

const sr = 48000
const dbToLin = (db: number): number => Math.pow(10, db / 20)

/** Run `seconds` of a constant-amplitude tone through the kernel, in blocks,
 *  and return the gain it settled on (out/in of the final sample). */
function drive(k: GateKernel, amp: number, seconds: number, sr2 = sr): number {
  const n = Math.round(seconds * sr2)
  const BLOCK = 128
  let last = 0
  let lastIn = 0
  for (let done = 0; done < n; done += BLOCK) {
    const len = Math.min(BLOCK, n - done)
    const input = new Float32Array(len)
    for (let i = 0; i < len; i++) input[i] = amp * Math.sin((2 * Math.PI * 220 * (done + i)) / sr2)
    const out = new Float32Array(len)
    k.process(len, { in: input }, out, { sampleRate: sr2 })
    // take the largest |out|/|in| in the block — a sine crosses zero, and
    // a ratio taken at a zero crossing is 0/0 noise rather than the gain
    for (let i = 0; i < len; i++) {
      if (Math.abs(input[i]!) > Math.abs(lastIn)) { lastIn = input[i]!; last = out[i]! }
    }
    lastIn = 0
    for (let i = 0; i < len; i++) {
      if (Math.abs(input[i]!) > Math.abs(lastIn)) { lastIn = input[i]!; last = out[i]! }
    }
  }
  return lastIn === 0 ? 0 : Math.abs(last / lastIn)
}

describe('gateOpens (the hysteresis decision)', () => {
  it('opens at the threshold', () => {
    expect(gateOpens(-40, -40, 3, false)).toBe(true)
    expect(gateOpens(-39, -40, 3, false)).toBe(true)
  })

  it('does NOT close until the level falls hysteresis dB below it', () => {
    // this is the whole point: between -43 and -40 the answer is "as you were"
    expect(gateOpens(-42, -40, 3, true), 'still open inside the band').toBe(true)
    expect(gateOpens(-44, -40, 3, true), 'below the band: closes').toBe(false)
  })

  it('a signal sitting IN the band does not flip state', () => {
    // the chatter case, stated directly: same level, both answers preserved
    expect(gateOpens(-41.5, -40, 3, true)).toBe(true)
    expect(gateOpens(-41.5, -40, 3, false)).toBe(false)
  })

  it('hysteresis 0 collapses to a single threshold', () => {
    expect(gateOpens(-40.5, -40, 0, true)).toBe(false)
  })

  it('a negative hysteresis is treated as 0, not as an inverted band', () => {
    expect(gateOpens(-40.5, -40, -5, true)).toBe(false)
  })
})

describe('GateKernel', () => {
  it('passes a signal above the threshold at unity', () => {
    const k = new GateKernel({ threshold: -40, attack: 0.5, hold: 0, release: 5 })
    expect(drive(k, dbToLin(-10), 0.2)).toBeCloseTo(1, 1)
  })

  it('attenuates a signal below the threshold by the RANGE', () => {
    const k = new GateKernel({ threshold: -30, range: -24, attack: 0.5, hold: 0, release: 5 })
    const g = drive(k, dbToLin(-60), 0.3)
    expect(20 * Math.log10(g)).toBeCloseTo(-24, 0)
  })

  it('range is attenuation, NOT mute — a gate you can hear is a gate set wrong', () => {
    const k = new GateKernel({ threshold: -30, range: -20, attack: 0.5, hold: 0, release: 5 })
    expect(drive(k, dbToLin(-60), 0.3), 'must not reach silence').toBeGreaterThan(0.05)
  })

  it('starts CLOSED, so no block of bleed escapes before it engages', () => {
    const k = new GateKernel({ threshold: -30, range: -60, attack: 50, hold: 0, release: 50 })
    const input = new Float32Array(128).fill(dbToLin(-60))
    const out = new Float32Array(128)
    k.process(128, { in: input }, out, { sampleRate: sr })
    expect(Math.abs(out[0]!)).toBeLessThan(Math.abs(input[0]!) * 0.01)
  })

  it('HOLD keeps it open across a momentary dip, so a word is not chopped', () => {
    /* The release has to be SHORT relative to the dip, or the comparison
     * proves nothing: with a 200 ms release, 20 ms of closing barely moves the
     * gain and both gates look identical whether hold works or not. */
    const open = { threshold: -30, range: -60, attack: 0.5, release: 8, hysteresis: 3 }
    const withHold = new GateKernel({ ...open, hold: 100 })
    const noHold = new GateKernel({ ...open, hold: 0 })
    for (const k of [withHold, noHold]) drive(k, dbToLin(-10), 0.2) // open it
    // a 40 ms dip — well inside the 100 ms hold, well past the 8 ms release
    const held = drive(withHold, dbToLin(-60), 0.04)
    const dropped = drive(noHold, dbToLin(-60), 0.04)
    expect(held, 'hold should still be passing').toBeGreaterThan(0.5)
    expect(dropped, 'without hold it should have closed').toBeLessThan(0.1)
    expect(held).toBeGreaterThan(dropped * 5)
  })

  it('closes once the hold expires', () => {
    const k = new GateKernel({ threshold: -30, range: -60, attack: 0.5, hold: 20, release: 20 })
    drive(k, dbToLin(-10), 0.2)
    expect(drive(k, dbToLin(-70), 0.5), 'well past hold + release').toBeLessThan(0.05)
  })

  it('does not chatter on a signal parked at the threshold', () => {
    /* The failure this node exists to avoid. At exactly the threshold with
     * hysteresis, the gate picks a state and STAYS there; the gain trace must
     * not oscillate. Measured as: the gain never reverses direction more than
     * a couple of times over a long steady input. */
    const k = new GateKernel({ threshold: -30, range: -40, attack: 1, hold: 10, release: 10, hysteresis: 4 })
    const amp = dbToLin(-30)
    const n = sr / 2
    const input = new Float32Array(n)
    for (let i = 0; i < n; i++) input[i] = amp * Math.sin((2 * Math.PI * 220 * i) / sr)
    const out = new Float32Array(n)
    k.process(n, { in: input }, out, { sampleRate: sr })
    // envelope of the output, sampled coarsely, must be monotone-ish
    const step = 2048
    const env: number[] = []
    for (let i = 0; i + step <= n; i += step) {
      let pk = 0
      for (let j = i; j < i + step; j++) pk = Math.max(pk, Math.abs(out[j]!))
      env.push(pk)
    }
    let reversals = 0
    for (let i = 2; i < env.length; i++) {
      const a = Math.sign(env[i]! - env[i - 1]!)
      const b = Math.sign(env[i - 1]! - env[i - 2]!)
      if (a !== 0 && b !== 0 && a !== b) reversals++
    }
    expect(reversals, 'the gain oscillated — that is chatter').toBeLessThan(3)
  })

  it('never emits a non-finite sample, even fed NaN', () => {
    const k = new GateKernel({})
    const input = new Float32Array(128).fill(NaN)
    const out = new Float32Array(128)
    k.process(128, { in: input }, out, { sampleRate: sr })
    k.process(128, { in: new Float32Array(128).fill(0.5) }, out, { sampleRate: sr })
    expect(out.every((v) => Number.isFinite(v)), 'a NaN poisoned the state').toBe(true)
  })

  it('reset() closes it again', () => {
    const k = new GateKernel({ threshold: -30, range: -60, attack: 0.5, hold: 0, release: 0.5 })
    drive(k, dbToLin(-5), 0.1)
    k.reset()
    const input = new Float32Array(128).fill(dbToLin(-60))
    const out = new Float32Array(128)
    k.process(128, { in: input }, out, { sampleRate: sr })
    expect(Math.abs(out[0]!)).toBeLessThan(Math.abs(input[0]!) * 0.01)
  })

  it('works at 44.1k as well as 48k (the engine has both)', () => {
    for (const rate of [44100, 48000]) {
      const k = new GateKernel({ threshold: -30, range: -40, attack: 0.5, hold: 0, release: 5 })
      expect(drive(k, dbToLin(-6), 0.2, rate), `${rate}`).toBeCloseTo(1, 1)
    }
  })
})
