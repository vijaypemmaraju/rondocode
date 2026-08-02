import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RESERVED_PARAM_NAMES, SVF_MODES, EQ_BAND_TYPES } from '@rondocode/engine'
import { BLOCK_KEYWORDS, STATEMENT_KEYWORDS, RONDO_EQ_BAND_TYPES } from '@rondocode/rondo'
import { KEYWORDS } from '../src/editor/rondo/words'
import { EQ_TYPE_CYCLES, SVF_MODES as EDITOR_SVF_MODES } from '../src/editor/rondo/enums'

/* ------------------------------------------------------------------------- *
 * There must be exactly ONE list of structural control keys.
 *
 * Adding `nAcc` (an accidental on a scale degree) took four attempts to land,
 * because the list existed in four places and each copy was found only when
 * the one downstream of it broke:
 *
 *   engine/macro.ts   RESERVED_PARAM_NAMES  — the real one
 *   session/evalCode  staging validation    — a phantom ctrl() error (#199)
 *   session/Session   the LIVE send path    — `unknown param 'nAcc'`, on
 *                                             exactly the notes that had one,
 *                                             which reads as random
 *   server/render-runner  offline render    — found only by grepping for it
 *
 * Every one of them was a filter deciding "is this key a synth param or part
 * of the note?", and every one silently disagreed. So this does not test
 * behaviour, it tests that the duplication cannot come back: no file may
 * rebuild the list, they must import it.
 * ------------------------------------------------------------------------- */
const ROOTS = ['app/src', 'engine/src', 'pattern/src', 'server/src', 'rondo/src']

const files = (dir: string): string[] => {
  let out: string[] = []
  for (const e of readdirSync(dir)) {
    // examples/local is GITIGNORED: scanning it makes this suite's result
    // depend on whichever work-in-progress a machine happens to have, so it
    // would pass in CI and fail (or vice versa) on a developer's laptop
    if (e === 'local') continue
    const p = join(dir, e)
    if (statSync(p).isDirectory()) out = out.concat(files(p))
    else if (p.endsWith('.ts')) out.push(p)
  }
  return out
}

describe('the structural control keys live in exactly one place', () => {
  const pkgs = join(__dirname, '../../')
  const all = ROOTS.flatMap((r) => files(join(pkgs, r)))

  it('finds the source tree (a broken glob would make this vacuous)', () => {
    expect(all.length).toBeGreaterThan(50)
  })

  it('no file rebuilds the list — every consumer imports it', () => {
    // a Set literal holding several structural keys IS the list, whatever it
    // is named locally
    const rebuilt = all.filter((f) => {
      if (f.endsWith(join('engine', 'src', 'macro.ts'))) return false // the definition
      const src = readFileSync(f, 'utf8')
      for (const m of src.matchAll(/new Set\(\[([^\]]*)\]\)/g)) {
        const words = [...m[1]!.matchAll(/'([^']+)'/g)].map((w) => w[1]!)
        const structural = words.filter((w) => RESERVED_PARAM_NAMES.has(w))
        // `gain`, `note` and `pan` are ordinary words and show up in
        // vocabulary tables and enum lists all over. `loc` and `sound` are
        // scheduler-internal field names — a set holding BOTH, plus most of
        // the rest, is this list and nothing else.
        if (structural.length >= 5 && words.includes('loc') && words.includes('sound')) return true
      }
      return false
    })
    expect(rebuilt.map((f) => f.slice(pkgs.length))).toEqual([])
  })

  it('still contains the keys the note carries, so it cannot be emptied', () => {
    for (const k of ['n', 'nAcc', 'note', 'sound', 'gain', 'pan', 'dur', 'slide', 'loc']) {
      expect(RESERVED_PARAM_NAMES.has(k), k).toBe(true)
    }
  })
})

/* ------------------------------------------------------------------------- *
 * The same rule, applied to the other lists a sweep found duplicated. Each of
 * these had real copies that had already drifted or were about to:
 *
 *   SVF modes        engine type + 3 runtime copies (enums, filtercurve,
 *                    jsscan) — a new mode reached whichever the author
 *                    remembered
 *   EQ band types    engine type + 2 runtime copies
 *   block keywords   the parser dispatch, the editor's KEYWORDS, the
 *                    completion list and the "unknown block" message. The
 *                    completion copy was MISSING `curvedef` and `switch`, so
 *                    two blocks the grammar accepts were never offered
 *   statements       the parser dispatch and the formatter's own set, which
 *                    is how `timesig` came to be left unformatted (#232)
 * ------------------------------------------------------------------------- */

const STATEMENT_KEYWORDS_ARR = [...STATEMENT_KEYWORDS]

