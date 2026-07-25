import { describe, expect, it } from 'vitest'
import { F, TimeSpan, hasOnset } from '@rondocode/pattern'
import { midiToRondocode } from '../src/midi/import'
import { evalCode } from '../src/session/evalCode'
import { baseScope } from '../src/session/scope'

/* The importer's whole contract is "emit ordinary rondocode you can edit" —
 * so the emitted source must pass the SAME evalCode + staging validation the
 * editor's Run button applies. These are round-trip tests: build a real SMF
 * in-test, import it, and eval the output. The historical bug pinned here:
 * the importer emitted `sidechain('kick', { duck: { bass, pad, ... } })` for
 * ANY file with drums, but evalCode (correctly) rejects a sidechain whose
 * source or duck-target synths are not defined — a hats-only drum track
 * defines no 'kick', and most files define only a few of the duck targets,
 * so the whole import failed to eval. */

// ---- a minimal multi-track (format 1) SMF byte-builder, adapted from the
// pattern package's midi.test.ts single-track builder ----

const vlq = (n: number): number[] => {
  const out = [n & 0x7f]
  n >>= 7
  while (n > 0) {
    out.unshift((n & 0x7f) | 0x80)
    n >>= 7
  }
  return out
}
const be32 = (n: number) => [(n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
const be16 = (n: number) => [(n >> 8) & 0xff, n & 0xff]
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0))

interface TrackSpec {
  name?: string
  notes: { pitch: number; start: number; dur: number; ch?: number }[]
}

/** Build a format-1 SMF (120 BPM, 4/4, ppq 480) from per-track note lists.
 *  Channel 9 marks a track as drums, exactly like real GM files. */
function buildSmf(tracks: TrackSpec[]): Uint8Array {
  const ppq = 480
  const usPerQ = Math.round(60_000_000 / 120)
  const chunks: number[] = [...ascii('MThd'), ...be32(6), ...be16(1), ...be16(tracks.length), ...be16(ppq)]
  tracks.forEach((t, ti) => {
    const events: { tick: number; bytes: number[] }[] = []
    if (ti === 0) {
      events.push({ tick: 0, bytes: [0xff, 0x51, 0x03, (usPerQ >> 16) & 0xff, (usPerQ >> 8) & 0xff, usPerQ & 0xff] })
      events.push({ tick: 0, bytes: [0xff, 0x58, 0x04, 4, 2, 24, 8] })
    }
    if (t.name !== undefined) events.push({ tick: 0, bytes: [0xff, 0x03, t.name.length, ...ascii(t.name)] })
    for (const n of t.notes) {
      const ch = n.ch ?? 0
      events.push({ tick: n.start, bytes: [0x90 | ch, n.pitch, 100] })
      events.push({ tick: n.start + n.dur, bytes: [0x80 | ch, n.pitch, 0] })
    }
    events.sort((a, b) => a.tick - b.tick)
    const td: number[] = []
    let last = 0
    for (const e of events) {
      td.push(...vlq(e.tick - last), ...e.bytes)
      last = e.tick
    }
    td.push(...vlq(0), 0xff, 0x2f, 0x00)
    chunks.push(...ascii('MTrk'), ...be32(td.length), ...td)
  })
  return new Uint8Array(chunks)
}

// GM drums on channel 9: 36 = kick, 42 = closed hat.
const DRUMS_WITH_KICK: TrackSpec = {
  name: 'drums',
  notes: [
    { pitch: 36, start: 0, dur: 60, ch: 9 },
    { pitch: 42, start: 240, dur: 60, ch: 9 },
    { pitch: 36, start: 960, dur: 60, ch: 9 },
  ],
}
const DRUMS_HATS_ONLY: TrackSpec = {
  name: 'drums',
  notes: [
    { pitch: 42, start: 0, dur: 60, ch: 9 },
    { pitch: 42, start: 480, dur: 60, ch: 9 },
  ],
}
const BASS_TRACK: TrackSpec = {
  name: 'bass',
  notes: [
    { pitch: 40, start: 0, dur: 480 },
    { pitch: 43, start: 480, dur: 480 },
  ],
}

/** Eval the emitted code the way the editor Run button would; assert clean. */
const evalsClean = (code: string) => {
  const r = evalCode(code, baseScope)
  expect(r.diagnostics.filter((d) => d.severity === 'error'), code).toEqual([])
  expect(r.ok).toBe(true)
  return r
}

describe('midiToRondocode → evalCode round-trip', () => {
  it('kit WITH a kick: emits a sidechain whose duck lists only emitted synths, and evals clean', () => {
    const { code } = midiToRondocode(buildSmf([DRUMS_WITH_KICK, BASS_TRACK]), { name: 'kit' })
    expect(code).toContain("sidechain('kick'")
    // only 'bass' exists among the melodic duck candidates, so only it may appear
    expect(code).toContain('duck: { bass: 0.7 }')
    for (const ghost of ['pad', 'keys', 'vox', 'flute', 'gtr', 'lead']) {
      expect(code).not.toContain(`${ghost}:`)
    }
    const r = evalsClean(code)
    expect(r.sidechain).toMatchObject({ source: 'kick', amounts: { bass: 0.7 } })
    expect(r.masterComp).toBeDefined()
    // and the imported patterns actually sound
    const span = new TimeSpan(F(0), F(2))
    for (const [name, pat] of r.patterns) {
      const sounding = pat
        .query(span)
        .filter(hasOnset)
        .filter((h) => typeof h.value.note === 'number' && typeof h.value.sound === 'string')
      expect(sounding.length, `pattern '${name}'`).toBeGreaterThanOrEqual(1)
    }
  })

  it('hats-only drums (no kick synth): emits NO sidechain and evals clean', () => {
    const { code } = midiToRondocode(buildSmf([DRUMS_HATS_ONLY, BASS_TRACK]), { name: 'hats' })
    expect(code).not.toContain('sidechain(')
    const r = evalsClean(code)
    expect(r.sidechain).toBeUndefined()
    expect(r.synths.has('hat')).toBe(true)
    expect(r.synths.has('kick')).toBe(false)
  })

  it('drums-only file (kick, zero melodic synths): skips the sidechain rather than ducking the kit, and evals clean', () => {
    const { code } = midiToRondocode(buildSmf([DRUMS_WITH_KICK]), { name: 'donly' })
    // no melodic duck target exists; an empty duck map would duck the OTHER
    // drums fully, so the importer must skip the line entirely
    expect(code).not.toContain('sidechain(')
    evalsClean(code)
  })

  it("voicing:'byRegister' output evals clean too (register synths are valid duck targets)", () => {
    const { code } = midiToRondocode(buildSmf([DRUMS_WITH_KICK, BASS_TRACK]), {
      name: 'reg',
      voicing: 'byRegister',
    })
    expect(code).toContain("sidechain('kick'")
    const r = evalsClean(code)
    expect(r.synths.has('bass')).toBe(true)
  })

  it('mix: false emits neither sidechain nor masterCompress and evals clean', () => {
    const { code } = midiToRondocode(buildSmf([DRUMS_WITH_KICK, BASS_TRACK]), { name: 'dry', mix: false })
    expect(code).not.toContain('sidechain(')
    expect(code).not.toContain('masterCompress(')
    const r = evalsClean(code)
    expect(r.masterComp).toBeUndefined()
  })
})
