import { describe, expect, it } from 'vitest'
import { compile } from '../src/compile'
import { decompile } from '../src/decompile'
import { evalCode } from '../../app/src/session/evalCode'
import { baseScope } from '../../app/src/session/scope'

/* ------------------------------------------------------------------------- *
 * `overchord: <Am7 F>` — the play block's degrees become CHORD degrees.
 *
 * The order it is emitted in is the whole contract: overChord rewrites the
 * NOTES, so applying it after a modifier that already read them plays
 * something else while still sounding musical. Byte-compare the output.
 * ------------------------------------------------------------------------- */

const ok = (src: string): string => {
  const c = compile(src)
  expect(c.ok, JSON.stringify(c.ok ? [] : c.errors)).toBe(true)
  return c.ok ? c.code : ''
}

const SRC = `synth keys
  saw note

play arp synth:keys
  0 2 1 4
  overchord: <Am7 Fmaj7>
  dur: .42
  gain: .5
`

describe('overchord', () => {
  it('applies BEFORE .sound(), so later modifiers decorate the re-voiced notes', () => {
    expect(ok(SRC)).toContain(
      `n('0 2 1 4').overChord(chord('<Am7 Fmaj7>')).sound('keys').dur(0.42).gain(0.5)`,
    )
  })

  it('is not emitted twice — it leaves the ordinary modifier run', () => {
    expect([...ok(SRC).matchAll(/overChord/g)]).toHaveLength(1)
    expect(ok(SRC)).not.toContain(`ctrl('overchord'`)
  })

  it('rejects a value that is not chord names, at the line that wrote it', () => {
    const c = compile('synth k\n  saw note\n\nplay a synth:k\n  0 2\n  overchord: 4\n')
    expect(c.ok).toBe(false)
    if (!c.ok) {
      expect(c.errors[0]!.message).toMatch(/takes chord names/)
      expect(c.errors[0]!.line).toBe(6)
    }
  })

  it('evals, and the degrees really are re-voiced by the chord under them', () => {
    const r = evalCode(ok(SRC), baseScope)
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(r.ok).toBe(true)
  })

  it('round-trips: the modifier survives JS -> rondo -> JS unchanged', () => {
    const code = ok(SRC)
    const back = decompile(code)
    expect(back).toContain('overchord: <Am7 Fmaj7>')
    expect(ok(back)).toBe(code)
  })

  it('a NON-literal chord argument stays a js block rather than round-trip wrong', () => {
    // `const prog = chord(...)` shared across patterns has no rondo spelling;
    // inventing one would change which chords each pattern reads
    const js = [
      `const keys = synth(({ note, saw }) => saw(note.freq))`,
      `const prog = chord('<Am7 Fmaj7>')`,
      `p('arp', n('0 2').overChord(prog).sound('keys'))`,
    ].join('\n')
    expect(decompile(js)).toContain('js')
    expect(decompile(js)).not.toContain('overchord:')
  })
})
