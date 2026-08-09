import { describe, expect, it } from 'vitest'
import { stageCode, runPatterns, renderMix, mixOptsFor } from '../../server/src/render-runner'
import { runnableCodeBlocks } from '../src/docs/content'

/* ------------------------------------------------------------------------- *
 * A StageResult and MixOpts describe the same project, and eight MixOpts
 * fields are answered by the staged result alone. Every caller that copies
 * them by hand is a place a bounce can quietly stop matching what you heard.
 *
 * It has already happened twice. `cps` was optional and eight of ten callers
 * omitted it (#239). And `buses`/`sends` were passed by exactly ONE caller in
 * the repo, so every test that renders a doc program rendered it with its send
 * buses silently absent — including the guide section whose entire subject is
 * send buses. Both passed "makes sound" the whole time.
 *
 * mixOptsFor derives them. These tests are what stops the next field being
 * added to StageResult and forgotten here.
 * ------------------------------------------------------------------------- */

const SR = 22050

function staged(code: string) {
  const st = stageCode(code)
  expect(st.ok, 'program did not stage').toBe(true)
  return st as Extract<typeof st, { ok: true }>
}

/** RMS of the last quarter of a render — where a reverb tail lives. */
function tailRms(a: Float32Array): number {
  let s = 0
  const from = Math.floor(a.length * 0.75)
  for (let i = from; i < a.length; i++) s += a[i]! * a[i]!
  return Math.sqrt(s / (a.length - from))
}

const BUS_PROGRAM = `const pluck = synth(({ note, gate, adsr, saw }) =>
  saw(note.freq).mul(adsr(gate, { a: 0.002, d: 0.15, s: 0, r: 0.1 })).mul(0.5))

bus('space', ({ input, reverb }) => reverb(input, { roomSize: 0.9, damp: 0.3, mix: 1 }), { pluck: 0.9 })

p('pluck', n('0 ~ ~ ~').scale('a minor').sound('pluck'))
setCps(0.5)`

describe('mixOptsFor carries what the staged result knows', () => {
  it('threads the send buses, which nothing but resample() used to', () => {
    /* The regression, stated as a measurement: the same program rendered with
     * and without the derived options. If buses were dropped the two would be
     * identical, which is exactly what every doc-program test was doing. */
    const st = staged(BUS_PROGRAM)
    const evs = runPatterns(st.patterns, { cycles: 2, cps: 0.5 })
    const withBus = renderMix(st.synths, evs, 4, mixOptsFor(st, { sampleRate: SR }))
    const without = renderMix(st.synths, evs, 4, { cps: 0.5, sampleRate: SR })
    expect(tailRms(withBus.left), 'the bus never reached the render')
      .toBeGreaterThan(tailRms(without.left) * 2)
  })

  it('takes cps from the program rather than defaulting', () => {
    const st = staged(`p('a', n('0'))\nsetCps(0.31)`)
    expect(mixOptsFor(st).cps).toBe(0.31)
  })

  it('falls back to 0.5 when the program never set one', () => {
    expect(mixOptsFor(staged(`p('a', n('0'))`)).cps).toBe(0.5)
  })

  it('lets the caller override anything it derives', () => {
    const st = staged(`p('a', n('0'))\nsetCps(0.31)`)
    expect(mixOptsFor(st, { cps: 0.9 }).cps).toBe(0.9)
  })

  it('omits buses entirely when the program declares none', () => {
    // an empty Map would be harmless but noisy; absent is the honest shape
    expect(mixOptsFor(staged(`p('a', n('0'))`)).buses).toBeUndefined()
  })

  it('carries the master-bus settings a bounce needs to match the app', () => {
    const st = staged(`const a = synth(({ gate, adsr, sine }) => sine(220).mul(adsr(gate, {})))
p('a', n('0').sound('a'))
masterGain(-3)
masterCompress({ threshold: -8, ratio: 3, attack: 20, release: 120, knee: 4, makeup: 1 })
stereo({ width: 1.2, monoBelow: 110 })
sidechain('a', { depth: 0.5, release: 200 })`)
    const o = mixOptsFor(st)
    expect(o.masterGain, 'masterGain dropped').toBe(-3)
    expect(o.masterComp?.threshold, 'masterComp dropped').toBe(-8)
    expect(o.stereo?.width, 'stereo dropped').toBe(1.2)
    expect(o.sidechain?.source, 'sidechain dropped').toBe('a')
  })
})

describe('the guide sections that are ABOUT buses render with them', () => {
  /* The `sends` section teaches send buses. Rendering it without its bus and
   * asserting "it makes sound" was verifying the one thing that could not
   * fail. */
  const busBlocks = runnableCodeBlocks().filter((b) => /\bbus\(/.test(b.text))

  it('there are some, or this file is testing nothing', () => {
    expect(busBlocks.length).toBeGreaterThan(0)
  })

  for (const b of busBlocks) {
    it(`${b.id}: its bus changes the audio`, () => {
      const st = staged(b.text)
      expect(st.buses.size, 'the block declares no bus after staging').toBeGreaterThan(0)
      expect(st.sends.length, 'nothing is sent to the bus').toBeGreaterThan(0)
      const cps = st.cps ?? 0.5
      const evs = runPatterns(st.patterns, { cycles: 2, cps })
      const on = renderMix(st.synths, evs, 2 / cps, mixOptsFor(st, { cps, sampleRate: SR }))
      const off = renderMix(st.synths, evs, 2 / cps, { cps, sampleRate: SR })
      let diff = 0
      for (let i = 0; i < on.left.length; i++) diff += Math.abs(on.left[i]! - off.left[i]!)
      expect(diff / on.left.length, 'the bus made no difference to the mix').toBeGreaterThan(1e-5)
    })
  }
})
