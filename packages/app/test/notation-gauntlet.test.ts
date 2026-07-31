import { describe, expect, it } from 'vitest'
import { compile } from '@rondocode/rondo'
import { stageCode, runPatterns } from '../../server/src/render-runner'
import { RONDO_SCAN } from '../src/editor/rondo/widgets'
import { JS_SCAN } from '../src/editor/widgets/jsscan'

/* ------------------------------------------------------------------------- *
 * THE FULL PIPELINE, once per notation feature.
 *
 * Written after `<[-4# -1# 1 -1#]*4>` shipped broken. Every layer that feature
 * touched had a passing test: the mini tokenizer, the scale resolution, the
 * flat grid, the JS scanner. It died at STAGING, a layer the change did not
 * touch and so nobody thought to test — evalCode kept its own copy of the
 * structural control keys and had never heard of `nAcc`.
 *
 * A per-layer suite is blind to exactly that: a value that is correct
 * everywhere it was implemented and rejected by something downstream. So this
 * runs each feature the whole way — rondo source -> compile -> stage -> query
 * events -> scan widgets in BOTH languages — and asserts it survives all of
 * it. It does not check what anything sounds like; the point is only that no
 * layer silently refuses.
 *
 * ADD A ROW when you add notation. That is the whole maintenance contract.
 * ------------------------------------------------------------------------- */
const NOTATIONS: [name: string, notation: string, extra?: string][] = [
  ['plain degrees', '0 3 5 7'],
  ['rests', '0 ~ 5 ~'],
  ['negative degrees', '-1 0 -4 3'],
  ['accidentals', '0 2# 4 3b'],
  ['accidentals, negative', '-4# -1# 1 -1b'],
  ['accidentals, doubled', '0 2## 4 3bb'],
  ['accidentals nested in alternation', '<[-3 0 2 0]*4 [-4# -1# 1 -1#]*4>'],
  ['alternation', '<0 3> 5 7'],
  ['weighted alternation', '<0@2 3 5>'],
  ['subgroups', '[0 3] 5 [7 9]'],
  ['chords in brackets', '[0,3,5] 7'],
  ['fast/slow', '0*2 3/2 5 7'],
  ['replicate', '0!3 5'],
  ['euclid', '0(3,8)'],
  ['polymeter', '{0 3 5}%4'],
  ['degrade', '0? 3 5? 7'],
  ['elongation', '0@3 5'],
]

const doc = (notation: string, extra = ''): string =>
  `synth a\n  saw note\n  * adsr .01 .1 .5 .1\n\nplay a\n  ${notation}\n  scale:c-maj\n${extra}\n\ncps .5\n`

describe('every notation feature survives the whole pipeline', () => {
  it.each(NOTATIONS)('%s', (_name, notation, extra) => {
    const src = doc(notation, extra)

    const c = compile(src)
    expect(c.ok, `compile: ${JSON.stringify(c.ok ? [] : c.errors)}`).toBe(true)
    if (!c.ok) return

    // STAGING is the layer the accidental bug hid in: it validates every
    // control key against the routed synth's params, so a new structural
    // field that it does not know about becomes a phantom ctrl() error
    const st = stageCode(c.code)
    const errs = st.ok ? [] : st.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message)
    expect(errs, `stage: ${errs.join(' | ')}`).toEqual([])
    if (!st.ok) return

    // and it must actually produce events, not merely fail to complain
    const evs = runPatterns(st.patterns, { cycles: 2, cps: 0.5 })
    const total = [...evs.values()].flat().length
    expect(total, 'staged clean but produced no events').toBeGreaterThan(0)

    // every note must be a real pitch — an unresolved degree or a NaN
    // accidental would sail through the checks above
    for (const e of [...evs.values()].flat()) {
      if (e.kind !== 'on') continue
      expect(Number.isFinite(e.note), `non-finite note from '${notation}'`).toBe(true)
    }

    // and the editor must not lose its widgets on it — a scanner that throws,
    // or silently declines, is how a feature becomes invisible
    expect(() => RONDO_SCAN.plays(src)).not.toThrow()
    expect(() => RONDO_SCAN.richPlays(src)).not.toThrow()
    expect(() => JS_SCAN.plays(c.code)).not.toThrow()
    expect(() => JS_SCAN.richPlays(c.code)).not.toThrow()
    const drawn = RONDO_SCAN.plays(src).length + RONDO_SCAN.richPlays(src).length
    expect(drawn, `no roll widget for '${notation}'`).toBeGreaterThan(0)
  })
})
