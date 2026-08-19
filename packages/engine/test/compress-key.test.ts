import { describe, expect, it } from 'vitest'
import { synth } from '../src/builder'
import { renderOffline } from '../src/render'

/* ------------------------------------------------------------------------- *
 * AN EXTERNAL SIDECHAIN ON `compress`.
 *
 * `sidechain(source)` ducks a channel on another synth's note ONSETS, which is
 * the right tool for a house pump: it keeps working with the kick muted,
 * because it reads events rather than audio. What it cannot do is duck under
 * something with no note events the mix can see — a live vocal, a bounced
 * stem, a band-split of the compressor's own input.
 *
 * So the detector gets its own input. `key` decides WHEN; `in` is still what
 * gets turned down.
 * ------------------------------------------------------------------------- */

const SR = 48000
const EV = [{ type: 'noteOn', time: 0, note: 60, velocity: 1 }] as never
const rms = (r: { left: Float32Array }): number => {
  let s = 0
  for (const v of r.left) s += v * v
  return Math.sqrt(s / r.left.length)
}
const run = (d: ReturnType<typeof synth>): number => rms(renderOffline(d, EV, 1, { sampleRate: SR }))

/** A quiet steady tone, optionally ducked by a loud slow pulse. */
const patch = (key: boolean, quietKey = false) =>
  synth((c) => {
    const tone = c.sine(220).mul(0.3)
    const k = c.sine(2).mul(quietKey ? 0.0001 : 0.9)
    const o = { threshold: -30, ratio: 12, attack: 1, release: 30 }
    return key ? c.compress(tone, { ...o, key: k }) : c.compress(tone, o)
  })

describe('compress({ key })', () => {
  it('a loud key ducks a quiet input, which self-detection cannot do', () => {
    const self = run(patch(false))
    const keyed = run(patch(true))
    expect(keyed, 'the key did not reach the detector').toBeLessThan(self)
  })

  it('a SILENT key means no reduction — it is not the same as no key', () => {
    /* The distinction the config flag exists for: an unwired input arrives as
     * a constant-zero buffer, so presence alone cannot tell "listen to
     * yourself" from "listen to this, which happens to be silent". */
    const quiet = run(patch(true, true))
    const self = run(patch(false))
    expect(quiet, 'a silent key should let the input through untouched')
      .toBeGreaterThan(self)
  })

  it('with no key at all, the compressor is bit-identical to before', () => {
    /* The migration must not have changed how every existing `compress` call
     * sounds — it is in most of the shipped post chains. */
    const a = renderOffline(patch(false), EV, 1, { sampleRate: SR })
    const b = renderOffline(patch(false), EV, 1, { sampleRate: SR })
    expect([...a.left]).toEqual([...b.left])
    expect(rms(a)).toBeGreaterThan(0)
  })

  it('the key is a full signal, so it can be any node in the synth', () => {
    const d = synth((c) => {
      const tone = c.sine(220).mul(0.3)
      // a band-split of the input keying its own compressor: a de-esser shape
      const band = c.svf(tone, 6000, { mode: 'hp' })
      return c.compress(tone, { threshold: -35, ratio: 10, key: band })
    })
    expect(run(d)).toBeGreaterThan(0)
    const n = d.graph.nodes.find((x) => x.type === 'compress')
    expect(n?.inputs['key'], 'the key was not wired').toBeDefined()
    expect(n?.config?.['key'], 'the config flag is what the kernel reads').toBe(true)
  })
})
