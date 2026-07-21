import { describe, expect, it } from 'vitest'
import { GATE_GAP_SEC, renderMix, runPatterns, stageCode } from '../src/render-runner'
import { duckReleaseCoeff } from '../../engine/src/index'
import { SECTIONS } from '../../app/src/docs/content'

/* Unit tests for the headless code→audio pipeline, hitting the pure
 * functions directly (faster and sharper than going through MCP — the
 * MCP-level behavior is pinned in render-tools.test.ts). */

/** Small but real program: two synths, two patterns, a tempo. */
const TWO_SYNTH_SOURCE = `
const ping = synth(({ note, gate, adsr, sine }) => {
  const env = adsr(gate, { a: 0.002, d: 0.1, s: 0, r: 0.05 })
  return sine(note.freq).mul(env)
})
const buzz = synth(({ note, gate, param, adsr, saw, svf }) => {
  const cutoff = param('cutoff', 900, { min: 100, max: 8000 })
  const env = adsr(gate, { a: 0.002, d: 0.2, s: 0.2, r: 0.1 })
  return svf(saw(note.freq), cutoff).mul(env)
})
p('melody', n('0 3').scale('a minor').sound('ping'))
p('bass', n('0').scale('a minor').sound('buzz').ctrl('cutoff', sine.range(400, 2000)))
setCps(1)
`

describe('docs guide snippets', () => {
  // Every fenced code block in the guide is a complete, playable program — so
  // it must stage cleanly against the exact browser vocabulary. This guards the
  // guide against DSL drift (a renamed global, a changed signature).
  const snippets = SECTIONS.flatMap((s) =>
    s.blocks.filter((b) => b.kind === 'code').map((b) => ({ id: s.id, code: b.text })),
  )
  it.each(snippets)('section "$id" snippet stages ok', ({ code }) => {
    const r = stageCode(code)
    if (!r.ok) {
      throw new Error(r.diagnostics.map((d) => `${d.line}:${d.col} ${d.message}`).join(' | '))
    }
    expect(r.ok).toBe(true)
  })
})

describe('stageCode', () => {
  it('stages synths, patterns and cps from good source', () => {
    const r = stageCode(TWO_SYNTH_SOURCE)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect([...r.synths.keys()]).toEqual(['ping', 'buzz'])
    expect([...r.patterns.keys()]).toEqual(['melody', 'bass'])
    expect(r.cps).toBe(1)
    expect(r.warnings).toEqual([])
  })

  it('returns positioned diagnostics for bad source, never partial staging', () => {
    const r = stageCode('const x = synth(\np("oops"')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.diagnostics.length).toBeGreaterThan(0)
    const d = r.diagnostics[0]!
    expect(d.severity).toBe('error')
    expect(d.line).toBeGreaterThanOrEqual(1)
    expect(d.col).toBeGreaterThanOrEqual(1)
    expect(d.source).toBe('eval')
  })

  it('omits cps when the source never calls setCps', () => {
    const r = stageCode("p('a', n('0').sound('x'))")
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.cps).toBeUndefined()
  })
})

