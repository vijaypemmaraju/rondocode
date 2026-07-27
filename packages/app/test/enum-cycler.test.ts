import { describe, expect, it } from 'vitest'
import {
  FM_WAVES,
  LFSR_MODES,
  MODAL_MODELS,
  NOISE_COLORS,
  WAVETABLE_TABLES,
  WAVETABLE_WARPS,
} from '@rondocode/engine'
import { BUILTINS } from '@rondocode/rondo'
import { ENUM_VALUE_TABLE, EQ_TYPE_CYCLES, cycleEnumEdit, scanEnumSpans } from '../src/editor/rondo/enums'

/* The enum tap-cycler's brain: the value table (pinned against the ENGINE's
 * exported constants so a new mode/color/warp cannot silently miss the
 * cycle), the span scanner, and the pure (doc, pos) → edit function. The DOM
 * layer (mark + tap handler in widgets.ts) stays thin and untested. */

const rangeOf = (doc: string, text: string, nth = 0): { from: number; to: number } => {
  let from = -1
  for (let i = 0; i <= nth; i++) from = doc.indexOf(text, from + 1)
  expect(from).toBeGreaterThanOrEqual(0)
  return { from, to: from + text.length }
}

describe('ENUM_VALUE_TABLE: pinned against the engine', () => {
  it('noise colors match NOISE_COLORS', () => {
    expect(ENUM_VALUE_TABLE['noise']!.pos![0]).toEqual([...NOISE_COLORS])
  })
  it('lfsr modes match LFSR_MODES', () => {
    expect(ENUM_VALUE_TABLE['lfsr']!.named!['mode']).toEqual([...LFSR_MODES])
  })
  it('fm waves match FM_WAVES', () => {
    expect(ENUM_VALUE_TABLE['fm']!.named!['wave']).toEqual([...FM_WAVES])
  })
  it('modal models match MODAL_MODELS keys', () => {
    expect(ENUM_VALUE_TABLE['modal']!.named!['model']).toEqual(Object.keys(MODAL_MODELS))
  })
  it('wavetable warps + built-in tables match the engine lists', () => {
    expect(ENUM_VALUE_TABLE['wavetable']!.named!['warp']).toEqual([...WAVETABLE_WARPS])
    expect(ENUM_VALUE_TABLE['wavetable']!.named!['table']).toEqual([...WAVETABLE_TABLES])
  })
  it('eq type groups cover the parser band types exactly once', () => {
    expect([...EQ_TYPE_CYCLES.flat()].sort()).toEqual(['highshelf', 'hp', 'lowshelf', 'lp', 'peak'].sort())
  })

  it('covers EVERY enum arg the registry declares (except runtime sample names)', () => {
    // the value-table coverage guarantee: any registry row that declares an
    // enum kind must have a value list here (or an explicit null for the
    // runtime-named sample slots) — a new enum arg fails this test until its
    // legal values are declared
    for (const [name, spec] of Object.entries(BUILTINS)) {
      if (name === 'eq') continue // special-parsed band types (EQ_TYPE_CYCLES)
      spec.pos.forEach((kind, i) => {
        if (kind !== 'enum') return
        const entry = ENUM_VALUE_TABLE[name]
        expect(entry?.pos, `positional enum ${name}[${i}] missing from ENUM_VALUE_TABLE`).toBeDefined()
        expect(entry!.pos!.length, `positional enum ${name}[${i}] missing from ENUM_VALUE_TABLE`).toBeGreaterThan(i)
      })
      for (const [arg, kind] of Object.entries(spec.named ?? {})) {
        if (kind !== 'enum') continue
        expect(
          ENUM_VALUE_TABLE[name]?.named?.[arg],
          `named enum ${name} ${arg}: missing from ENUM_VALUE_TABLE`,
        ).toBeDefined()
      }
    }
  })
})

