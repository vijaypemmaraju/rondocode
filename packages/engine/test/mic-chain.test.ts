import { describe, expect, it } from 'vitest'
import { synth, renderOffline } from '../src/index'
import { goertzel } from './util/goertzel'

/* ------------------------------------------------------------------------- *
 * THE LIVE MIC CHANNEL STRIP, end to end.
 *
 * gate → de-esser → compressor → limiter over `mic()`, driven by a synthetic
 * voice that contains exactly the things a stage throws at it: room tone
 * between phrases, a loud vowel, a sibilant, and a peak that would go over
 * the ceiling.
 *
 * THIS COULD NOT BE TESTED AT ALL until now: mic() reads silence in an
 * offline render, so every node built for the live input was verified only in
 * isolation and the CHAIN never was. renderOffline now takes a `mic` signal,
 * which is what makes this file possible.
 *
 * The channel is kept open by a held note. That is worth stating because it
 * looked like it would be the hard part — a channel strip is not a voice, and
 * a voice is what mic() lives inside. Measured, it is a non-issue: with no
 * envelope on the spine, a held (or even a retriggered) note produces no gap
 * and no discontinuity — the largest sample-to-sample jump across a retrigger
 * is smaller than the signal's own slope.
 * ------------------------------------------------------------------------- */

const sr = 48000
const dbToLin = (db: number): number => Math.pow(10, db / 20)

const SEG = sr / 4 // 250 ms per section
const ROOM = 0, VOWEL = 1, SIB = 2, PEAK = 3
const TOTAL = SEG * 4

/** A synthetic take: room tone, a vowel, a sibilant, then something too loud. */
function voice(): Float32Array {
  const a = new Float32Array(TOTAL)
  let seed = 12345
  const rand = (): number => {
    // deterministic: a test that changes answer per run cannot pin anything
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return (seed / 0x7fffffff) * 2 - 1
  }
  for (let i = 0; i < TOTAL; i++) {
    const seg = Math.floor(i / SEG)
    if (seg === ROOM) {
      a[i] = rand() * dbToLin(-52) // room tone / kit bleed
    } else if (seg === VOWEL) {
      a[i] = dbToLin(-12) * Math.sin((2 * Math.PI * 220 * i) / sr)
    } else if (seg === SIB) {
      // a vowel WITH sibilance on top, which is what an "s" actually is
      a[i] = dbToLin(-16) * Math.sin((2 * Math.PI * 220 * i) / sr)
        + dbToLin(-10) * Math.sin((2 * Math.PI * 8000 * i) / sr)
    } else {
      a[i] = 2.2 * Math.sin((2 * Math.PI * 300 * i) / sr) // way over the ceiling
    }
  }
  return a
}

/** Render one chain over the take, holding the channel open for its length. */
function through(build: (ctx: any) => any, mic: Float32Array): Float32Array {
  const s = synth(build)
  return renderOffline(
    s,
    [{ time: 0, type: 'noteOn', note: 60 }, { time: TOTAL / sr - 0.001, type: 'noteOff', note: 60 }],
    TOTAL / sr,
    { mic },
  ).left
}

const peakOf = (a: Float32Array, from: number, to: number): number => {
  let p = 0
  for (let i = from; i < to; i++) p = Math.max(p, Math.abs(a[i]!))
  return p
}

