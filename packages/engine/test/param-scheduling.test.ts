import { describe, expect, it } from 'vitest'
import { BLOCK } from '../src/compile'
import { synth } from '../src/builder'
import { RealtimeEngine, SCOPE_POINTS } from '../src/realtime'
import type { DspContext } from '../src/dsp/types'

/* ------------------------------------------------------------------------- *
 * A PATTERNED PARAM USED TO ARRIVE BEFORE ITS NOTE.
 *
 * `setParam` carried no frame, so the engine applied it the moment the message
 * arrived, while the `noteOn` beside it was scheduled to an exact sample. The
 * scheduler queues up to a lookahead ahead, so the value landed up to ~100ms
 * early (measured at a steady 75ms through the real Session).
 *
 * That is audible rather than academic, for two reasons: a param is SYNTH-WIDE
 * and reaches every voice, so the change hit whatever was still ringing — you
 * heard the automation on the previous note; and the OFFLINE renderer has
 * always applied params on their exact sample, so a bounce never matched what
 * was playing.
 *
 * These assert the property that fixes it: the value the voice sees is the one
 * that belongs to the note sounding at that moment, to the sample.
 * ------------------------------------------------------------------------- */

const sr = 48000
const ctx: DspContext = { sampleRate: sr }

/** `gate * level`, so the output IS the param while a note is held. */
const graph = synth((c) => c.gate.mul(c.param('level', 0))).graph

const engine = (): RealtimeEngine => {
  const eng = new RealtimeEngine(ctx)
  eng.handleMessage({ kind: 'defineSynth', name: 'v', graph })
  return eng
}

/** Render `blocks` blocks and return the left channel, sample by sample. */
const render = (eng: RealtimeEngine, blocks: number): Float32Array => {
  const out = new Float32Array(blocks * BLOCK)
  const bl = new Float32Array(BLOCK)
  const br = new Float32Array(BLOCK)
  for (let b = 0; b < blocks; b++) {
    bl.fill(0)
    br.fill(0)
    eng.process(bl, br, eng.currentFrame)
    out.set(bl, b * BLOCK)
  }
  return out
}

/* The master bus applies a channel gain, an equal-power pan law and a master
 * gain, so a held `level` reaches the output scaled by a constant. Measure it
 * once rather than hard-coding it: these tests are about WHEN a value lands,
 * and pinning the mix constants here would make them fail for unrelated
 * reasons. */
const SCALE = (() => {
  const eng = engine()
  eng.handleMessage({ kind: 'setParam', synth: 'v', name: 'level', value: 1 })
  eng.handleMessage({ kind: 'noteOn', synth: 'v', note: 60 })
  const bl = new Float32Array(BLOCK)
  const br = new Float32Array(BLOCK)
  eng.process(bl, br, eng.currentFrame)
  return bl[BLOCK - 1]!
})()

/** The `level` a sample implies, undoing the fixed master-bus gain. */
const level = (v: number): number => v / SCALE

/** First sample at which the output changes by more than `eps`. */
const changeAt = (a: Float32Array, eps = 1e-4): number => {
  for (let i = 1; i < a.length; i++) if (Math.abs(a[i]! - a[i - 1]!) > eps) return i
  return -1
}

