import { describe, expect, it } from 'vitest'
import { F, Pattern, TimeSpan } from '@rondocode/pattern'
import type { ControlMap } from '@rondocode/pattern'
import { evalCode } from '../src/session/evalCode'
import { baseScope } from '../src/session/scope'

/* evalCode is pure: source in, staged registrations out, zero external
 * mutation. These tests run in plain Node — no DOM, no audio. */

/** A minimal valid synth body usable inside eval'd source. */
const SYNTH_SRC = 'synth(({ sine, note, gate }) => sine(note.freq).mul(gate))'

const run = (source: string) => evalCode(source, baseScope)

/** First cycle's haps of a staged pattern. */
const cycle0 = (p: Pattern<ControlMap>) => p.query(new TimeSpan(F(0), F(1)))

describe('evalCode: syntax errors', () => {
  it('reports a parse error with 1-based line/col and stages nothing', () => {
    const r = run('const a = 1\nconst b = )')
    expect(r.ok).toBe(false)
    expect(r.diagnostics).toHaveLength(1)
    const d = r.diagnostics[0]!
    expect(d.severity).toBe('error')
    expect(d.source).toBe('eval')
    expect(d.line).toBe(2)
    expect(d.col).toBe(11) // the ')' at 0-based column 10
    expect(d.message).toMatch(/unexpected token/i)
    expect(r.synths.size).toBe(0)
    expect(r.patterns.size).toBe(0)
  })
})

describe('evalCode: runtime errors', () => {
  it('maps a throw on line 3 back to source line 3', () => {
    const r = run(`const x = 1\nconst y = 2\nthrow new Error('boom')`)
    expect(r.ok).toBe(false)
    expect(r.diagnostics).toHaveLength(1)
    expect(r.diagnostics[0]!.line).toBe(3)
    expect(r.diagnostics[0]!.message).toContain('boom')
  })

  it('falls back to 1:1 when the error carries no mappable stack', () => {
    const r = run('throw 42')
    expect(r.ok).toBe(false)
    expect(r.diagnostics[0]!.line).toBe(1)
    expect(r.diagnostics[0]!.col).toBe(1)
    expect(r.diagnostics[0]!.message).toContain('42')
  })

  it('reference to window/document is a diagnostic, not a crash', () => {
    // Node has no window/document, so this honestly exercises the
    // ReferenceError path user code hits for names outside the scope.
    for (const src of ['window.alert(1)', 'document.title']) {
      const r = run(src)
      expect(r.ok).toBe(false)
      expect(r.diagnostics[0]!.message).toMatch(/not defined/)
    }
  })
})

describe('evalCode: MiniError mapping', () => {
  it('points at the offending char inside a unique string literal', () => {
    // n() rejects the non-numeric atom 'x' at pos 2 of '0 x 2'; the literal
    // opens at source offset 9, so the caret lands at offset 12 → col 13.
    const r = run(`p('a', n('0 x 2'))`)
    expect(r.ok).toBe(false)
    expect(r.diagnostics).toHaveLength(1)
    expect(r.diagnostics[0]!.line).toBe(1)
    expect(r.diagnostics[0]!.col).toBe(13)
  })

  it('maps across lines when the literal is not on line 1', () => {
    const r = run(`const q = 1\np('a', n('0 x'))`)
    expect(r.ok).toBe(false)
    expect(r.diagnostics[0]!.line).toBe(2)
    expect(r.diagnostics[0]!.col).toBe(13)
  })

  it('falls back for template-literal mini sources (only plain literals map)', () => {
    const r = run('p(\'a\', n(`0 x`))')
    expect(r.ok).toBe(false)
    expect(r.diagnostics[0]!.line).toBe(1)
    expect(r.diagnostics[0]!.col).toBe(1)
    expect(r.diagnostics[0]!.message).toContain('position')
  })

  it('falls back to a position-less diagnostic when the mini source is not a literal', () => {
    const r = run(`const s0 = '0 ' + 'x 2'\np('a', n(s0))`)
    expect(r.ok).toBe(false)
    expect(r.diagnostics[0]!.line).toBe(1)
    expect(r.diagnostics[0]!.col).toBe(1)
    // MiniError's own message carries the caret snippet — keep it.
    expect(r.diagnostics[0]!.message).toContain('position')
  })
})

