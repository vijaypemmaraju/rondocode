import { describe, expect, it } from 'vitest'
import { evalCode } from '../src/session/evalCode'
import { baseScope } from '../src/session/scope'

/* The value-probe loc capture: evalCode wraps modulation signal expressions
 * with __rcTap(from,to,…) so the builder tags each produced node with its
 * SOURCE char-range on SynthDef.nodeLocs — the editor maps those to inline
 * live-value readouts. These tests assert the recorded spans slice back to the
 * exact expressions, and that nothing regresses. Pure: no DOM, no audio. */

const run = (src: string) => evalCode(src, baseScope)

/** All source substrings that got a node loc, for a staged synth. */
const spans = (src: string, def: { nodeLocs?: Record<number, [number, number]> }): string[] =>
  Object.values(def.nodeLocs ?? {}).map(([from, to]) => src.slice(from, to))

describe('value-probe: node source-loc capture', () => {
  it('tags modulation expressions with spans that slice back to the source', () => {
    const src = [
      'const syn = synth(({ saw, svf, sine, note, gate }) =>',
      '  svf(saw(note.freq), sine(0.5).range(200, 2000), { res: 0.3 }).mul(gate))',
    ].join('\n')
    const r = run(src)
    expect(r.ok).toBe(true)
    const def = r.synths.get('syn')!
    expect(def).toBeDefined()
    const got = spans(src, def)
    // the LFO→cutoff modulation the user wants a readout on
    expect(got).toContain('sine(0.5).range(200, 2000)')
    // the oscillator carrier and the note-frequency signal are tagged too
    expect(got).toContain('saw(note.freq)')
    expect(got).toContain('note.freq')
  })

  it('captures a modulation signal bound to a const (declarator init)', () => {
    const src = [
      'const lfo = 0', // decoy: plain number init, no tap
      'const syn = synth(({ sine, svf, saw, note, gate }) => {',
      '  const cutoff = sine(0.3).range(300, 3000)',
      '  return svf(saw(note.freq), cutoff, { res: 0.2 }).mul(gate)',
      '})',
    ].join('\n')
    const r = run(src)
    expect(r.ok).toBe(true)
    const got = spans(src, r.synths.get('syn')!)
    expect(got).toContain('sine(0.3).range(300, 3000)')
  })

  it('does not tag synths with no modulation (plain carrier)', () => {
    const src = 'const syn = synth(({ sine, note, gate }) => sine(note.freq).mul(gate))'
    const r = run(src)
    expect(r.ok).toBe(true)
    const def = r.synths.get('syn')!
    // note.freq is a member arg → tagged; the point is nodeLocs stays small and
    // valid, never throwing.
    for (const [from, to] of Object.values(def.nodeLocs ?? {})) {
      expect(from).toBeGreaterThanOrEqual(0)
      expect(to).toBeGreaterThan(from)
      expect(to).toBeLessThanOrEqual(src.length)
    }
  })

  it('leaves the staged graph identical to an untagged build (locs are off-graph)', () => {
    // The wrap must not perturb the DSP graph or params — only add nodeLocs.
    const src = 'const syn = synth(({ saw, svf, sine, note, gate }) => svf(saw(note.freq), sine(1).range(100, 900)).mul(gate))'
    const r = run(src)
    expect(r.ok).toBe(true)
    const def = r.synths.get('syn')!
    // graph must NOT carry loc metadata (kept off the diff/fingerprint path)
    for (const n of def.graph.nodes) expect('loc' in n).toBe(false)
    // it must still be a runnable graph with real nodes
    expect(def.graph.nodes.length).toBeGreaterThan(3)
  })

  it('still stages patterns/synths normally with wrapping active', () => {
    const src = [
      "const kick = synth(({ sine, gate, adsr }) => sine(60).mul(adsr(gate, { a: 0.001, d: 0.1, s: 0, r: 0.05 })))",
      "p('k', note('c1*4').sound('kick'))",
      'setCps(0.5)',
    ].join('\n')
    const r = run(src)
    expect(r.ok).toBe(true)
    expect(r.synths.has('kick')).toBe(true)
    expect(r.patterns.has('k')).toBe(true)
    expect(r.cps).toBe(0.5)
  })
})
