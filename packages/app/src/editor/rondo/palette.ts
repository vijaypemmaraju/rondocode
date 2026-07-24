/* The rondo TAP PALETTE — the original design thesis, made real: because we
 * own the grammar, we know exactly which tokens are legal at the cursor. So a
 * chip bar (docked above the software keyboard) offers ONLY the valid next
 * moves — sources and transforms in a synth body, degrees and rests in
 * notation, modifiers under a play, block starters at the top level. Tapping
 * a chip inserts it with correct spacing; multi-line chips insert whole
 * working skeletons (a new synth arrives with a knob + envelope, so the
 * widgets appear instantly and the first Run makes sound).
 *
 * The classifier is PURE ((doc, pos) → chips) and unit-tested; the DOM layer
 * is a thin bar whose chips fire on pointerdown + preventDefault, so the
 * editor never loses focus and the phone keyboard stays up. */

import type { EditorView } from '@codemirror/view'
import { buzz } from './widgets'

export interface Chip {
  /** what the bar shows. */
  label: string
  /** text inserted at the cursor; contains '\n' → appended as a BLOCK. */
  insert: string
  /** cursor position within `insert` after inserting (default: its end). */
  cursor?: number
  /** styling group. */
  kind?: 'kw' | 'note' | 'op'
}

const chip = (label: string, insert: string, kind?: Chip['kind'], cursor?: number): Chip => {
  const c: Chip = { label, insert }
  if (kind !== undefined) c.kind = kind
  if (cursor !== undefined) c.cursor = cursor
  return c
}

/** Next unused `sN` synth name, and the last synth name (for play blocks). */
function synthNames(doc: string): { next: string; last?: string } {
  const names: string[] = []
  const re = /^synth[ \t]+([a-zA-Z_]\w*)/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(doc)) !== null) names.push(m[1]!)
  let n = 1
  while (names.includes(`s${n}`)) n++
  const out: { next: string; last?: string } = { next: `s${n}` }
  const last = names[names.length - 1]
  if (last !== undefined) out.last = last
  return out
}

/* ---- chip sets ------------------------------------------------------------ */

function topChips(doc: string): Chip[] {
  const { next, last } = synthNames(doc)
  const target = last ?? next
  return [
    chip('＋ synth', `synth ${next}\n  saw\n  ladder cutoff res:.5\n  * env\n  env = adsr .01 .15 .6 .2\n  cutoff = knob 1200 100..6000 log\n`, 'kw'),
    chip('＋ play', `play ${target}\n  0 3 5 7  scale:a-min\n`, 'kw'),
    chip('＋ beat', `beat\n  kick ~ kick ~\n  ~ hat ~ hat\n`, 'kw'),
    chip('＋ section', `section part 4\n  play ${target}\n    0 3 5 7  scale:a-min\n`, 'kw'),
    chip('＋ bus', `bus space\n  reverb room:.9 damp:.35\n  send ${target} .3\n`, 'kw'),
    chip('sidechain', `sidechain kick depth:.7 release:.12\n`, 'kw'),
    chip('master', `master threshold:-6 ratio:2\n`, 'kw'),
    chip('cps', 'cps .5\n', 'kw'),
  ]
}

const SYNTH_CHIPS: Chip[] = [
  chip('* env', '* env'),
  chip('ladder', 'ladder cutoff res:.5'),
  chip('svf', 'svf 1200 res:.3'),
  chip('delay', 'delay .375 .3'),
  chip('shape', 'shape 2 type:tube'),
  chip('reverb', 'reverb room:.8 mix:.3'),
  chip('tanh', 'tanh'),
  chip('env =', 'env = adsr .01 .15 .6 .2'),
  chip('knob', 'cutoff = knob 1200 100..6000 log'),
  chip('lfo', 'wob = lfo 4 tri -> 200..2400'),
  chip('post', 'post\n  reverb room:.85 mix:.3', 'kw'),
]

const SOURCE_CHIPS: Chip[] = [
  chip('saw', 'saw'),
  chip('supersaw', 'supersaw detune:.4 mix:.8'),
  chip('sine', 'sine'),
  chip('square', 'square'),
  chip('pulse', 'pulse note .25'),
  chip('fm', 'fm note mod feedback:.2'),
  chip('noise', 'noise pink'),
  chip('sample', 'sample vox root:57'),
]

const NOTE_CHIPS: Chip[] = [
  ...['0', '1', '2', '3', '4', '5', '6', '7'].map((d) => chip(d, `${d} `, 'note')),
  chip('~', '~ ', 'note'),
  chip('<', '<', 'op'),
  chip('>', '> ', 'op'),
  chip('[', '[', 'op'),
  chip(']', '] ', 'op'),
  chip('scale', ' scale:a-min', 'kw'),
]

const MOD_CHIPS: Chip[] = [
  chip('gain:', 'gain: .8'),
  chip('dur:', 'dur: .9'),
  chip('every', 'every 4: rev', 'kw'),
  chip('jux', 'jux: rev', 'kw'),
  chip('struct', 'struct ~ t ~ t', 'kw'),
  chip('euclid', 'euclid 3 8'),
  chip('rev', 'rev'),
  chip('fast', 'fast 2'),
  chip('sweep', 'cutoff: sine 200..2400 slow:4'),
  chip('rise', 'wet: rise 8 0..1'),
]

const BUS_CHIPS: Chip[] = [
  chip('reverb', 'reverb room:.9 damp:.35'),
  chip('delay', 'delay .375 .3'),
  chip('send', 'send '),
]

/* ---- the pure classifier -------------------------------------------------- */

/** Which block encloses the line at `lineIdx`? Walks up for the nearest
 *  indent-0 header (synth/play/bus/section/…); tracks a play nested in a
 *  section too. */
