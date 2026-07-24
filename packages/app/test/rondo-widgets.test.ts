import { describe, expect, it } from 'vitest'
import { scanKnobs, scanEnvs, scanPlays, scanBeats, stepStarts, toNorm, fromNorm, rollPreviewMidi } from '../src/editor/rondo/widgets'
import { scanNumbersText } from '../src/editor/widgets/detect'

/* The pure parts of the inline rondo knob widget: finding knob bindings in the
 * source (and pinpointing the DEF value's range so a drag rewrites the right
 * chars) + the log/linear value↔position mapping. */

describe('scanKnobs', () => {
  it('finds a knob and pinpoints the DEF value range', () => {
    const src = 'cutoff = knob 800 80..8000 log'
    const [k] = scanKnobs(src)
    expect(k).toBeDefined()
    expect(src.slice(k!.defFrom, k!.defTo)).toBe('800') // the drag edits exactly this
    expect(k).toMatchObject({ value: 800, lo: 80, hi: 8000, log: true })
  })

  it('defaults to linear when no curve is given, and handles decimals', () => {
    const src = 'wet = knob .35 0..0.7'
    const [k] = scanKnobs(src)
    expect(k).toMatchObject({ value: 0.35, lo: 0, hi: 0.7, log: false })
    // REGRESSION: the DEF range must come from the SOURCE spelling (".35" is 3
    // chars; String(0.35) would be 4) — a drag rewrites exactly [defFrom, defTo)
    // and a wrong defTo would eat the char after the value.
    expect(src.slice(k!.defFrom, k!.defTo)).toBe('.35')
  })

  it('finds multiple knobs on multiple lines', () => {
    expect(scanKnobs('a = knob 1 0..2\nb = knob 3 0..5 lin')).toHaveLength(2)
  })

  it('ignores knobs inside comments (whole-line and trailing)', () => {
    // REGRESSION: a knob in a comment rendered a live dial whose drags
    // rewrote the comment text
    expect(scanKnobs('# a = knob 1 0..2')).toHaveLength(0)
    expect(scanKnobs('a = knob 1 0..2  # b = knob 3 0..5')).toHaveLength(1)
  })
})

describe('scanEnvs', () => {
  it('finds an adsr and its four values + region', () => {
    const src = 'env = adsr .003 .2 .3 .1'
    const [e] = scanEnvs(src)
    expect(e).toBeDefined()
    expect(src.slice(e!.from, e!.to)).toBe('.003 .2 .3 .1') // the region a drag rewrites
    expect(e).toMatchObject({ a: 0.003, d: 0.2, s: 0.3, r: 0.1 })
  })
  it('does not match adsr with fewer than four values', () => {
    expect(scanEnvs('env = adsr .003 .2')).toHaveLength(0)
  })

  it('never matches across lines or inside comments', () => {
    // REGRESSION: `\s+` in the regex crossed newlines, pairing an EOL `adsr`
    // with numbers from the next line; comments grew live widgets
    expect(scanEnvs('env = adsr\n.003 .2 .3 .1')).toHaveLength(0)
    expect(scanEnvs('# env = adsr .003 .2 .3 .1')).toHaveLength(0)
  })
})

describe('scanNumbersText (language-agnostic scrub fallback — every number in rondo)', () => {
  it('finds BOTH ends of a `..` range (every number scrubbable)', () => {
    const vals = scanNumbersText('cutoff = knob 800 80..8000 log').map((n) => n.value)
    expect(vals).toContain(800)
    expect(vals).toContain(80)
    expect(vals).toContain(8000) // REGRESSION: was consumed as ".8000" and dropped
    expect(vals).not.toContain(0.8) // and never misread as a decimal
  })
  it('handles decimals and flags non-integers', () => {
    const nums = scanNumbersText('adsr .003 .2 .3 .1')
    expect(nums.map((n) => n.value)).toEqual([0.003, 0.2, 0.3, 0.1])
    expect(nums.every((n) => !n.isInt)).toBe(true)
  })
  it('folds a unary minus and detects integers', () => {
    const [n] = scanNumbersText('add -12')
    expect(n).toMatchObject({ value: -12, isInt: true })
  })
})

describe('scanPlays (piano-roll)', () => {
  it('parses a degree sequence and pinpoints the notation range (excludes scale)', () => {
    const src = 'play acid\n  0 0 3 5 0 0 7 5  scale:a-min\n'
    const [p] = scanPlays(src)
    expect(p).toBeDefined()
    expect(src.slice(p!.from, p!.to)).toBe('0 0 3 5 0 0 7 5') // exactly what a tap rewrites
    expect(p!.steps).toEqual([0, 0, 3, 5, 0, 0, 7, 5])
  })
  it('represents rests as null', () => {
    expect(scanPlays('play s\n  0 ~ 3 ~\n')[0]!.steps).toEqual([0, null, 3, null])
  })
  it('leaves richer notation as plain text (note names, brackets, alternation)', () => {
    expect(scanPlays('play s\n  c4 e4 g4\n')).toHaveLength(0)
    expect(scanPlays('play s\n  <0 3> [5 7]\n')).toHaveLength(0)
  })
})