describe('runPatterns', () => {
  it('routes events per synth and samples ctrl values as param events', () => {
    const staged = stageCode(TWO_SYNTH_SOURCE)
    if (!staged.ok) throw new Error('stage failed')
    const bySynth = runPatterns(staged.patterns, { cycles: 2, cps: 1 })
    expect([...bySynth.keys()].sort()).toEqual(['buzz', 'ping'])

    const ping = bySynth.get('ping')!
    // 2 events/cycle × 2 cycles, one noteOn + one noteOff each.
    expect(ping.filter((e) => e.type === 'noteOn')).toHaveLength(4)
    expect(ping.filter((e) => e.type === 'noteOff')).toHaveLength(4)
    expect(ping.filter((e) => e.type === 'param')).toHaveLength(0)

    const buzz = bySynth.get('buzz')!
    const params = buzz.filter((e) => e.type === 'param')
    expect(params).toHaveLength(2) // one cutoff sample per onset
    for (const p of params) {
      expect(p.name).toBe('cutoff')
      expect(p.value).toBeGreaterThanOrEqual(400)
      expect(p.value).toBeLessThanOrEqual(2000)
    }
  })

  it('cuts events at the cycle boundary', () => {
    const staged = stageCode("p('a', n('0 1 2 3').scale('c major').sound('s'))")
    if (!staged.ok) throw new Error('stage failed')
    const bySynth = runPatterns(staged.patterns, { cycles: 1, cps: 2 })
    expect(bySynth.get('s')!.filter((e) => e.type === 'noteOn')).toHaveLength(4)
  })

  it('leaves a gate gap between back-to-back same-note events (offs precede next ons)', () => {
    // Four identical notes filling the cycle: without the gap each noteOff
    // would land exactly on the next noteOn and envelopes never re-attack.
    const staged = stageCode("p('kick', note('c2 c2 c2 c2').sound('k'))")
    if (!staged.ok) throw new Error('stage failed')
    const evs = runPatterns(staged.patterns, { cycles: 1, cps: 1 }).get('k')!
    const ons = evs.filter((e) => e.type === 'noteOn')
    const offs = evs.filter((e) => e.type === 'noteOff')
    expect(ons).toHaveLength(4)
    expect(offs).toHaveLength(4)
    for (let i = 0; i < 3; i++) {
      // each off strictly precedes the NEXT on, by (about) the gate gap
      expect(offs[i]!.time).toBeLessThan(ons[i + 1]!.time)
      expect(ons[i + 1]!.time - offs[i]!.time).toBeCloseTo(GATE_GAP_SEC, 5)
    }
  })

  it('skips events without a sound or numeric note', () => {
    // A param-only pattern (no .sound) routes nowhere — normal, not an error.
    const staged = stageCode("p('sweep', n('0 1'))")
    if (!staged.ok) throw new Error('stage failed')
    expect(runPatterns(staged.patterns, { cycles: 1, cps: 1 }).size).toBe(0)
  })

  it('a slide note holds its gate PAST the next onset (303 tie); non-slide does not', () => {
    // Two half-cycle notes: the first slides, the second does not.
    const staged = stageCode("p('b', note('a2 c3').slide('1 0').sound('bass'))")
    if (!staged.ok) throw new Error('stage failed')
    const evs = runPatterns(staged.patterns, { cycles: 1, cps: 1 }).get('bass')!
    const ons = evs.filter((e) => e.type === 'noteOn').sort((a, b) => a.time - b.time)
    const offs = evs.filter((e) => e.type === 'noteOff').sort((a, b) => a.time - b.time)
    // note 1 (slide) noteOff comes AFTER note 2's onset -> gate stays held -> glide
    expect(offs[0]!.time).toBeGreaterThan(ons[1]!.time)
    // note 2 (no slide) noteOff comes before the cycle end, not extended
    expect(offs[1]!.time).toBeLessThan(1)
  })

  it('adaptive slide bridges a GAP to the next note (not just adjacent notes)', () => {
    // a2 slides but the next note c3 is 3 sixteenths away (rests between).
    const staged = stageCode("p('b', note('a2 ~ ~ c3').slide('1 0 0 0').sound('bass'))")
    if (!staged.ok) throw new Error('stage failed')
    const evs = runPatterns(staged.patterns, { cycles: 1, cps: 1 }).get('bass')!
    const on2 = evs.filter((e) => e.type === 'noteOn')[1]! // c3 at 0.75
    const off1 = evs.filter((e) => e.type === 'noteOff').sort((a, b) => a.time - b.time)[0]! // a2's
    expect(on2.time).toBeCloseTo(0.75, 5)
    // a2's gate is held all the way to c3's onset (bridging the gap), not just
    // its own quarter-note duration (~0.25) — that's the adaptive part.
    expect(off1.time).toBeGreaterThan(0.75)
    expect(off1.time).toBeLessThan(0.75 + 0.1)
  })
})