describe('evalCode: synth auto-registration transform', () => {
  it('registers top-level const/let synth() declarations by variable name', () => {
    const r = run(`const a = ${SYNTH_SRC}\nlet b = ${SYNTH_SRC}`)
    expect(r.ok).toBe(true)
    expect([...r.synths.keys()]).toEqual(['a', 'b'])
    expect(r.synths.get('a')).toHaveProperty('graph')
  })

  it('does NOT auto-register inside functions or via reassignment (pinned limit)', () => {
    const r = run(
      `function f() { const inner = ${SYNTH_SRC}; return inner }\nlet c\nc = ${SYNTH_SRC}`,
    )
    expect(r.ok).toBe(true)
    expect(r.synths.size).toBe(0)
  })

  it('does NOT auto-register wrapped calls like id(synth(...)) (pinned limit)', () => {
    const r = run(`const id = (x) => x\nconst d = id(${SYNTH_SRC})`)
    expect(r.ok).toBe(true)
    expect(r.synths.size).toBe(0)
  })

  it('warns (non-fatally) on a bare unassigned synth() expression', () => {
    const r = run(SYNTH_SRC)
    expect(r.ok).toBe(true)
    expect(r.diagnostics).toHaveLength(1)
    expect(r.diagnostics[0]!.severity).toBe('warning')
    expect(r.diagnostics[0]!.message).toMatch(/not assigned/)
    expect(r.synths.size).toBe(0)
  })

  it('registers every declarator of a multi-declarator statement', () => {
    const r = run(`const a = ${SYNTH_SRC}, plain = 1, b = ${SYNTH_SRC}`)
    expect(r.ok).toBe(true)
    expect([...r.synths.keys()]).toEqual(['a', 'b'])
  })

  it('tolerates a trailing comment after the declaration', () => {
    const r = run(`const a = ${SYNTH_SRC} // my acid patch\nconst next = 1`)
    expect(r.ok).toBe(true)
    expect([...r.synths.keys()]).toEqual(['a'])
  })

  it('handles semicolon-less code and same-line statements (ASI)', () => {
    const noSemi = run(`const a = ${SYNTH_SRC}\nconst b = 1`)
    expect(noSemi.ok).toBe(true)
    expect([...noSemi.synths.keys()]).toEqual(['a'])
    const sameLine = run(`const a = ${SYNTH_SRC}; const b = ${SYNTH_SRC}`)
    expect(sameLine.ok).toBe(true)
    expect([...sameLine.synths.keys()]).toEqual(['a', 'b'])
  })

  it('explicit defineSynth() calls register directly', () => {
    const r = run(`defineSynth('kick', ${SYNTH_SRC})`)
    expect(r.ok).toBe(true)
    expect([...r.synths.keys()]).toEqual(['kick'])
  })
})

describe('evalCode: p() pattern registration', () => {
  it('stages a named control pattern', () => {
    const r = run(`p('a', n('0 3 5').sound('acid'))`)
    expect(r.ok).toBe(true)
    expect([...r.patterns.keys()]).toEqual(['a'])
    expect(r.patterns.get('a')).toBeInstanceOf(Pattern)
  })

  it('same name twice in one eval: last wins', () => {
    const r = run(`p('a', n('0'))\np('a', n('7'))`)
    expect(r.ok).toBe(true)
    expect(r.patterns.size).toBe(1)
    const evs = cycle0(r.patterns.get('a')!)
    expect(evs[0]!.value['n']).toBe(7)
  })

  it('rejects a non-Pattern value and an empty name', () => {
    expect(run(`p('a', 42)`).ok).toBe(false)
    expect(run(`p('', n('0'))`).ok).toBe(false)
  })
})

