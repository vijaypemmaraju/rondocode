import { Pattern, reify } from './pattern'
import { TimeSpan, hap, hasOnset } from './types'
import type { Hap } from './types'
import { Fraction } from './fraction'
import { MiniError, miniParse } from './mini'
import { noteNameToMidi } from './scales'
import type { ControlMap } from './controls'

/* Chord & arpeggiator support: name chords (`chord('<Cmaj7 Am7 Dm7 G7>')`)
 * instead of hand-stacking notes, and spread a chord's notes over time with
 * `.arp('up')`. A chord name is root + quality (+ optional /bass); each name
 * expands to a STACK of note events at the same time. */

/** Chord qualities → semitone intervals from the root. Case matters for the
 *  M7/m7 shorthand; everything else is matched case-insensitively. */
const QUALITIES: Record<string, number[]> = {
  '': [0, 4, 7], // bare root = major
  maj: [0, 4, 7], major: [0, 4, 7], M: [0, 4, 7],
  min: [0, 3, 7], m: [0, 3, 7], minor: [0, 3, 7],
  dim: [0, 3, 6], aug: [0, 4, 8],
  '5': [0, 7], // power chord
  '6': [0, 4, 7, 9], m6: [0, 3, 7, 9], min6: [0, 3, 7, 9],
  '7': [0, 4, 7, 10], dom7: [0, 4, 7, 10],
  maj7: [0, 4, 7, 11], M7: [0, 4, 7, 11],
  m7: [0, 3, 7, 10], min7: [0, 3, 7, 10],
  m7b5: [0, 3, 6, 10], // half-diminished
  dim7: [0, 3, 6, 9],
  sus2: [0, 2, 7], sus4: [0, 5, 7], sus: [0, 5, 7], '7sus4': [0, 5, 7, 10],
  add9: [0, 4, 7, 14], madd9: [0, 3, 7, 14],
  '9': [0, 4, 7, 10, 14], maj9: [0, 4, 7, 11, 14], m9: [0, 3, 7, 10, 14],
  '11': [0, 4, 7, 10, 14, 17], m11: [0, 3, 7, 10, 14, 17],
  '13': [0, 4, 7, 10, 14, 21], m13: [0, 3, 7, 10, 14, 21],
}

// A trailing number after the root is the QUALITY (C7 = dom7), never an octave —
// chords sit in a fixed register (root octave 3); transpose with .add() if needed.
const CHORD_RE = /^([a-gA-G][#b]?)([^/]*)(?:\/([a-gA-G][#b]?))?$/

/** Parse a chord name to its midi notes (low→high), root in octave 3. Supports a
 *  slash bass (`Cmaj7/E` adds an E below the root). undefined if not a chord. */
export function parseChord(name: string): number[] | undefined {
  const m = CHORD_RE.exec(name.trim())
  if (!m) return undefined
  const root = noteNameToMidi(m[1]! + '3')
  if (root === undefined) return undefined
  const qual = m[2] ?? ''
  const iv = QUALITIES[qual] ?? QUALITIES[qual.toLowerCase()]
  if (iv === undefined) return undefined
  const notes = iv.map((x) => root + x)
  // slash bass: place the named pitch class below the root
  if (m[3] !== undefined) {
    const bass = noteNameToMidi(m[3] + '3')
    if (bass !== undefined) {
      let b = bass
      while (b >= notes[0]!) b -= 12
      notes.unshift(b)
    }
  }
  return notes
}

/** `chord('<Cmaj7 Am7>')` — a pattern of named chords, each expanded to a stack
 *  of note events. Also accepts a Pattern/array of chord-name strings. */
export function chord(x: string | Pattern<string>): Pattern<ControlMap> {
  if (typeof x === 'string') {
    const { pattern, atoms } = miniParse(x)
    for (const a of atoms) {
      if (typeof a.value === 'number' || parseChord(a.value) === undefined) {
        throw new MiniError(`'${a.value}' is not a chord (e.g. Cmaj7, Am, F#m7, Gsus4, C/E)`, a.loc.start, x)
      }
    }
    return new Pattern<ControlMap>((span) =>
      pattern.query(span).flatMap((h) => {
        const notes = parseChord(String(h.value.value))!
        return notes.map((nt) => hap(h.whole, h.part, { note: nt, loc: h.value.loc }))
      }),
    )
  }
  return reify(x).outerBind((name: string) => {
    const notes = parseChord(name)
    if (notes === undefined) throw new TypeError(`chord(): '${name}' is not a chord name`)
    return Pattern.stack(...notes.map((nt) => reify<ControlMap>({ note: nt })))
  })
}

/** Arp note-index orders for N chord notes (indices into the low→high stack). */
const ARP_ORDERS: Record<string, (n: number) => number[]> = {
  up: (n) => Array.from({ length: n }, (_, i) => i),
  down: (n) => Array.from({ length: n }, (_, i) => n - 1 - i),
  updown: (n) => {
    const a = Array.from({ length: n }, (_, i) => i)
    for (let i = n - 2; i > 0; i--) a.push(i)
    return a.length ? a : [0]
  },
  downup: (n) => {
    const a = Array.from({ length: n }, (_, i) => n - 1 - i)
    for (let i = 1; i < n - 1; i++) a.push(i)
    return a.length ? a : [0]
  },
  updowninc: (n) => [...Array.from({ length: n }, (_, i) => i), ...Array.from({ length: n }, (_, i) => n - 1 - i)],
  converge: (n) => {
    const a: number[] = []
    let lo = 0
    let hi = n - 1
    while (lo <= hi) {
      a.push(lo)
      if (lo !== hi) a.push(hi)
      lo++
      hi--
    }
    return a.length ? a : [0]
  },
}

const noteVal = (v: unknown): number =>
  v !== null && typeof v === 'object' && typeof (v as { note?: unknown }).note === 'number'
    ? (v as { note: number }).note
    : 0

declare module './pattern' {
  interface Pattern<T> {
    /** Arpeggiate: spread the notes that sound TOGETHER (a chord) across their
     *  step, in `mode` order. Modes: up, down, updown, downup, updowninc,
     *  converge. Best on a `chord(...)` pattern. */
    arp(this: Pattern<T>, mode?: string): Pattern<T>
  }
}

Pattern.prototype.arp = function <T>(this: Pattern<T>, mode = 'up'): Pattern<T> {
  const order = ARP_ORDERS[mode] ?? ARP_ORDERS['up']!
  return new Pattern<T>((span) => {
    const out: Hap<T>[] = []
    for (const cyc of span.cycleSpans()) {
      // group onset haps by their whole — haps sharing a whole are one chord
      const groups = new Map<string, Hap<T>[]>()
      for (const h of this.query(cyc)) {
        if (!hasOnset(h)) continue
        const w = h.whole!
        const key = `${w.begin.toString()}_${w.end.toString()}`
        let g = groups.get(key)
        if (!g) {
          g = []
          groups.set(key, g)
        }
        g.push(h)
      }
      for (const g of groups.values()) {
        g.sort((a, b) => noteVal(a.value) - noteVal(b.value)) // low→high
        const w = g[0]!.whole!
        const dur = w.end.sub(w.begin)
        const idx = order(g.length)
        const M = idx.length
        idx.forEach((noteIdx, slot) => {
          const s = w.begin.add(dur.mul(Fraction.of(slot, M)))
          const e = w.begin.add(dur.mul(Fraction.of(slot + 1, M)))
          const whole = new TimeSpan(s, e)
          const part = whole.intersection(cyc)
          if (part) out.push(hap(whole, part, g[noteIdx]!.value))
        })
      }
    }
    return out
  })
}