describe('the live mic channel strip', () => {
  const take = voice()

  it('a held note keeps the channel open for the whole take — no gaps', () => {
    const out = through(({ mic }) => mic(), take)
    // every loud section must be present in the output
    for (const seg of [VOWEL, SIB, PEAK]) {
      expect(peakOf(out, seg * SEG + 1000, (seg + 1) * SEG - 1000), `segment ${seg}`)
        .toBeGreaterThan(0.01)
    }
  })

  it('the GATE removes the room tone and keeps the voice', () => {
    const dry = through(({ mic }) => mic(), take)
    const wet = through(
      ({ mic, noisegate }) => noisegate(mic(), { threshold: -40, range: -40, hold: 30, release: 40 }),
      take,
    )
    const roomDry = peakOf(dry, 1000, SEG - 1000)
    const roomWet = peakOf(wet, 1000, SEG - 1000)
    const vowelDry = peakOf(dry, VOWEL * SEG + 5000, (VOWEL + 1) * SEG - 1000)
    const vowelWet = peakOf(wet, VOWEL * SEG + 5000, (VOWEL + 1) * SEG - 1000)
    expect(roomWet, 'room tone survived the gate').toBeLessThan(roomDry * 0.2)
    expect(vowelWet, 'the gate ate the voice').toBeGreaterThan(vowelDry * 0.9)
  })

  it('the DE-ESSER takes down the sibilance and leaves the vowel under it', () => {
    const dry = through(({ mic }) => mic(), take)
    const wet = through(({ mic, deess }) => deess(mic(), { freq: 6000, threshold: -30, ratio: 8 }), take)
    const win = (a: Float32Array): Float32Array => a.subarray(SIB * SEG + 4000, (SIB + 1) * SEG - 1000)
    const sibDry = goertzel(win(dry), 8000, sr)
    const sibWet = goertzel(win(wet), 8000, sr)
    const vowDry = goertzel(win(dry), 220, sr)
    const vowWet = goertzel(win(wet), 220, sr)
    expect(sibWet, 'sibilance was not reduced').toBeLessThan(sibDry * 0.6)
    expect(vowWet, 'the vowel under the "s" was ducked with it').toBeGreaterThan(vowDry * 0.9)
  })

  it('the LIMITER holds the ceiling over the whole take', () => {
    const ceilDb = -1
    const out = through(
      ({ mic, limiter }) => limiter(mic(), { ceiling: ceilDb, lookahead: 5, release: 60 }),
      take,
    )
    expect(peakOf(out, 0, TOTAL), 'a sample went over the ceiling')
      .toBeLessThanOrEqual(dbToLin(ceilDb) + 1e-6)
  })

  it('the WHOLE strip: gated, de-essed, compressed, and under the ceiling', () => {
    const ceilDb = -1
    const out = through(
      ({ mic, noisegate, deess, compress, limiter }) =>
        limiter(
          compress(
            deess(
              noisegate(mic(), { threshold: -40, range: -40, hold: 30, release: 40 }),
              { freq: 6000, threshold: -30, ratio: 6 },
            ),
            { threshold: -18, ratio: 3, attack: 5, release: 80 },
          ),
          { ceiling: ceilDb, lookahead: 5, release: 60 },
        ),
      take,
    )
    const dry = through(({ mic }) => mic(), take)

    expect(out.every((v) => Number.isFinite(v)), 'the chain emitted a non-finite sample').toBe(true)
    // the ceiling is still a guarantee with four nodes in front of it
    expect(peakOf(out, 0, TOTAL), 'over the ceiling').toBeLessThanOrEqual(dbToLin(ceilDb) + 1e-6)
    // the room tone is gone
    expect(peakOf(out, 1000, SEG - 1000), 'room tone survived the strip')
      .toBeLessThan(peakOf(dry, 1000, SEG - 1000) * 0.3)
    // and the voice is still there
    expect(peakOf(out, VOWEL * SEG + 5000, (VOWEL + 1) * SEG - 1000), 'the strip ate the voice')
      .toBeGreaterThan(0.05)
  })

  it('the strip is DETERMINISTIC — the same take twice gives the same audio', () => {
    // a live chain that drifted between renders could not be bounced
    const chain = ({ mic, noisegate, limiter }: any): any =>
      limiter(noisegate(mic(), { threshold: -40 }), { ceiling: -1 })
    const a = through(chain, take)
    const b = through(chain, take)
    for (let i = 0; i < TOTAL; i += 97) expect(b[i]!).toBe(a[i]!)
  })
})