describe('evalCode: setCps staging', () => {
  it('stages a valid cps', () => {
    const r = run('setCps(1.5)')
    expect(r.ok).toBe(true)
    expect(r.cps).toBe(1.5)
  })

  it('clamps to [0.05, 4]', () => {
    expect(run('setCps(99)').cps).toBe(4)
    expect(run('setCps(0.001)').cps).toBe(0.05)
  })

  it('rejects non-finite / non-number', () => {
    expect(run(`setCps('fast')`).ok).toBe(false)
    expect(run('setCps(NaN)').ok).toBe(false)
  })

  it('is absent when never called', () => {
    expect(run('const z = 1').cps).toBeUndefined()
  })
})

describe('evalCode: sidechain staging', () => {
  it('stages a config, converting release seconds to releaseMs', () => {
    const r = run("sidechain('kick', { depth: 0.7 })")
    expect(r.ok).toBe(true)
    expect(r.sidechain).toEqual({ source: 'kick', depth: 0.7, releaseMs: 180 })
  })

  it('defaults depth 0.6 and release 0.18s (releaseMs 180)', () => {
    expect(run("sidechain('kick')").sidechain).toEqual({ source: 'kick', depth: 0.6, releaseMs: 180 })
    expect(run("sidechain('kick', { release: 0.25 })").sidechain).toEqual({
      source: 'kick',
      depth: 0.6,
      releaseMs: 250,
    })
  })

  it('last call wins', () => {
    expect(run("sidechain('a')\nsidechain('b', { depth: 0.5 })").sidechain).toEqual({
      source: 'b',
      depth: 0.5,
      releaseMs: 180,
    })
  })

  it('rejects a non-string or empty source', () => {
    expect(run('sidechain(42)').ok).toBe(false)
    expect(run("sidechain('')").ok).toBe(false)
  })

  it('stages a per-synth duck map into amounts', () => {
    const r = run("sidechain('kick', { depth: 0.7, duck: { arp: 1, pad: 0.4 } })")
    expect(r.ok).toBe(true)
    expect(r.sidechain).toEqual({
      source: 'kick',
      depth: 0.7,
      releaseMs: 180,
      amounts: { arp: 1, pad: 0.4 },
    })
  })

  it('omits amounts when no duck map is given', () => {
    expect(run("sidechain('kick')").sidechain).not.toHaveProperty('amounts')
  })

  it('rejects duck amounts that are not numbers in [0, 1]', () => {
    expect(run("sidechain('kick', { duck: { pad: 2 } })").ok).toBe(false)
    expect(run("sidechain('kick', { duck: { pad: -0.1 } })").ok).toBe(false)
    expect(run("sidechain('kick', { duck: { pad: 'x' } })").ok).toBe(false)
  })

  it('is absent when never called', () => {
    expect(run('const z = 1').sidechain).toBeUndefined()
  })

  it('is discarded when the eval later throws (all-or-nothing)', () => {
    const r = run("sidechain('kick')\nthrow new Error('late')")
    expect(r.ok).toBe(false)
    expect(r.sidechain).toBeUndefined()
  })
})

describe('evalCode: masterCompress staging', () => {
  it('stages a config with the given + default fields', () => {
    const r = run('masterCompress({ threshold: -12, ratio: 8 })')
    expect(r.ok).toBe(true)
    expect(r.masterComp).toEqual({ threshold: -12, ratio: 8, attack: 10, release: 120, knee: 6, makeup: 0 })
  })

  it('applies all compressor defaults when called bare', () => {
    expect(run('masterCompress()').masterComp).toEqual({
      threshold: -18, ratio: 4, attack: 10, release: 120, knee: 6, makeup: 0,
    })
  })

  it('last call wins', () => {
    expect(run('masterCompress({ ratio: 2 })\nmasterCompress({ ratio: 6 })').masterComp?.ratio).toBe(6)
  })

  it('rejects a non-numeric field', () => {
    expect(run("masterCompress({ ratio: 'x' })").ok).toBe(false)
    expect(run('masterCompress({ threshold: NaN })').ok).toBe(false)
  })

  it('is absent when never called', () => {
    expect(run('const z = 1').masterComp).toBeUndefined()
  })
})

