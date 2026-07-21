import { hoverTooltip } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import { noteNameToMidi, parseChord } from '@rondocode/pattern'
import { stringCallName, syntacticContext } from './complete'

/* ------------------------------------------------------------------------- *
 * Note/chord hovercards: hovering a note name inside note('…') or a chord name
 * inside chord('…') pops a little piano keyboard with the key(s) lit, so you
 * can *see* the pitch(es). Resolution reuses the engine's own noteNameToMidi /
 * parseChord, so what you see is exactly what will sound.
 * ------------------------------------------------------------------------- */

const NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b']
const WHITE_PC = new Set([0, 2, 4, 5, 7, 9, 11])
const midiToName = (m: number): string => `${NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`

/** The note/chord token spanning `pos` (letters, digits, #, /, - ). */
const tokenAt = (doc: string, pos: number): { from: number; to: number; text: string } | null => {
  const ok = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9#/-]/.test(c)
  let from = pos
  let to = pos
  while (from > 0 && ok(doc[from - 1])) from--
  while (to < doc.length && ok(doc[to])) to++
  return from === to ? null : { from, to, text: doc.slice(from, to) }
}

/** Inline SVG piano keyboard covering the notes' range, active keys lit. */
const keyboardSvg = (notes: number[]): string => {
  const on = new Set(notes)
  const lo = Math.min(...notes)
  const hi = Math.max(...notes)
  let start = Math.floor(lo / 12) * 12 // C at/below the lowest note
  let end = Math.ceil((hi + 1) / 12) * 12 - 1 // B at/above the highest
  if (end - start < 11) end = start + 11 // at least one full octave
  const whites: number[] = []
  for (let m = start; m <= end; m++) if (WHITE_PC.has(m % 12)) whites.push(m)
  const whiteIdx = new Map<number, number>()
  whites.forEach((m, i) => whiteIdx.set(m, i))

  const W = 16
  const H = 56
  const BW = 10
  const BH = 34
  const parts: string[] = []
  whites.forEach((m, i) => {
    const fill = on.has(m) ? 'var(--c-accent)' : 'var(--c-raised)'
    parts.push(`<rect x="${i * W}" y="0" width="${W - 1}" height="${H}" rx="2" fill="${fill}" stroke="var(--c-border)"/>`)
  })
  for (let m = start; m <= end; m++) {
    if (WHITE_PC.has(m % 12)) continue
    const li = whiteIdx.get(m - 1) // black sits just right of the natural below it
    if (li === undefined) continue
    const x = (li + 1) * W - BW / 2
    const fill = on.has(m) ? 'var(--c-accent)' : 'var(--c-bg)'
    parts.push(`<rect x="${x}" y="0" width="${BW}" height="${BH}" rx="1.5" fill="${fill}" stroke="var(--c-border)"/>`)
  }
  return `<svg width="${whites.length * W}" height="${H}" viewBox="0 0 ${whites.length * W} ${H}">${parts.join('')}</svg>`
}

const card = (from: number, to: number, title: string, notes: number[]) => ({
  pos: from,
  end: to,
  above: true,
  create: () => {
    const dom = document.createElement('div')
    dom.className = 'cm-note-card'
    const head = document.createElement('div')
    head.className = 'cm-note-card-head'
    // For a single note the token IS the note name (e2 · e2 is noise); only
    // append the resolved names when they add something (chords, or a token
    // that normalizes to a different spelling).
    const names = notes.map(midiToName).join(' ')
    head.textContent = names.toLowerCase() === title.toLowerCase() ? title : `${title} · ${names}`
    const kb = document.createElement('div')
    kb.className = 'cm-note-card-kb'
    kb.innerHTML = keyboardSvg(notes) // generated markup only — no user HTML
    dom.append(head, kb)
    return { dom }
  },
})

/** Hover a note in note('…') or a chord in chord('…') → a piano hovercard. */
export function noteHover(): Extension {
  return hoverTooltip((view, pos) => {
    const state = view.state
    if (syntacticContext(state, pos) !== 'string') return null
    const call = stringCallName(state, pos)
    const tok = tokenAt(state.doc.toString(), pos)
    if (!tok) return null
    if (call === 'note') {
      const midi = noteNameToMidi(tok.text)
      return midi === undefined ? null : card(tok.from, tok.to, tok.text, [midi])
    }
    if (call === 'chord') {
      const notes = parseChord(tok.text)
      return notes ? card(tok.from, tok.to, tok.text, notes) : null
    }
    return null
  })
}
