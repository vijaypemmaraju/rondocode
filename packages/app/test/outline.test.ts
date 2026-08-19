import { describe, expect, it } from 'vitest'
import { filterOutline, outlineOf } from '../src/editor/outline'

/* A real arrangement here is 472 lines with 8 synths, 5 sections and 23 play
 * blocks, and the only ways around it were scrolling, folding and find — none
 * of which answer "what is in this file", because each needs you to already
 * know what you are looking for.
 *
 * The failure mode is a row that jumps to the wrong line, so the offsets are
 * pinned against the document rather than assumed. */

const RONDO = [
  'patdef riff <[0 ~ 3]>', // 1
  '', // 2
  'synth lead', // 3
  '  saw note', // 4
  '', // 5
  'bus space', // 6
  '  reverb room:.9', // 7
  '', // 8
  'section intro 8', // 9
  '  play lead', // 10
  '    riff', // 11
  '  beat drums', // 12
  '    kick ~', // 13
  '', // 14
  'song intro', // 15
].join('\n')

describe('outlineOf, rondo', () => {
  const items = outlineOf(RONDO, 'rondo')

  it('finds every kind of thing worth jumping to', () => {
    expect(items.map((i) => `${i.kind}:${i.name}`)).toEqual([
      'pattern:riff',
      'synth:lead',
      'bus:space',
      'section:intro',
      'play:lead',
      'play:drums',
      'song:song intro',
    ])
  })

  it('nests a section\'s blocks under it — the nesting IS the arrangement', () => {
    const section = items.find((i) => i.kind === 'section')!
    expect(section.depth).toBe(0)
    for (const p of items.filter((i) => i.kind === 'play')) expect(p.depth).toBe(1)
  })

  it('points at the real offset of each line', () => {
    // a row that jumps to the wrong line is the one failure that matters
    for (const it of items) {
      expect(RONDO.slice(it.from, it.from + 6), `${it.kind} ${it.name}`).toBe(
        RONDO.split('\n')[it.line - 1]!.trim().slice(0, 6),
      )
    }
  })

  it('does not name a block after a trailing comment', () => {
    const [it] = outlineOf('synth lead # the main one\n', 'rondo')
    expect(it!.name).toBe('lead')
  })

  it('leaves the section when a top-level block follows it', () => {
    const out = outlineOf('section a 2\n  play x\n\nsynth y\n  saw\n\nbus b\n  reverb\n', 'rondo')
    expect(out.find((i) => i.kind === 'bus')!.depth, 'a bus after a section is not inside it').toBe(0)
  })
})

describe('outlineOf, the JS DSL', () => {
  it('finds top-level synths, channels and buses', () => {
    const doc = [
      "const lead = synth(({ saw, note }) => saw(note.freq))",
      "p('melody', note('c3').sound('lead'))",
      "bus('space', ({ input, reverb }) => reverb(input))",
    ].join('\n')
    expect(outlineOf(doc, 'rondocode').map((i) => `${i.kind}:${i.name}`)).toEqual([
      'synth:lead',
      'play:melody',
      'bus:space',
    ])
  })

  it('ignores a synth that is not top-level', () => {
    // an indented const is inside something else and is not a jump target
    expect(outlineOf('  const inner = synth(() => 0)\n', 'rondocode')).toEqual([])
  })
})

describe('filterOutline', () => {
  const items = outlineOf(RONDO, 'rondo')

  it('keeps everything for an empty query', () => {
    expect(filterOutline(items, '   ')).toHaveLength(items.length)
  })

  it('matches the name or the kind, case-insensitively', () => {
    // BOTH the synth and the play block are named lead, and both are right
    // answers to "lead" — a filter that showed one would hide the other
    expect(filterOutline(items, 'LEAD').map((i) => i.kind)).toEqual(['synth', 'play'])
    expect(filterOutline(items, 'synth').map((i) => i.name)).toEqual(['lead'])
  })
})