describe('scanEnumSpans', () => {
  it('finds positional enums (noise color, lfo shape) with exact ranges', () => {
    const doc = 'synth s1\n  noise pink\n  wob = lfo 4 tri -> 200..2400\n'
    const spans = scanEnumSpans(doc)
    expect(spans.map((s) => s.word)).toEqual(['pink', 'tri'])
    expect(spans[0]).toMatchObject(rangeOf(doc, 'pink'))
    expect(spans[0]!.values).toEqual(['white', 'pink', 'brown'])
    expect(spans[1]).toMatchObject(rangeOf(doc, 'tri'))
    expect(spans[1]!.values).toEqual(['sine', 'tri', 'square', 'saw', 'rand'])
  })

  it('finds named enums (mode/type/model/warp, dualsvf a/b)', () => {
    const doc = [
      'synth s1',
      '  svf 900 mode:hp res:.3',
      '  shape 2 type:tube',
      '  dualsvf 400 4000 mode:parallel a:lp b:hp',
      '  modal model:glass',
      '  wavetable note .3 warp:sync table:pwm',
      '',
    ].join('\n')
    const spans = scanEnumSpans(doc)
    expect(spans.map((s) => s.word)).toEqual(['hp', 'tube', 'parallel', 'lp', 'hp', 'glass', 'sync', 'pwm'])
    expect(spans[0]).toMatchObject(rangeOf(doc, 'hp', 0))
    expect(spans[2]!.values).toEqual(['serial', 'parallel'])
    expect(spans[3]!.values).toEqual(['lp', 'hp', 'bp', 'notch', 'peak', 'allpass'])
    // a `key: value` with a space still resolves the value word
    const spaced = scanEnumSpans('synth s1\n  svf 900 mode: hp\n')
    expect(spaced.map((s) => s.word)).toEqual(['hp'])
    expect(spaced[0]).toMatchObject(rangeOf('synth s1\n  svf 900 mode: hp\n', 'hp'))
  })

  it('wavetable table: values include the doc wavedefs after the built-ins', () => {
    const doc = 'wavedef vox 1 .3 / .5 1\n\nsynth s1\n  wavetable note .2 table:vox\n'
    const [span] = scanEnumSpans(doc)
    expect(span!.word).toBe('vox')
    expect(span!.values).toEqual(['basic', 'harmonic', 'pwm', 'vox'])
  })

  it('eq band types cycle within their arity group only', () => {
    const doc = 'synth s1\n  eq hp 170 peak 300 -3 2 highshelf 7000 4\n'
    const spans = scanEnumSpans(doc)
    expect(spans.map((s) => s.word)).toEqual(['hp', 'peak', 'highshelf'])
    expect(spans[0]!.values).toEqual(['hp', 'lp'])
    expect(spans[1]!.values).toEqual(['peak', 'lowshelf', 'highshelf'])
    expect(spans[2]!.values).toEqual(['peak', 'lowshelf', 'highshelf'])
  })

  it('sample names never cycle (runtime data, no legal list)', () => {
    expect(scanEnumSpans('synth s1\n  sample vox root:57\n')).toEqual([])
    expect(scanEnumSpans('synth s1\n  granular vox pos:.3\n')).toEqual([])
  })

  it('scans synth, post and bus bodies but never play/beat notation', () => {
    const doc = [
      'synth s1',
      '  saw',
      '  post',
      '    shape 2 type:tube',
      '',
      'bus space',
      '  svf 2000 mode:lp',
      '',
      'play s1',
      '  0 3 5 7  scale:a-min',
      '',
      'beat',
      '  noise pink noise pink', // beat words are SYNTH names, not a noise call
      '',
    ].join('\n')
    const spans = scanEnumSpans(doc)
    expect(spans.map((s) => s.word)).toEqual(['tube', 'lp'])
  })

  it('ignores comments and bails on rich positional expressions', () => {
    expect(scanEnumSpans('synth s1\n  saw  # noise pink\n')).toEqual([])
    // after a non-atom token, positional slots stop matching (no mis-count)
    const spans = scanEnumSpans('synth s1\n  n = lfo js{x} tri\n')
    expect(spans).toEqual([])
  })

  it('binding heads (`n = noise pink`) still scan', () => {
    const doc = 'synth s1\n  n = noise brown\n  saw\n'
    expect(scanEnumSpans(doc).map((s) => s.word)).toEqual(['brown'])
  })
})

describe('cycleEnumEdit', () => {
  const doc = 'synth s1\n  noise pink\n  svf 900 mode:allpass\n  eq hp 170 peak 300 -3 2\n'

  it('advances to the next legal value', () => {
    const at = doc.indexOf('pink')
    expect(cycleEnumEdit(doc, at)).toEqual({ from: at, to: at + 4, insert: 'brown' })
  })

  it('wraps at the end of the list', () => {
    const at = doc.indexOf('allpass')
    expect(cycleEnumEdit(doc, at + 3)).toEqual({ from: at, to: at + 7, insert: 'lp' })
  })

  it('eq types stay inside their arity group', () => {
    const hp = doc.indexOf('hp 170')
    expect(cycleEnumEdit(doc, hp)).toEqual({ from: hp, to: hp + 2, insert: 'lp' })
    const peak = doc.indexOf('peak')
    expect(cycleEnumEdit(doc, peak + 4)).toEqual({ from: peak, to: peak + 4, insert: 'lowshelf' })
  })

  it('an unknown current value cycles to the list head', () => {
    const bad = 'synth s1\n  noise blah\n'
    const at = bad.indexOf('blah')
    expect(cycleEnumEdit(bad, at)).toEqual({ from: at, to: at + 4, insert: 'white' })
  })

  it('returns null off any enum word', () => {
    expect(cycleEnumEdit(doc, 0)).toBeNull()
    expect(cycleEnumEdit(doc, doc.indexOf('900'))).toBeNull()
  })

  it('round-trips: cycling through the whole list returns to the start', () => {
    let d = 'synth s1\n  shape 2 type:soft\n'
    const at = d.indexOf('soft')
    const seen: string[] = []
    for (let i = 0; i < 4; i++) {
      const edit = cycleEnumEdit(d, at)!
      seen.push(edit.insert)
      d = d.slice(0, edit.from) + edit.insert + d.slice(edit.to)
    }
    expect(seen).toEqual(['hard', 'sine', 'tube', 'soft'])
  })
})
