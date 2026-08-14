import { describe, expect, it } from 'vitest'
import { BUILTINS, compile } from '@rondocode/rondo'
import { OPTIONS } from '../src/editor/rondo'

/* ------------------------------------------------------------------------- *
 * The rondo vocabulary table has to be TRUE, not merely present.
 *
 * Every existing check on it asks whether a word is documented. None asked
 * whether what the documentation says can be typed. Two entries could not:
 *
 *   syncsaw  showed `syncsaw freq ratio:…`, and `syncsaw note ratio:2` is an
 *            error -- the ratio is positional. The signature a reader copies
 *            out of the completion panel did not compile.
 *   follow   showed `cut = follow attack:.01 release:.2`, and `follow` is a
 *            processor: in a binding it needs the signal to follow.
 *
 * Both passed every guard in the repo, because a `detail` string is prose as
 * far as the type system is concerned. These two tests read it as code.
 * ------------------------------------------------------------------------- */

/** Details that spell a VALUE syntax rather than a named argument. */
const NOT_ARGUMENTS = new Set([
  // `env t lvl t lvl:curve …` describes the per-level curve form `1:3`,
  // where the thing before the colon is a placeholder, not an argument name
  'env',
])

describe('every named argument the table shows is real', () => {
  for (const o of OPTIONS) {
    const name = String(o.label)
    const spec = BUILTINS[name]
    if (spec === undefined || NOT_ARGUMENTS.has(name)) continue
    it(`${name}`, () => {
      const known = new Set(Object.keys(spec.named ?? {}))
      const shown = [...`${String(o.detail ?? '')} ${o.example ?? ''}`.matchAll(/\b([a-z][a-z0-9]*)\s*:/g)]
        .map((m) => m[1]!)
        .filter((a) => a !== name && !known.has(a))
      expect(shown, `shows '${shown.join(':, ')}:' which ${name} does not take. It takes [${[...known].join(' ')}]`).toEqual([])
    })
  }
})

describe('every example the table shows compiles', () => {
  const BLOCK = /^(synth|play|beat|post|bus|sing|section|zonedef|wavedef|scaledef|curvedef|macro|bpm|cps|timesig|sidechain|master|stereo|level|song|patdef|visual|js|with)\b/
  /* Fragments that cannot stand alone whatever you wrap them in: a nested
   * block header, or a line that needs siblings this test cannot invent. */
  const FRAGMENTS = new Set(['post', 'input', 'with', 'song', 'mini', 'note'])

  for (const o of OPTIONS) {
    const ex = o.example
    const name = String(o.label)
    if (ex === undefined || FRAGMENTS.has(name)) continue
    it(`${name}`, () => {
      const indent = (t: string): string => t.split('\n').join('\n  ')
      const prog = BLOCK.test(ex)
        ? `${ex}\n`
        : o.type === 'function'
          /* A SOURCE is the head of the spine and needs nothing above it; a
           * processor needs something to process. Wrapping an oscillator under
           * `saw note` makes it a second source, which is a real error and a
           * false alarm here. */
          ? BUILTINS[name] !== undefined && (BUILTINS[name]!.kind === 'osc' || BUILTINS[name]!.kind === 'gated')
            ? `synth __t\n  ${indent(ex)}\n  * adsr .01 .1 .5 .2\n\nplay __t\n  0\n\ncps .5`
            : `synth __t\n  saw note\n  ${indent(ex)}\n\nplay __t\n  0\n\ncps .5`
          // a keyword is a play modifier: it belongs under a play block
          : `synth __t\n  saw note\n\nplay __t\n  0 3 5\n  ${indent(ex)}\n\ncps .5`
      const c = compile(prog)
      expect(c.ok, c.ok ? '' : `${JSON.stringify(ex)} -> ${c.errors[0]?.message ?? ''}`).toBe(true)
    })
  }
})