describe('the other lists a sweep found duplicated', () => {
  const pkgs = join(__dirname, '../../')
  const all = ROOTS.flatMap((r) => files(join(pkgs, r)))
  /** Literal string lists in a file, as arrays of their members. */
  const literalLists = (src: string): string[][] =>
    [...src.matchAll(/\[([^\]]{4,2000}?)\]/gs)].map((m) =>
      [...m[1]!.matchAll(/'([^']+)'/g)].map((w) => w[1]!),
    )
  /** Files that restate `list` as a literal, other than its home.
   *
   *  The thresholds matter and were wrong once: requiring a near-COMPLETE
   *  restatement (list.length - 1) let the very thing this guards against
   *  through, because a drifted copy is by definition missing entries — the
   *  completion list that started this was 17 of 19. So: a literal counts as
   *  this list when it holds most OF the list (60%) and is mostly MADE of it
   *  (80%), which a vocabulary table that happens to share a few words is not. */
  const rebuilders = (list: readonly string[], home: string): string[] =>
    all
      .filter((f) => !f.endsWith(home))
      .filter((f) => literalLists(readFileSync(f, 'utf8')).some((words) => {
        if (words.length < 3) return false
        const shared = words.filter((w) => (list as string[]).includes(w))
        return shared.length >= Math.max(3, Math.ceil(list.length * 0.6)) &&
          shared.length >= Math.ceil(words.length * 0.8)
      }))
      .map((f) => f.slice(pkgs.length))

  /* SVF modes and EQ band types have THREE homes, and that is deliberate:
   *
   *   engine   the definition (filters.ts / eq.ts)
   *   rondo    models the DSL as text and does not depend on the engine
   *   editor   MUST NOT import the engine — a value import drags the whole
   *            audio engine into the docs page's eager graph, which
   *            eager-graph.test.ts exists to stop (found exactly that way)
   *
   * So the rule here is not "one copy" but "every copy is pinned": the
   * literals may exist, and adding a mode engine-side fails HERE rather than
   * silently never reaching the editor or being rejected by the parser. */
  const HOMES = {
    svf: [join('engine', 'src', 'dsp', 'filters.ts'), join('app', 'src', 'editor', 'rondo', 'enums.ts')],
    eq: [
      join('engine', 'src', 'dsp', 'eq.ts'),
      join('rondo', 'src', 'parser.ts'),
      join('app', 'src', 'editor', 'rondo', 'enums.ts'),
    ],
  }

  it('SVF modes live in the engine and the editor, and nowhere else', () => {
    expect(rebuilders(SVF_MODES, HOMES.svf[0]!).filter((f) => !HOMES.svf.includes(f))).toEqual([])
  })

  it('EQ band types live in the engine, rondo and the editor, and nowhere else', () => {
    expect(rebuilders(EQ_BAND_TYPES, HOMES.eq[0]!).filter((f) => !HOMES.eq.includes(f))).toEqual([])
  })

  it('every mirror EQUALS the engine, so a new mode cannot reach only one', () => {
    expect([...EDITOR_SVF_MODES].sort()).toEqual([...SVF_MODES].sort())
    expect([...RONDO_EQ_BAND_TYPES].sort()).toEqual([...EQ_BAND_TYPES].sort())
  })

  it('the eq type CYCLES cover every band type, in their arity groups', () => {
    // enums.ts regroups the same types by how many numbers they take (hp/lp
    // read freq q; peak/shelves read freq gain q), so it cannot just import
    // the flat list. Pinned instead: a new band type engine-side fails here
    // until someone says which group it belongs to, rather than silently
    // never appearing in the tap-cycle.
    expect(EQ_TYPE_CYCLES.flat().sort()).toEqual([...EQ_BAND_TYPES].sort())
  })

  it('block and statement keywords are the parser\'s, not the editor\'s', () => {
    expect(rebuilders(BLOCK_KEYWORDS, join('rondo', 'src', 'parser.ts'))).toEqual([])
    expect(rebuilders(STATEMENT_KEYWORDS_ARR, join('rondo', 'src', 'parser.ts'))).toEqual([])
  })

  it('every keyword the parser dispatches on is one the editor knows', () => {
    // the drift that hid `curvedef` and `switch` from completion: the editor
    // must not know a SMALLER vocabulary than the grammar
    const missing = BLOCK_KEYWORDS.filter((k) => !KEYWORDS.has(k))
    expect(missing, `blocks the parser accepts but the editor does not colour: ${missing.join(', ')}`).toEqual([])
  })

  it('every one-line statement is also a block keyword (they are top level too)', () => {
    const orphan = STATEMENT_KEYWORDS_ARR.filter((k) => !BLOCK_KEYWORDS.includes(k))
    expect(orphan).toEqual([])
  })
})