describe('setParam lands on its own frame', () => {
  it('a scheduled param takes effect at atFrame, not on arrival', () => {
    const eng = engine()
    eng.handleMessage({ kind: 'setParam', synth: 'v', name: 'level', value: 0.2 })
    eng.handleMessage({ kind: 'noteOn', synth: 'v', note: 60 })
    // both scheduled far ahead, sent NOW
    const at = 3 * BLOCK + 40
    eng.handleMessage({ kind: 'setParam', synth: 'v', name: 'level', value: 0.9, atFrame: at })
    const out = render(eng, 6)
    /* Before its frame the old value stands. Arrival-time application would
     * have jumped to 0.9 in block 0. */
    expect(out[BLOCK]!, 'changed before its frame').toBeCloseTo(out[10]!, 6)
    expect(changeAt(out), 'did not change on its own sample').toBe(at)
  })

  it('an UNSCHEDULED param still applies immediately', () => {
    /* A knob drag and a MIDI CC mean "now" and must not be deferred. */
    const eng = engine()
    eng.handleMessage({ kind: 'noteOn', synth: 'v', note: 60 })
    eng.handleMessage({ kind: 'setParam', synth: 'v', name: 'level', value: 0.5 })
    const out = render(eng, 2)
    expect(level(out[0]!)).toBeCloseTo(0.5, 4)
  })

  it('a param at the SAME frame as a note is in place when the gate opens', () => {
    /* Note the rank constants (noteOff < setParam < noteOn) mirror render.ts,
     * but this test does NOT depend on that order and cannot demonstrate it:
     * every event at a cursor fires before the segment is rendered, so the
     * param buffer is filled either way. Reordering them was measured to
     * change nothing. What IS load-bearing is that both land at this frame
     * rather than on arrival. */
    const eng = engine()
    const at = 2 * BLOCK + 17
    // sent AFTER the noteOn, so arrival order cannot be what puts it in place
    eng.handleMessage({ kind: 'noteOn', synth: 'v', note: 60, atFrame: at })
    eng.handleMessage({ kind: 'setParam', synth: 'v', name: 'level', value: 0.75, atFrame: at })
    const out = render(eng, 5)
    expect(out[at - 1]!, 'sounded before its note').toBe(0)
    expect(level(out[at]!), 'the note opened on the wrong value').toBeCloseTo(0.75, 4)
  })

  it('several notes each keep their own value, to the sample', () => {
    /* The reported symptom, as a property: with a synth-wide param, an early
     * change would show up on the PREVIOUS note. */
    const eng = engine()
    const step = BLOCK * 2
    const values = [0.1, 0.6, 0.3, 0.9]
    values.forEach((v, i) => {
      const at = step * (i + 1)
      eng.handleMessage({ kind: 'setParam', synth: 'v', name: 'level', value: v, atFrame: at })
      eng.handleMessage({ kind: 'noteOn', synth: 'v', note: 60, atFrame: at })
    })
    const out = render(eng, 12)
    values.forEach((v, i) => {
      const at = step * (i + 1)
      expect(level(out[at]!), `note ${i} opened wrong`).toBeCloseTo(v, 4)
      expect(level(out[at + step - 1]!), `note ${i} drifted before the next note`).toBeCloseTo(v, 4)
    })
  })

  it('a scheduled RAMP starts from its own frame', () => {
    const eng = engine()
    eng.handleMessage({ kind: 'noteOn', synth: 'v', note: 60 })
    eng.handleMessage({ kind: 'setParam', synth: 'v', name: 'level', value: 0 })
    const at = 2 * BLOCK
    const rampMs = (BLOCK * 4 / sr) * 1000
    eng.handleMessage({ kind: 'setParam', synth: 'v', name: 'level', value: 1, rampMs, atFrame: at })
    const out = render(eng, 10)
    expect(out[at - 1]!, 'ramp began early').toBeCloseTo(0, 5)
    const mid = level(out[at + BLOCK * 2]!)
    expect(mid, 'not ramping').toBeGreaterThan(0.2)
    expect(mid).toBeLessThan(0.8)
    expect(level(out[at + BLOCK * 5]!), 'never reached the target').toBeCloseTo(1, 2)
  })

  it('rejects a non-finite atFrame instead of scheduling nonsense', () => {
    const eng = engine()
    const errs: string[] = []
    eng.handleMessage({ kind: 'defineSynth', name: 'v', graph })
    const ev = eng as unknown as { onEvent?: (e: { kind: string; message?: string }) => void }
    ev.onEvent = (e) => { if (e.kind === 'error' && e.message !== undefined) errs.push(e.message) }
    eng.handleMessage({ kind: 'setParam', synth: 'v', name: 'level', value: 1, atFrame: NaN as number })
    expect(errs.join(' ')).toMatch(/atFrame/)
  })

  it('a param scheduled for a synth that is removed does not throw', () => {
    const eng = engine()
    eng.handleMessage({ kind: 'setParam', synth: 'v', name: 'level', value: 1, atFrame: 4 * BLOCK })
    eng.handleMessage({ kind: 'removeSynth', name: 'v' })
    expect(() => render(eng, 8)).not.toThrow()
  })
})

/* ------------------------------------------------------------------------- *
 * THE PER-SYNTH SCOPE TRACE.
 *
 * One signed peak per processed block, in a ring, emitted with the meters
 * event so the editor can draw each synth's own output beside its header. The
 * risk in a display like this is that it looks alive while showing nothing
 * real, so these check it against ACTUAL audio rather than against itself.
 * ------------------------------------------------------------------------- */

