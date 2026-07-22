/* ------------------------------------------------------------------------- *
 * Karaoke highlight: while a sung vocal plays, light up the CURRENT syllable in
 * the sing() lyrics AND the current note in the sing() notes, in sync with the
 * clip. The vocal is one clip per cycle, so the playhead phase (0..1) comes from
 * the sing trigger event's timeSec/durSec vs the audio clock; the phase maps to
 * a note index via the melody's note durations (one syllable per note).
 *
 * Parsing mirrors flash.ts: find each sing(voice, lyrics, notes) call via acorn,
 * take the lyrics + notes string literals (quoted OR backtick, escape-free so
 * offset math is exact), and tokenize each into per-slot document ranges.
 * ------------------------------------------------------------------------- */
import { StateEffect, StateField } from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import { Decoration, EditorView } from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'
import { parse } from 'acorn'
import type { SchedulerEvent } from '@rondocode/pattern'

interface Range {
  from: number
  to: number
}
interface SingCall {
  lyr: Range[]
  notes: Range[]
  bounds: number[] // normalized cumulative note-duration boundaries, length n+1 (0..1)
}

/** A string literal argument's document content-start + text, for Literal or a
 *  no-substitution template literal. null if it isn't one (or has escapes). */
function litContent(node: { type: string; [k: string]: unknown } | null, source: string): { docStart: number; text: string } | null {
  if (!node) return null
  const start = node['start'] as number
  const end = node['end'] as number
  if (node.type === 'Literal') {
    const v = (node as { value?: unknown }).value
    if (typeof v !== 'string') return null
    if (source.slice(start + 1, end - 1) !== v) return null
    return { docStart: start + 1, text: v }
  }
  if (node.type === 'TemplateLiteral') {
    const quasis = node['quasis'] as { value: { cooked?: string } }[]
    if ((node['expressions'] as unknown[]).length !== 0 || quasis.length !== 1) return null
    const cooked = quasis[0]!.value.cooked
    if (typeof cooked !== 'string') return null
    if (source.slice(start + 1, end - 1) !== cooked) return null
    return { docStart: start + 1, text: cooked }
  }
  return null
}

/** Per-slot [from,to) doc ranges for a lyrics string (words split on spaces,
 *  syllables on '-'; '~'/'_' are their own slots) — mirrors parseLyrics's slots. */
function lyricSlots(text: string, docStart: number): Range[] {
  const out: Range[] = []
  let i = 0
  while (i < text.length) {
    if (/\s/.test(text[i]!)) { i++; continue }
    let j = i
    while (j < text.length && !/\s/.test(text[j]!)) j++
    const tok = text.slice(i, j)
    if (tok === '~' || tok === '_') {
      out.push({ from: docStart + i, to: docStart + j })
    } else {
      let k = i
      for (const part of tok.split('-')) {
        if (part.length > 0) out.push({ from: docStart + k, to: docStart + k + part.length })
        k += part.length + 1 // skip the '-'
      }
    }
    i = j
  }
  return out
}

/** Per-note [from,to) doc ranges + weights for a notes string (whitespace-split;
 *  `@N` is a length multiplier). */
function noteSlots(text: string, docStart: number): { range: Range; weight: number }[] {
  const out: { range: Range; weight: number }[] = []
  let i = 0
  while (i < text.length) {
    if (/\s/.test(text[i]!)) { i++; continue }
    let j = i
    while (j < text.length && !/\s/.test(text[j]!)) j++
    const tok = text.slice(i, j)
    const m = tok.match(/@(\d+(?:\.\d+)?)/)
    out.push({ range: { from: docStart + i, to: docStart + j }, weight: m ? parseFloat(m[1]!) : 1 })
    i = j
  }
  return out
}

/** Every sing() call's syllable + note ranges (aligned, with phase boundaries).
 *  Skips a call whose syllable count ≠ note count (can't align them). */
export function parseSingCalls(source: string): SingCall[] {
  const out: SingCall[] = []
  let program: unknown
  try {
    program = parse(source, { ecmaVersion: 2022, sourceType: 'script' })
  } catch {
    return out
  }
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return
    const n = node as { type?: string; [k: string]: unknown }
    if (n.type === 'CallExpression') {
      const callee = n['callee'] as { type?: string; name?: string } | undefined
      const args = n['arguments'] as ({ type: string; [k: string]: unknown } | null)[] | undefined
      if (callee?.type === 'Identifier' && callee.name === 'sing' && args && args.length >= 3) {
        const lyr = litContent(args[1] ?? null, source)
        const nt = litContent(args[2] ?? null, source)
        if (lyr && nt) {
          const slots = lyricSlots(lyr.text, lyr.docStart)
          const notes = noteSlots(nt.text, nt.docStart)
          if (slots.length === notes.length && slots.length > 0) {
            const total = notes.reduce((a, b) => a + b.weight, 0)
            const bounds = [0]
            let acc = 0
            for (const nn of notes) { acc += nn.weight; bounds.push(acc / total) }
            out.push({ lyr: slots, notes: notes.map((x) => x.range), bounds })
          }
        }
      }
    }
    for (const k in n) {
      const v = n[k]
      if (Array.isArray(v)) v.forEach(visit)
      else if (v && typeof v === 'object') visit(v)
    }
  }
  visit(program)
  return out
}

