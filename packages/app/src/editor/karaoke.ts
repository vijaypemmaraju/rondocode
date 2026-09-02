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
 * RONDO documents are scanned separately (sing blocks, lyric/melody line
 * pairs) into the same shape, so the highlight works in both languages.
 *
 * The MELODY is read by the REAL mini parser, not a whitespace split: a
 * melody carries brackets, rests, alternations and @weights, and only the
 * parser knows which tokens are notes and how long each one is. Its locs give
 * the exact document ranges, and its hap times give the phase boundaries, so
 * multi-cycle phrases (`cycles: N`) line up too.
 * ------------------------------------------------------------------------- */
import './karaoke.css'
import { StateEffect, StateField } from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import { Decoration, EditorView } from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'
import { parse } from 'acorn'
import { stripComment } from '@rondocode/rondo'
import { note, TimeSpan, F, hasOnset } from '@rondocode/pattern'
import type { SchedulerEvent } from '@rondocode/pattern'

interface Range {
  from: number
  to: number
}
interface SingCall {
  lyr: Range[]
  notes: Range[]
  /** normalized [start,end) of each note within the whole phrase (0..1). */
  spans: { start: number; end: number }[]
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

/** Sounding notes of a melody, in order, via the REAL mini parser: each one's
 *  document range (from its loc) and its normalized start/end within the whole
 *  `cycles`-cycle phrase. A whitespace split cannot do this - `[`, `~`, `<>`
 *  and `@` all change which tokens sound and for how long.
 *  `offsetOf` maps a position in the (possibly joined) mini text to a document
 *  offset; rondo joins several melody LINES into one mini string. */
function melodyNotes(
  text: string,
  cycles: number,
  offsetOf: (pos: number) => number | null,
): { range: Range; start: number; end: number }[] {
  let haps
  try {
    haps = note(text).query(new TimeSpan(F(0), F(cycles))).filter(hasOnset)
  } catch {
    return [] // an unparseable melody simply gets no highlight
  }
  const out: { range: Range; start: number; end: number }[] = []
  for (const h of haps) {
    const loc = (h as unknown as { loc?: { start: number; end: number } }).loc
      ?? (h.value as unknown as { loc?: { start: number; end: number } }).loc
    if (loc === undefined) continue
    const from = offsetOf(loc.start)
    const to = offsetOf(loc.end)
    if (from === null || to === null) continue
    const w = h.whole!
    out.push({
      range: { from, to },
      start: w.begin.valueOf() / cycles,
      end: (w.begin.valueOf() + w.length.valueOf()) / cycles,
    })
  }
  out.sort((a, b) => a.start - b.start)
  return out
}

/** `{ cycles: N }` from a sing()'s opts object literal (default 1). */
function optsCycles(node: { type?: string; properties?: unknown[] } | null | undefined): number {
  if (!node || node.type !== 'ObjectExpression' || !Array.isArray(node.properties)) return 1
  for (const raw of node.properties) {
    const prop = raw as { type?: string; key?: { name?: string; value?: unknown }; value?: { type?: string; value?: unknown } }
    if (prop.type !== 'Property') continue
    const key = prop.key?.name ?? prop.key?.value
    if (key !== 'cycles') continue
    const v = prop.value
    if (v?.type === 'Literal' && typeof v.value === 'number' && Number.isInteger(v.value) && v.value >= 1) return v.value
  }
  return 1
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
      if (callee?.type === 'Identifier' && callee.name === 'sing' && args && args.length >= 2) {
        // sing(voice, lyrics, notes, opts?) | sing(lyrics, notes, opts?)
        const threeStr = litContent(args[2] ?? null, source) !== null
        const lyr = litContent(args[threeStr ? 1 : 0] ?? null, source)
        const nt = litContent(args[threeStr ? 2 : 1] ?? null, source)
        const optsNode = args[threeStr ? 3 : 2] as { type?: string; properties?: unknown[] } | null | undefined
        if (lyr && nt) {
          const cycles = optsCycles(optsNode)
          const slots = lyricSlots(lyr.text, lyr.docStart)
          const notes = melodyNotes(nt.text, cycles, (pos) => nt.docStart + pos)
          if (slots.length === notes.length && slots.length > 0) {
            out.push({ lyr: slots, notes: notes.map((x) => x.range), spans: notes.map((x) => ({ start: x.start, end: x.end })) })
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

/** RONDO sing blocks → the same aligned shape. A `sing NAME` block body is
 *  alternating LYRIC / MELODY lines (the compiler joins each family with
 *  spaces), then modifier lines. Melody locs index the JOINED string, so the
 *  offset map walks the pieces back to their own line. */
export function parseSingBlocksRondo(source: string): SingCall[] {
  const out: SingCall[] = []
  const lines = source.split('\n')
  const starts: number[] = []
  let off = 0
  for (const ln of lines) { starts.push(off); off += ln.length + 1 }

  for (let i = 0; i < lines.length; i++) {
    /* A sing header may be TOP-LEVEL or NESTED IN A SECTION (indent 2), so
     * the block boundary is a dedent to the header's own indent — the same
     * rule the parser's bodyLines uses — not "column 0". Anchoring at column
     * 0 was the bug that left a section's vocal without karaoke. A lyric
     * line that happens to start with the word `sing` cannot re-trigger
     * here: its own block was found first and `i = j - 1` skips its body. */
    const head = /^([ \t]*)sing[ \t]+[A-Za-z_]\w*/.exec(lines[i]!)
    if (head === null) continue
    const headIndent = head[1]!.length
    const body: { text: string; start: number }[] = []
    let cycles = 1
    let j = i + 1
    for (; j < lines.length; j++) {
      const ln = lines[j]!
      if (ln.trim() === '') continue
      if (/^[ \t]*/.exec(ln)![0].length <= headIndent) break // dedent: block over
      if (/^[ \t]+post[ \t]*$/.test(ln)) break // post sub-block: no lyrics past here
      // the COMPILER's comment rule: '#' only starts a comment at line start
      // or after whitespace, so a sharp (`a#4`) survives
      const body_ = stripComment(ln)
      const trimmed = body_.trim()
      if (trimmed === '') continue
      const cyc = /^cycles:[ \t]*(\d+)$/.exec(trimmed)
      if (cyc !== null) { cycles = Math.max(1, parseInt(cyc[1]!, 10)); continue }
      if (/^[A-Za-z_]\w*[ \t]*:/.test(trimmed) || /^(every|jux|off|sometimes|fast|slow|rev)\b/.test(trimmed)) continue // other modifiers
      body.push({ text: trimmed, start: starts[j]! + body_.indexOf(trimmed) })
    }
    // pairs: lyric line, melody line, lyric line, melody line...
    const lyricLines = body.filter((_, k) => k % 2 === 0)
    const melodyLines = body.filter((_, k) => k % 2 === 1)
    if (lyricLines.length === 0 || melodyLines.length === 0) continue
    const slots: Range[] = []
    for (const l of lyricLines) slots.push(...lyricSlots(l.text, l.start))
    // joined melody text + a map from joined offset back to the doc
    const joined = melodyLines.map((m) => m.text).join(' ')
    const pieces: { from: number; to: number; docStart: number }[] = []
    let acc = 0
    for (const m of melodyLines) {
      pieces.push({ from: acc, to: acc + m.text.length, docStart: m.start })
      acc += m.text.length + 1 // the joining space
    }
    const offsetOf = (pos: number): number | null => {
      for (const pc of pieces) if (pos >= pc.from && pos <= pc.to) return pc.docStart + (pos - pc.from)
      return null
    }
    const notes = melodyNotes(joined, cycles, offsetOf)
    if (slots.length === notes.length && slots.length > 0) {
      out.push({ lyr: slots, notes: notes.map((x) => x.range), spans: notes.map((x) => ({ start: x.start, end: x.end })) })
    }
    i = j - 1
  }
  return out
}

/** Note index active at normalized phase p (0..1), or -1. Spans come from the
 *  parser, so a REST between notes correctly highlights nothing. */
function indexAt(call: SingCall, p: number): number {
  for (let i = 0; i < call.spans.length; i++) {
    const sp = call.spans[i]!
    if (p >= sp.start && p < sp.end) return i
  }
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

/** The vocal's TRIGGER: the one event per phrase karaoke times against. The
 *  automation grid sing() stacks under it names the same sound sixteen times
 *  a cycle with no note, and none of those is where the phrase starts. */
export const isSingTrigger = (ev: SchedulerEvent, isSing: (sound: string) => boolean): boolean => {
  const c = ev.controls as { sound?: unknown; note?: unknown }
  return typeof c.sound === 'string' && isSing(c.sound) && typeof c.note === 'number' && ev.durSec > 0
}

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
    /** 'rondo' scans sing BLOCKS instead of sing() calls. Read per parse, so
     *  toggling the language re-scans without a remount. */
    getLang?: () => 'rondocode' | 'rondo'
  },
): () => void {
  const isSing = opts.isSingSound ?? ((s: string) => s.startsWith('singv'))
  let trigTime = 0
  let trigDur = 0
  let haveTrig = false
  const unsubEv = opts.subscribeEvents((evs) => {
    for (const ev of evs) {
      if (isSingTrigger(ev, isSing)) {
        trigTime = ev.timeSec
        trigDur = ev.durSec
        haveTrig = true
      }
    }
  })
  const scan = (code: string): SingCall[] =>
    opts.getLang?.() === 'rondo' ? parseSingBlocksRondo(code) : parseSingCalls(code)
  let calls = scan(opts.getDoc())
  const unsubDoc = opts.onDoc((code) => { calls = scan(code) })

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