describe('renderMix', () => {
  it('renders per-synth stems with events and rms, silent synths reported as zero', () => {
    const staged = stageCode(TWO_SYNTH_SOURCE)
    if (!staged.ok) throw new Error('stage failed')
    const events = runPatterns(staged.patterns, { cycles: 1, cps: 1 })
    const mix = renderMix(staged.synths, events, 1.5)
    expect(mix.perSynth['ping']!.events).toBe(2)
    expect(mix.perSynth['ping']!.rms).toBeGreaterThan(0.001)
    expect(mix.perSynth['buzz']!.events).toBe(1)
    expect(mix.perSynth['buzz']!.rms).toBeGreaterThan(0.001)
    expect(mix.left.length).toBe(Math.round(1.5 * 48000))
  })

  it('peak-normalizes a hot mix to 0.89', () => {
    // Two full-scale-ish stems summed guarantee a peak over 0.89.
    const staged = stageCode(`
const a = synth(({ note, gate, adsr, sine }) => sine(note.freq).mul(adsr(gate, { a: 0.001, d: 0.5, s: 1, r: 0.1 })))
const b = synth(({ note, gate, adsr, sine }) => sine(note.freq).mul(adsr(gate, { a: 0.001, d: 0.5, s: 1, r: 0.1 })))
p('pa', note('c3').sound('a'))
p('pb', note('c3').sound('b'))
`)
    if (!staged.ok) throw new Error('stage failed')
    const events = runPatterns(staged.patterns, { cycles: 1, cps: 1 })
    const mix = renderMix(staged.synths, events, 1.2)
    expect(mix.normalized).toBe(true)
    let peak = 0
    for (let i = 0; i < mix.left.length; i++) {
      peak = Math.max(peak, Math.abs(mix.left[i]!), Math.abs(mix.right[i]!))
    }
    expect(peak).toBeCloseTo(0.89, 3)
  })

  it('master compressor reduces a hot mix (offline parity)', () => {
    const staged = stageCode(`
const a = synth(({ note, gate, adsr, sine }) => sine(note.freq).mul(adsr(gate, { a: 0.001, d: 0.5, s: 1, r: 0.1 })).mul(0.6))
p('pa', note('c3').sound('a'))
`)
    if (!staged.ok) throw new Error('stage failed')
    const events = runPatterns(staged.patterns, { cycles: 1, cps: 1 })
    const rms = (x: Float32Array): number => {
      let s = 0
      for (let i = 0; i < x.length; i++) s += x[i]! * x[i]!
      return Math.sqrt(s / x.length)
    }
    const base = renderMix(staged.synths, events, 1.2)
    const comped = renderMix(staged.synths, events, 1.2, {
      masterComp: { threshold: -30, ratio: 10, attack: 5, release: 50, knee: 6, makeup: 0 },
    })
    // neither is peak-normalized here, so the comp's reduction is visible
    expect(base.normalized).toBe(false)
    expect(rms(comped.left)).toBeLessThan(rms(base.left) * 0.9)
    expect(rms(comped.left)).toBeGreaterThan(0)
  })

  it('routes sends through a shared bus, adding a reverb tail past the dry note (offline parity)', () => {
    const src = (sendAmt: string) => `
const a = synth(({ note, gate, adsr, sine }) => sine(note.freq).mul(adsr(gate, { a: 0.001, d: 0.05, s: 0, r: 0.05 })).mul(0.5))
p('pa', note('c4').sound('a'))
bus('space', ({ input, reverb }) => reverb(input, { roomSize: 0.9 }), { a: ${sendAmt} })
`
    const rmsTail = (x: Float32Array, from: number): number => {
      let s = 0
      let cnt = 0
      for (let i = from; i < x.length; i++) {
        s += x[i]! * x[i]!
        cnt++
      }
      return Math.sqrt(s / cnt)
    }
    // The dry note is fully released well before 0.5s; measure the tail after it.
    const dur = 1.5
    const sr = 48000
    const tailFrom = Math.round(0.5 * sr)

    const dry = stageCode(src('0'))
    const wet = stageCode(src('0.8'))
    if (!dry.ok || !wet.ok) throw new Error('stage failed')

    const dryEvents = runPatterns(dry.patterns, { cycles: 1, cps: 1 })
    const wetEvents = runPatterns(wet.patterns, { cycles: 1, cps: 1 })
    const dryMix = renderMix(dry.synths, dryEvents, dur, { sampleRate: sr, buses: dry.buses, sends: dry.sends })
    const wetMix = renderMix(wet.synths, wetEvents, dur, { sampleRate: sr, buses: wet.buses, sends: wet.sends })

    // With a send, the reverb bus rings on after the dry note has gone silent.
    expect(rmsTail(wetMix.left, tailFrom)).toBeGreaterThan(rmsTail(dryMix.left, tailFrom) + 1e-4)
  })

  it('leaves a quiet mix untouched and skips unknown sounds', () => {
    const staged = stageCode(`
const soft = synth(({ note, gate, adsr, sine }) => sine(note.freq).mul(adsr(gate, { a: 0.01, d: 0.1, s: 0, r: 0.1 })).mul(0.1))
p('a', note('c4').sound('soft'))
p('typo', note('c4').sound('sofft'))
`)
    if (!staged.ok) throw new Error('stage failed')
    const events = runPatterns(staged.patterns, { cycles: 1, cps: 1 })
    const mix = renderMix(staged.synths, events, 1.2)
    expect(mix.normalized).toBe(false)
    expect(Object.keys(mix.perSynth)).toEqual(['soft']) // no entry for the typo
    expect(mix.perSynth['soft']!.rms).toBeGreaterThan(0)
    expect(mix.perSynth['soft']!.rms).toBeLessThan(0.2)
  })

  /* A quiet source (kick) that TRIGGERS the duck plus a loud sustained target
   * (pad) held across the cycle. The mix is dominated by the pad, so ducking
   * the pad shows up directly in the summed mix. */
  const SC_SOURCE = `
const kick = synth(({ gate, adsr, sine }) => {
  const amp = adsr(gate, { a: 0.001, d: 0.05, s: 0, r: 0.02 })
  return sine(60).mul(amp).mul(0.02)
})
const pad = synth(({ note, gate, adsr, saw }) => {
  const env = adsr(gate, { a: 0.005, d: 0.1, s: 1, r: 0.2 })
  return saw(note.freq).mul(env).mul(0.5)
})
p('kick', note('c2*4').sound('kick'))
p('pad', note('c3').sound('pad').dur(1))
setCps(1)
`
  const winRms = (x: Float32Array, y: Float32Array, fromSec: number, toSec: number, sr = 48000): number => {
    const from = Math.round(fromSec * sr)
    const to = Math.round(toSec * sr)
    let s = 0
    for (let i = from; i < to; i++) s += x[i]! * x[i]! + y[i]! * y[i]!
    return Math.sqrt(s / (2 * (to - from)))
  }

  describe('sidechain duck', () => {
    it('ducks the target right after a kick and it recovers by mid-beat; flat without it', () => {
      const staged = stageCode(SC_SOURCE)
      if (!staged.ok) throw new Error('stage failed')
      const events = runPatterns(staged.patterns, { cycles: 1, cps: 1 })
      const sc = { source: 'kick', depth: 0.7, releaseMs: 120 }
      // Kicks land at 0, 0.25, 0.5, 0.75s. Sample just after the 0.25 kick
      // (ducked) vs midway to the next hit (recovered).
      const ducked = renderMix(staged.synths, events, 1.5, { sidechain: sc })
      const afterHit = winRms(ducked.left, ducked.right, 0.26, 0.30)
      const midway = winRms(ducked.left, ducked.right, 0.40, 0.46)
      expect(afterHit).toBeLessThan(midway * 0.75)

      const flat = renderMix(staged.synths, events, 1.5)
      const fAfter = winRms(flat.left, flat.right, 0.26, 0.30)
      const fMid = winRms(flat.left, flat.right, 0.40, 0.46)
      expect(Math.abs(fAfter - fMid)).toBeLessThan(fMid * 0.1) // flat, no duck
    })

    it('leaves the source stem untouched (only non-source stems duck)', () => {
      // Render the kick alone with the sidechain armed: its own stem must not
      // be ducked by its own hits.
      const staged = stageCode(SC_SOURCE)
      if (!staged.ok) throw new Error('stage failed')
      const events = runPatterns(staged.patterns, { cycles: 1, cps: 1 })
      const kickOnly = new Map([['kick', events.get('kick')!]])
      const withSc = renderMix(staged.synths, kickOnly, 1.5, {
        sidechain: { source: 'kick', depth: 0.9, releaseMs: 120 },
      })
      const without = renderMix(staged.synths, kickOnly, 1.5)
      expect(withSc.perSynth['kick']!.rms).toBeCloseTo(without.perSynth['kick']!.rms, 6)
    })

    it('per-stem amount changes the offline duck depth (0.3 dips less than 1.0)', () => {
      const staged = stageCode(SC_SOURCE)
      if (!staged.ok) throw new Error('stage failed')
      const events = runPatterns(staged.patterns, { cycles: 1, cps: 1 })
      const base = { source: 'kick', depth: 0.8, releaseMs: 120 }
      const full = renderMix(staged.synths, events, 1.5, { sidechain: { ...base, amounts: { pad: 1 } } })
      const lite = renderMix(staged.synths, events, 1.5, { sidechain: { ...base, amounts: { pad: 0.3 } } })
      // just after the 0.25s kick: the lite pad ducks far less than the full pad
      const fullAfter = winRms(full.left, full.right, 0.255, 0.275)
      const liteAfter = winRms(lite.left, lite.right, 0.255, 0.275)
      expect(liteAfter).toBeGreaterThan(fullAfter * 1.5)
      // an unlisted synth still ducks fully (default amount 1): omitting pad
      // matches amounts:{pad:1}
      const dflt = renderMix(staged.synths, events, 1.5, { sidechain: { ...base } })
      const dfltAfter = winRms(dflt.left, dflt.right, 0.255, 0.275)
      expect(dfltAfter).toBeCloseTo(fullAfter, 6)
    })

    it('uses the engine duck coefficient (live==offline by construction)', () => {
      const sr = 48000
      const expected = 1 - Math.exp(-1 / ((180 / 1000) * sr))
      expect(duckReleaseCoeff(180, sr)).toBeCloseTo(expected, 12)
    })

    it('surfaces the staged sidechain config from source', () => {
      const staged = stageCode(`sidechain('kick', { depth: 0.7 })\n${SC_SOURCE}`)
      expect(staged.ok).toBe(true)
      if (!staged.ok) return
      expect(staged.sidechain).toEqual({ source: 'kick', depth: 0.7, releaseMs: 180 })
    })
  })

  it('is deterministic: identical inputs produce identical samples', () => {
    const staged = stageCode(TWO_SYNTH_SOURCE)
    if (!staged.ok) throw new Error('stage failed')
    const run = (): Float32Array => {
      const events = runPatterns(staged.patterns, { cycles: 1, cps: 1 })
      return renderMix(staged.synths, events, 1.5).left
    }
    expect(run()).toEqual(run())
  })
})