/** Note index active at normalized phase p (0..1), or -1. */
function indexAt(call: SingCall, p: number): number {
  const b = call.bounds
  for (let i = 0; i < b.length - 1; i++) if (p >= b[i]! && p < b[i + 1]!) return i
  return -1
}

const setKaraoke = StateEffect.define<{ from: number; to: number; cls: string }[]>()

/** Decoration field the RAF driver feeds. */
export const karaokeField: StateField<DecorationSet> = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes)
    for (const e of tr.effects) {
      if (e.is(setKaraoke)) {
        deco = Decoration.set(
          e.value.map((r) => Decoration.mark({ class: r.cls }).range(r.from, r.to)),
          true,
        )
      }
    }
    return deco
  },
  provide: (f) => EditorView.decorations.from(f),
})

export const karaokeExtension: Extension = karaokeField

/** Drive the highlight: subscribe to pattern events for the sing trigger's
 *  timing, and each animation frame map the audio-clock phase to a syllable/note.
 *  Returns a disposer. `opts` supplies the doc text, play state, an event
 *  subscription, an onDoc hook (to re-parse), and the audio clock. */
export function mountKaraoke(
  view: EditorView,
  opts: {
    audio: { currentTime: number }
    isPlaying: () => boolean
    subscribeEvents: (fn: (evs: SchedulerEvent[]) => void) => () => void
    getDoc: () => string
    onDoc: (fn: (code: string) => void) => () => void
    /** True if a `sound` control names a sing() vocal. Defaults to the built-in
     *  `singv…` hash prefix; the editor supplies the real name set so a
     *  sing(..., { name }) override is still tracked. */
    isSingSound?: (sound: string) => boolean
  },
): () => void {
  const isSing = opts.isSingSound ?? ((s: string) => s.startsWith('singv'))
  let trigTime = 0
  let trigDur = 0
  let haveTrig = false
  const unsubEv = opts.subscribeEvents((evs) => {
    for (const ev of evs) {
      const snd = (ev.controls as { sound?: unknown }).sound
      if (typeof snd === 'string' && isSing(snd) && ev.durSec > 0) {
        trigTime = ev.timeSec
        trigDur = ev.durSec
        haveTrig = true
      }
    }
  })
  let calls = parseSingCalls(opts.getDoc())
  const unsubDoc = opts.onDoc((code) => { calls = parseSingCalls(code) })

  let raf = 0
  let lastKey = ''
  const clear = (): void => {
    if (lastKey !== '') { view.dispatch({ effects: setKaraoke.of([]) }); lastKey = '' }
  }
  const tick = (): void => {
    raf = requestAnimationFrame(tick)
    try {
      if (!haveTrig || !opts.isPlaying() || calls.length === 0 || trigDur <= 0) { clear(); return }
      const phase = (opts.audio.currentTime - trigTime) / trigDur
      if (phase < -0.05 || phase >= 1.05) { return } // between cycles / event just ahead: hold last
      const p = Math.max(0, Math.min(0.99999, phase))
      const ranges: { from: number; to: number; cls: string }[] = []
      const docLen = view.state.doc.length
      for (const c of calls) {
        const i = indexAt(c, p)
        if (i < 0) continue
        const s = c.lyr[i]!
        const nn = c.notes[i]!
        if (s.to <= docLen) ranges.push({ from: s.from, to: s.to, cls: 'cm-karaoke-syllable' })
        if (nn.to <= docLen) ranges.push({ from: nn.from, to: nn.to, cls: 'cm-karaoke-note' })
      }
      const key = ranges.map((r) => `${r.from}:${r.to}`).join(',')
      if (key !== lastKey) { view.dispatch({ effects: setKaraoke.of(ranges) }); lastKey = key }
    } catch {
      // a highlight glitch must never break the editor
    }
  }
  raf = requestAnimationFrame(tick)
  return () => { cancelAnimationFrame(raf); unsubEv(); unsubDoc() }
}
