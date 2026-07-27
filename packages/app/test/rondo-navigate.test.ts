import { describe, expect, it } from 'vitest'
import { rondoDefinitionTarget } from '../src/editor/rondo/navigate'

/* Rondo go-to-definition: (doc, name, pos) -> where the definition lives.
 * Pure and pinned - a wrong target means Cmd-click jumps somewhere absurd. */

const DOC = [
  'wavedef vowel 1 .5 / .4 1',   // 0
  '',                             // 1
  'synth lead',                   // 2
  '  wavetable note scan table:vowel', // 3
  '  * env',                      // 4
  '  env = adsr .01 .2 .5 .2',    // 5
  '  scan = env -> 0.1..0.9',     // 6
  '',                             // 7
  'synth kick',                   // 8
  '  sine 55',                    // 9
  '',                             // 10
  'section drop 4',               // 11
  '  play lead',                  // 12
  '    0 3 5',                    // 13
  '',                             // 14
  'beat',                         // 15
  '  kick ~ kick ~',              // 16
  '',                             // 17
  'song drop',                    // 18
].join('\n')

const at = (needle: string, occurrence = 0): number => {
  let i = -1
  for (let k = 0; k <= occurrence; k++) i = DOC.indexOf(needle, i + 1)
  return i + 1
}
const targetText = (r: { from: number; to: number } | null): string | null =>
  r === null ? null : DOC.slice(r.from, r.to)

describe('rondoDefinitionTarget', () => {
  it('a binding ref resolves to its `name =` line within the block', () => {
    const r = rondoDefinitionTarget(DOC, 'env', at('* env') + 2)
    expect(targetText(r)).toBe('env')
    expect(DOC.slice(r!.from, r!.from + 9)).toBe('env = ads')
  })
  it('a binding used by another binding resolves too', () => {
    const r = rondoDefinitionTarget(DOC, 'env', at('scan = env') + 8)
    expect(DOC.slice(r!.from, r!.from + 5)).toBe('env =')
  })
  it('bindings do not leak across synth blocks', () => {
    // 'env' referenced from inside the kick block: no binding there, no
    // top-level header named env -> null
    expect(rondoDefinitionTarget(DOC, 'env', at('sine 55'))).toBeNull()
  })
  it('a synth name in a play header resolves to the synth', () => {
    const r = rondoDefinitionTarget(DOC, 'lead', at('play lead') + 6)
    expect(DOC.slice(r!.from - 6, r!.to)).toBe('synth lead')
  })
  it('a beat word resolves to its synth', () => {
    const r = rondoDefinitionTarget(DOC, 'kick', at('kick ~'))
    expect(DOC.slice(r!.from - 6, r!.to)).toBe('synth kick')
  })
  it('a song ref resolves to the section header', () => {
    const r = rondoDefinitionTarget(DOC, 'drop', at('song drop') + 5)
    expect(DOC.slice(r!.from - 8, r!.to)).toBe('section drop')
  })
  it('a table: ref resolves to the wavedef', () => {
    const r = rondoDefinitionTarget(DOC, 'vowel', at('table:vowel') + 6)
    expect(DOC.slice(r!.from - 8, r!.to)).toBe('wavedef vowel')
  })
  it('resolving from ON the definition returns its own range (caller no-ops via from === id.from)', () => {
    const defAt = DOC.indexOf('env = adsr')
    const r = rondoDefinitionTarget(DOC, 'env', defAt + 1)
    expect(r!.from).toBe(defAt)
  })
  it('builtins with no definition return null', () => {
    expect(rondoDefinitionTarget(DOC, 'sine', at('sine 55'))).toBeNull()
    expect(rondoDefinitionTarget(DOC, 'adsr', at('adsr .01'))).toBeNull()
  })
})