describe('evalCode: all-or-nothing staging', () => {
  it('discards partial registrations when the eval later throws', () => {
    const r = run(`p('a', n('0'))\nconst k = ${SYNTH_SRC}\nthrow new Error('late')`)
    expect(r.ok).toBe(false)
    expect(r.patterns.size).toBe(0)
    expect(r.synths.size).toBe(0)
    expect(r.cps).toBeUndefined()
  })

  it('seals staging when the synchronous eval returns: async p() throws', async () => {
    let captured: Promise<unknown> | undefined
    const scope = {
      ...baseScope,
      capture: (x: Promise<unknown>) => {
        captured = x
      },
    }
    const r = evalCode(
      `capture(Promise.resolve().then(() => p('late', n('0'))).catch((e) => e.message))`,
      scope,
    )
    expect(r.ok).toBe(true)
    expect(r.patterns.size).toBe(0)
    expect(await captured).toMatch(/eval already completed — async registration is not supported/)
  })

  it('successive evals do not share staging maps', () => {
    const r1 = run(`p('a', n('0'))`)
    const r2 = run(`p('b', n('1'))`)
    expect([...r1.patterns.keys()]).toEqual(['a'])
    expect([...r2.patterns.keys()]).toEqual(['b'])
  })
})

describe('scope', () => {
  it('is frozen and exposes the documented vocabulary', () => {
    expect(Object.isFrozen(baseScope)).toBe(true)
    for (const name of [
      'synth', 'n', 'note', 'sound', 's', 'mini', 'm',
      'cat', 'fastcat', 'stack', 'timecat', 'silence', 'reify',
      'sine', 'sine2', 'cosine', 'saw', 'isaw', 'tri', 'square',
      'saw2', 'tri2', 'square2', 'rand', 'perlin', 'irand',
      'slider', 'xy', 'toggle', 'pick',
    ]) {
      expect(baseScope, `missing scope entry '${name}'`).toHaveProperty(name)
    }
    // p/defineSynth/setCps are per-eval (they mutate staging state).
    expect(baseScope).not.toHaveProperty('p')
    expect(baseScope).not.toHaveProperty('defineSynth')
    expect(baseScope).not.toHaveProperty('setCps')
    expect(baseScope).not.toHaveProperty('sidechain')
  })

  it('widget placeholders are identity-shaped', () => {
    const r = run(
      `p('a', n('0').ctrl('cutoff', slider(800, 80, 8000)))\n` +
        `setCps(toggle(true) ? 1 : 2)\nconst v = pick(3, 1, 2, 3)\nsetCps(v)`,
    )
    expect(r.ok).toBe(true)
    expect(r.cps).toBe(3)
    const evs = cycle0(r.patterns.get('a')!)
    expect(evs[0]!.value['cutoff']).toBe(800)
  })

  it('the design-doc acid line evals end to end', () => {
    const r = run(
      `const acid = synth(({ note, gate, param, adsr, saw, square, ladder }) => {\n` +
        `  const cutoff = param('cutoff', 800, { min: 80, max: 8000, curve: 'log' })\n` +
        `  const env = adsr(gate, { a: 0.003, d: 0.2, s: 0.3, r: 0.1 })\n` +
        `  const osc = saw(note.freq).mix(square(note.freq.mul(0.5)), 0.3)\n` +
        `  return ladder(osc, cutoff.mul(env.pow(2)), { res: 0.85 }).mul(env)\n` +
        `})\n` +
        `p('bass', n('0 0 3 5').scale('a minor').sound('acid')\n` +
        `  .ctrl('cutoff', sine.range(300, 2400).slow(2))\n` +
        `  .every(4, (x) => x.rev()))\n` +
        `setCps(0.6)`,
    )
    expect(r.ok).toBe(true)
    expect(r.diagnostics).toHaveLength(0)
    expect([...r.synths.keys()]).toEqual(['acid'])
    expect([...r.patterns.keys()]).toEqual(['bass'])
    expect(r.cps).toBe(0.6)
  })
})