function enclosing(lines: string[], lineIdx: number): { block?: string; header?: string; headerIdx: number } {
  for (let i = lineIdx; i >= 0; i--) {
    const ln = lines[i]!
    if (/^\S/.test(ln)) {
      const kw = /^([a-zA-Z_]\w*)/.exec(ln)?.[1]
      return { block: kw, header: ln, headerIdx: i }
    }
    // a play nested inside a section: nearest shallower header line wins if
    // it's a play at indent > 0 and the cursor line is deeper than it
    const nested = /^([ \t]+)play\b/.exec(ln)
    if (nested && i < lineIdx) {
      const cur = /^[ \t]*/.exec(lines[lineIdx]!)![0].length
      if (cur > nested[1]!.length) return { block: 'play', header: ln.trim(), headerIdx: i }
    }
  }
  return { headerIdx: -1 }
}

/** The legal chips at `pos` in `doc` — the tap palette's whole brain. */
export function paletteChips(doc: string, pos: number): Chip[] {
  const before = doc.slice(0, pos)
  const lineIdx = before.split('\n').length - 1
  const lines = doc.split('\n')
  const line = lines[lineIdx] ?? ''

  // top-level position: the cursor line is blank at indent 0, or the doc is empty
  if (line.trim() === '' && !/^[ \t]/.test(line)) {
    // …unless we're inside a block body (previous non-blank line is indented
    // or a block header) — a blank line between body lines still belongs to
    // the block above only if the NEXT line is indented; keep it simple:
    // blank indent-0 line → top level.
    return topChips(doc)
  }

  const ctx = enclosing(lines, lineIdx)
  if (ctx.headerIdx === lineIdx) {
    // ON a header/statement line at indent 0 → top-level starters
    return topChips(doc)
  }
  switch (ctx.block) {
    case 'synth': {
      // inside a post sub-block? nearest `post` line between header and cursor
      for (let i = lineIdx; i > ctx.headerIdx; i--) {
        if (/^[ \t]+post[ \t]*$/.test(lines[i]!)) return SYNTH_CHIPS.filter((c) => c.label !== 'post')
      }
      // first body line (no spine yet) → sources; later → transforms/bindings
      let hasSpine = false
      for (let i = ctx.headerIdx + 1; i < lineIdx; i++) {
        const b = lines[i]!
        if (b.trim() !== '' && !/^\s*#/.test(b)) { hasSpine = true; break }
      }
      return hasSpine ? SYNTH_CHIPS : SOURCE_CHIPS
    }
    case 'play': {
      // first body line → notation chips; later lines → modifiers
      let hasNotation = false
      for (let i = ctx.headerIdx + 1; i < lineIdx; i++) {
        const b = lines[i]!
        if (b.trim() !== '' && !/^\s*#/.test(b)) { hasNotation = true; break }
      }
      return hasNotation ? MOD_CHIPS : NOTE_CHIPS
    }
    case 'bus':
      return BUS_CHIPS
    case 'section':
      return [chip('＋ play', `play ${synthNames(doc).last ?? 's1'}\n  0 3 5 7  scale:a-min`, 'kw')]
    default:
      return topChips(doc)
  }
}

/* ---- the DOM bar ----------------------------------------------------------- */

export interface PaletteHandle {
  /** re-derive chips from the current selection (call on doc/selection/lang change). */
  refresh(): void
  /** show/hide with the language toggle. */
  setVisible(on: boolean): void
  dispose(): void
}

export function mountRondoPalette(bar: HTMLElement, view: EditorView): PaletteHandle {
  bar.classList.add('rondo-palette')
  let visible = false

  const insert = (c: Chip): void => {
    const isBlock = c.insert.includes('\n')
    if (isBlock) {
      // blocks append at the end of the doc, separated by a blank line
      const doc = view.state.doc
      const needsGap = doc.length > 0 && !doc.toString().endsWith('\n\n')
      const prefix = doc.length === 0 ? '' : needsGap ? (doc.toString().endsWith('\n') ? '\n' : '\n\n') : ''
      const from = doc.length
      const text = prefix + c.insert
      view.dispatch({
        changes: { from, insert: text },
        selection: { anchor: from + (c.cursor !== undefined ? prefix.length + c.cursor : text.length) },
        scrollIntoView: true,
      })
      return
    }
    const { head } = view.state.selection.main
    const prev = head > 0 ? view.state.doc.sliceString(head - 1, head) : '\n'
    const needsSpace = prev !== '' && !/[\s([<]/.test(prev) && !/^[\s\])>:]/.test(c.insert)
    const text = (needsSpace ? ' ' : '') + c.insert
    view.dispatch({
      changes: { from: head, insert: text },
      selection: { anchor: head + (c.cursor !== undefined ? (needsSpace ? 1 : 0) + c.cursor : text.length) },
      scrollIntoView: true,
    })
  }

  const render = (): void => {
    if (!visible) return
    const chips = paletteChips(view.state.doc.toString(), view.state.selection.main.head)
    bar.replaceChildren(
      ...chips.map((c) => {
        const b = document.createElement('button')
        b.type = 'button'
        b.className = 'rp-chip' + (c.kind !== undefined ? ` rp-${c.kind}` : '')
        b.textContent = c.label
        // pointerdown + preventDefault: the editor keeps focus, the phone
        // keyboard stays up — tapping the palette must never dismiss it
        b.addEventListener('pointerdown', (e) => {
          e.preventDefault()
          buzz()
          insert(c)
        })
        return b
      }),
    )
  }

  return {
    refresh: render,
    setVisible: (on: boolean): void => {
      visible = on
      bar.classList.toggle('hidden', !on)
      if (on) render()
      else bar.replaceChildren()
    },
    dispose: (): void => bar.replaceChildren(),
  }
}