describe('per-synth scope trace', () => {
  const scopeOf = (eng: RealtimeEngine, name: string): Float32Array => {
    const ev = eng.collectMeters() as { scopes?: Record<string, Float32Array> }
    return ev.scopes![name]!
  }
  const span = (a: Float32Array): number => Math.max(...a) - Math.min(...a)

  it('is silent for a synth that is not playing', () => {
    const eng = engine()
    render(eng, 20)
    expect(span(scopeOf(eng, 'v'))).toBe(0)
  })

  it('follows the synth once a note sounds', () => {
    const eng = engine()
    eng.handleMessage({ kind: 'setParam', synth: 'v', name: 'level', value: 0.8 })
    eng.handleMessage({ kind: 'noteOn', synth: 'v', note: 60 })
    render(eng, 20)
    expect(span(scopeOf(eng, 'v'))).toBeGreaterThan(0.01)
  })

  it('tracks LEVEL, so a quieter synth draws a smaller trace', () => {
    /* The property that makes it a scope rather than decoration: it must not
     * auto-scale, or every synth would look equally loud. */
    const loud = engine()
    loud.handleMessage({ kind: 'setParam', synth: 'v', name: 'level', value: 0.9 })
    loud.handleMessage({ kind: 'noteOn', synth: 'v', note: 60 })
    render(loud, 20)
    const quiet = engine()
    quiet.handleMessage({ kind: 'setParam', synth: 'v', name: 'level', value: 0.1 })
    quiet.handleMessage({ kind: 'noteOn', synth: 'v', note: 60 })
    render(quiet, 20)
    expect(span(scopeOf(quiet, 'v'))).toBeLessThan(span(scopeOf(loud, 'v')) / 2)
  })

  it('has one point per synth channel, and only for synths that exist', () => {
    const eng = engine()
    render(eng, 4)
    const ev = eng.collectMeters() as { scopes?: Record<string, Float32Array> }
    expect(Object.keys(ev.scopes!)).toEqual(['v'])
    expect(ev.scopes!['v']!.length).toBe(SCOPE_POINTS)
  })

  it('is a HISTORY: one point per block, kept', () => {
    /* The ring must accumulate, not overwrite one slot. Freezing the write
     * head still produces a trace that CHANGES every frame (its single live
     * point moves), so comparing two snapshots proves nothing — the property
     * is that N sounding blocks leave N marks. */
    const eng = engine()
    eng.handleMessage({ kind: 'setParam', synth: 'v', name: 'level', value: 0.8 })
    eng.handleMessage({ kind: 'noteOn', synth: 'v', note: 60 })
    const BLOCKS = 9
    render(eng, BLOCKS)
    const nz = [...scopeOf(eng, 'v')].filter((v) => v !== 0).length
    expect(nz, 'the ring is holding one slot instead of a history').toBeGreaterThan(BLOCKS - 3)
  })

  it('SCROLLS: sound ages toward the start and eventually leaves the window', () => {
    const eng = engine()
    eng.handleMessage({ kind: 'setParam', synth: 'v', name: 'level', value: 0.8 })
    eng.handleMessage({ kind: 'noteOn', synth: 'v', note: 60 })
    render(eng, 6)
    eng.handleMessage({ kind: 'noteOff', synth: 'v', note: 60 })
    render(eng, 6)
    const firstNonZero = (a: Float32Array): number => a.findIndex((v) => v !== 0)
    const early = firstNonZero(scopeOf(eng, 'v'))
    expect(early, 'nothing in the window at all').toBeGreaterThanOrEqual(0)
    render(eng, 6)
    const later = firstNonZero(scopeOf(eng, 'v'))
    expect(later, 'the burst did not age toward the start').toBeLessThan(early)
    // and long enough after, it is gone entirely
    render(eng, SCOPE_POINTS + 5)
    expect([...scopeOf(eng, 'v')].every((v) => v === 0), 'stale audio never left the window').toBe(true)
  })

  it('never reports a non-finite sample to the host', () => {
    const eng = engine()
    eng.handleMessage({ kind: 'setParam', synth: 'v', name: 'level', value: 0.5 })
    eng.handleMessage({ kind: 'noteOn', synth: 'v', note: 60 })
    render(eng, 12)
    for (const v of scopeOf(eng, 'v')) expect(Number.isFinite(v)).toBe(true)
  })
})
