import { describe, expect, it } from 'vitest'
import { DSL_DOCS } from '../src/docs/dsl-docs'

/* ------------------------------------------------------------------------- *
 * AN ENTRY HAS TO EXPLAIN WHAT IT EXPOSES.
 *
 * Raw length is the wrong bar — `div` needs one line and would fail any
 * word-count rule for no reason. What went wrong with `granular` is that it
 * had NINE parameters and 369 characters, which was enough to list them and
 * not enough to say any of the things you would get wrong: that position and
 * pitch come apart (the whole reason the node exists), that density times size
 * is the overlap that decides tone-versus-stutter, that the output is
 * loudness-normalised, or that `loop` defaults ON here and OFF on `sample`.
 *
 * So the measure is characters PER PARAMETER. A node that takes nine knobs
 * owes the reader more than a node that takes one, and this fails when a new
 * parameter is added without a word about it — which is the moment the entry
 * silently becomes a list.
 * ------------------------------------------------------------------------- */

/** Parameters an entry exposes, counted from its own signature. */
function paramCount(signature: string): number {
  const opts = /\{([^}]*)\}/.exec(signature)
  const named = opts ? opts[1]!.split(',').filter((x) => x.trim() !== '').length : 0
  const head = /\(([^)]*)\)/.exec(signature.replace(/\{[^}]*\}/, ''))
  const positional = head && head[1]!.trim() !== ''
    ? head[1]!.split(',').filter((x) => x.trim() !== '' && !x.includes('opts')).length
    : 0
  return named + positional
}

/* Combinator plumbing: `appLeft`/`appRight`/`appBoth` take three patterns and
 * differ only in which side's structure wins, which is one sentence honestly.
 * Listed rather than pattern-matched so adding one is a decision. */
const PLUMBING = new Set(['appLeft', 'appRight', 'appBoth', 'mix'])

describe('reference entries explain what they expose', () => {
  const meaty = DSL_DOCS
    .map((d) => ({ ...d, params: paramCount(d.signature) }))
    .filter((d) => d.params >= 3 && !PLUMBING.has(d.name))

  it('finds a real corpus', () => {
    expect(meaty.length).toBeGreaterThan(30)
  })

  it('every entry with 3+ parameters says something about each of them', () => {
    /* 60 chars per parameter is deliberately low — roughly one clause each.
     * `granular` sat at 41 and read as a list; the six rewritten here land
     * between 100 and 190. This is a floor for "was anything said", not a
     * target. */
    const thin = meaty
      .filter((d) => d.summary.length / d.params < 60)
      .map((d) => `${d.name} (${d.params} params, ${d.summary.length} chars, ${Math.round(d.summary.length / d.params)}/param)`)
    expect(thin, `these list their parameters without explaining them:\n  ${thin.join('\n  ')}`).toEqual([])
  })

  it('and the nodes with the most knobs are the best explained', () => {
    // the ones a reader is most likely to get wrong
    for (const name of ['granular', 'sample', 'compress', 'adsr']) {
      const d = DSL_DOCS.find((x) => x.name === name)!
      expect(d.summary.length, `${name} is too thin for what it exposes`).toBeGreaterThan(250)
    }
  })
})

describe('the facts a reader would otherwise get wrong are stated', () => {
  /* Each of these is a real behaviour verified against the kernel, and each is
   * something a program will do silently if the reader assumes otherwise. They
   * are asserted individually because a length check cannot tell whether the
   * added words were the RIGHT words. */
  const has = (name: string, needle: RegExp): void => {
    const d = DSL_DOCS.find((x) => x.name === name)
    expect(d, `${name} is gone`).toBeDefined()
    expect(d!.summary, `${name}: missing "${needle}"`).toMatch(needle)
  }

  it('adsr says d and r are TIME CONSTANTS, not durations', () => {
    // one-pole: after `d` seconds the level is 63% of the way, not there
    has('adsr', /time constant/i)
    has('adsr', /63/)
  })

  it('adsr states its defaults', () => {
    has('adsr', /0\.01/)
    has('adsr', /0\.7/)
  })

  it('granular says position and pitch are independent', () => {
    has('granular', /independen|come apart/i)
  })

  it('granular says density times size is the overlap', () => {
    has('granular', /overlap/i)
  })

  it('granular says the output is level-normalised', () => {
    // otherwise turning density up looks like it should get louder
    has('granular', /normalis|normaliz/i)
  })

  it('reverb warns that it returns the WET tail only', () => {
    has('reverb', /wet/i)
  })

  it('ladder gives the resonance range', () => {
    has('ladder', /0\.98|res/i)
  })

  it('bitcrush distinguishes quantisation from aliasing', () => {
    has('bitcrush', /alias/i)
  })
})