describe('scanBeats (whole-block step sequencer)', () => {
  it('finds a simple word/rest line and pinpoints its range', () => {
    const src = 'beat\n  kick ~ kick ~\n'
    const [block] = scanBeats(src)
    const b = block?.rows[0]
    expect(b).toBeDefined()
    expect(src.slice(b!.from, b!.to)).toBe('kick ~ kick ~') // exactly what a tap rewrites
    expect(b).toMatchObject({ word: 'kick', steps: [true, false, true, false], hadComment: false })
  })

  it('groups rows per block; named beats and sections get their own widgets', () => {
    const src = 'beat fills\n  kick ~ kick ~\n  ~ snare ~ snare\n\nsection drop 4\n  beat\n    hat hat hat hat\n'
    const blocks = scanBeats(src)
    expect(blocks.map((bl) => bl.rows.map((r) => r.word))).toEqual([['kick', 'snare'], ['hat']])
  })

  it('an ALL-REST row keeps its instrument via a trailing `# word` comment', () => {
    // this is how an erased row survives: the widget writes `~ ~ ~ ~  # kick`
    // and the scanner reads the word back
    const src = 'beat\n  ~ ~ ~ ~  # kick\n  ~ hat ~ hat\n'
    const [block] = scanBeats(src)
    expect(block!.rows.map((r) => r.word)).toEqual(['kick', 'hat'])
    expect(block!.rows[0]).toMatchObject({ steps: [false, false, false, false], hadComment: true })
    expect(src.slice(block!.rows[0]!.from, block!.rows[0]!.to)).toBe('~ ~ ~ ~')
    // a non-word comment names nothing — the row stays plain text
    expect(scanBeats('beat\n  ~ ~ ~ ~  # four on floor\n')).toHaveLength(0)
  })

  it('leaves rich notation, mixed words, and modifier lines as plain text', () => {
    expect(scanBeats('beat\n  kick*4\n')).toHaveLength(0) // mini repeat
    expect(scanBeats('beat\n  [~ hat]*3 [~ ohat]\n')).toHaveLength(0) // brackets
    expect(scanBeats('beat\n  kick snare kick ~\n')).toHaveLength(0) // two words — no single row label
    expect(scanBeats('beat\n  kick ~ kick ~\n  every 4: rev\n  gain: .5\n')[0]!.rows).toHaveLength(1)
    expect(scanBeats('beat\n  clave\n')).toHaveLength(0) // one step isn't a sequencer
  })

  it('never matches play-block bodies or comments', () => {
    expect(scanBeats('play acid\n  kick ~ kick ~\n')).toHaveLength(0)
    expect(scanBeats('beat\n  # kick ~ kick ~\n')).toHaveLength(0)
    // a trailing comment is stripped from the rewrite range
    const [block] = scanBeats('beat\n  kick ~ kick ~  # four on the floor\n')
    expect(block!.rows[0]).toMatchObject({ content: 'kick ~ kick ~', hadComment: true })
  })

  it('stops at the dedent — lines after the block are not rows', () => {
    const src = 'beat\n  kick ~ kick ~\n\nsynth kick\n  sine 55\n'
    const blocks = scanBeats(src)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.rows).toHaveLength(1)
  })
})

describe('live-widget wiring (pure parts)', () => {
  it('scanKnobs reports the binding name + enclosing synth', () => {
    const src = 'synth acid\n  saw\n  cutoff = knob 800 80..8000 log\n\nsynth pad\n  saw\n  wet = knob .3 0..1\n'
    const [k1, k2] = scanKnobs(src)
    expect(k1).toMatchObject({ name: 'cutoff', synth: 'acid' })
    expect(k2).toMatchObject({ name: 'wet', synth: 'pad' })
  })
  it('scanEnvs reports the enclosing synth; a play block closes it', () => {
    const src = 'synth acid\n  env = adsr .01 .1 .5 .1\n\nplay acid\n  0 3\n'
    expect(scanEnvs(src)[0]).toMatchObject({ synth: 'acid' })
  })
  it('scanPlays carries the notation content (matches events by loc.src)', () => {
    expect(scanPlays('play s\n  0 0 3 5\n')[0]!.content).toBe('0 0 3 5')
  })
  it('stepStarts maps a note event loc.start to its grid column', () => {
    const starts = stepStarts('0 0 3 5 ~ 7')
    expect(starts).toEqual([0, 2, 4, 6, 8, 10])
    expect(starts.indexOf(4)).toBe(2) // atom at offset 4 → column 2
  })
})

describe('grid note preview', () => {
  it('scanPlays captures the synth name and short scale', () => {
    const [p] = scanPlays('play acid\n  0 3 5 7  scale:a-min\n')
    expect(p).toMatchObject({ synth: 'acid', scale: 'a-min' })
  })
  it('rollPreviewMidi resolves degrees through the scale (a-min root = A above middle C region)', () => {
    // a minor: degree 0 = the root; degree 7 = the octave
    const root = rollPreviewMidi('a-min', 0)!
    expect(rollPreviewMidi('a-min', 7)).toBe(root + 12)
    // degree 2 in minor = a minor third up
    expect(rollPreviewMidi('a-min', 2)).toBe(root + 3)
  })
  it('returns undefined without a scale (scale-less degree grids are silent anyway)', () => {
    expect(rollPreviewMidi(undefined, 3)).toBeUndefined()
    expect(rollPreviewMidi('zz-nope', 3)).toBeUndefined()
  })
})

describe('knob value ↔ position mapping', () => {
  it('linear round-trips', () => {
    expect(fromNorm(toNorm(50, 0, 100, false), 0, 100, false)).toBeCloseTo(50)
    expect(toNorm(0, 0, 100, false)).toBe(0)
    expect(toNorm(100, 0, 100, false)).toBe(1)
  })
  it('log round-trips and puts the geometric mean at the middle', () => {
    expect(fromNorm(toNorm(800, 80, 8000, true), 80, 8000, true)).toBeCloseTo(800)
    // geometric mean of 80 and 8000 is 800 → dead centre on a log knob
    expect(toNorm(800, 80, 8000, true)).toBeCloseTo(0.5)
  })
})
