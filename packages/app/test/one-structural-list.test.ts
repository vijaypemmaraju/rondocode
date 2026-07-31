import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RESERVED_PARAM_NAMES } from '@rondocode/engine'

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