describe('renderMix: per-synth FX post-chain (offline == live path)', () => {
  // Confirms synth(voiceFn, postFn) flows through evalCode/stageCode untouched
  // (synth is in scope; the 2nd arg just passes through) AND that renderMix
  // runs the PostChain over the summed stem — a shared reverb tail offline.
  const POST_SOURCE = `
const pluck = synth(
  ({ note, gate, adsr, sine }) => sine(note.freq).mul(adsr(gate, { a: 0.002, d: 0.05, s: 0, r: 0.02 })),
  ({ input, reverb }) => input.mix(reverb(input), 0.6),
)
const dry = synth(({ note, gate, adsr, sine }) => sine(note.freq).mul(adsr(gate, { a: 0.002, d: 0.05, s: 0, r: 0.02 })))
p('a', note('c4').sound('pluck'))
p('b', note('c4').sound('dry'))
`

  const tailRms = (x: Float32Array, fromSec: number, sr = 48000): number => {
    const from = Math.floor(fromSec * sr)
    let s = 0
    for (let i = from; i < x.length; i++) s += x[i]! * x[i]!
    return Math.sqrt(s / (x.length - from))
  }

  it('stages a post synth and renders a reverb tail the dry synth lacks', () => {
    const staged = stageCode(POST_SOURCE)
    expect(staged.ok).toBe(true)
    if (!staged.ok) return
    expect(staged.synths.get('pluck')!.post).toBeDefined()
    expect(staged.synths.get('dry')!.post).toBeUndefined()

    // Render each synth ALONE so the tail is attributable.
    const evPluck = runPatterns(new Map([['a', staged.patterns.get('a')!]]), { cycles: 1, cps: 1 })
    const evDry = runPatterns(new Map([['b', staged.patterns.get('b')!]]), { cycles: 1, cps: 1 })
    const wet = renderMix(staged.synths, evPluck, 1.0)
    const dry = renderMix(staged.synths, evDry, 1.0)
    // well after the note (dry has decayed), the post synth still rings
    const wetTail = tailRms(wet.left, 0.4)
    const dryTail = tailRms(dry.left, 0.4)
    expect(wetTail).toBeGreaterThan(1e-4)
    expect(wetTail).toBeGreaterThan(dryTail * 5)
  })

  it('is deterministic with a post chain', () => {
    const staged = stageCode(POST_SOURCE)
    if (!staged.ok) throw new Error('stage failed')
    const run = (): Float32Array => {
      const ev = runPatterns(staged.patterns, { cycles: 1, cps: 1 })
      return renderMix(staged.synths, ev, 1.0).left
    }
    expect(run()).toEqual(run())
  })
})
