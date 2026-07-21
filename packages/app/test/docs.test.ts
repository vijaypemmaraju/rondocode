import { describe, expect, it } from 'vitest'
import { Pattern } from '@rondocode/pattern'
import { synth } from '@rondocode/engine'
import type { PostCtx, Sig, SynthCtx } from '@rondocode/engine'
import { baseScope } from '../src/session/scope'
import { DSL_DOCS, docsByName, docsOfKind } from '../src/docs/dsl-docs'

/* ------------------------------------------------------------------------- *
 * Anti-drift: the docs data is pinned BIDIRECTIONALLY against the live
 * objects. Every name the runtime actually exposes must have a DocEntry of
 * the right kind, and every DocEntry of these kinds must name something
 * that exists. Add a combinator, a control, a ctx member or a Sig method
 * without documenting it — or document a name that is not real — and this
 * suite fails.
 * ------------------------------------------------------------------------- */

const namesOfKind = (kind: (typeof DSL_DOCS)[number]['kind']): string[] =>
  docsOfKind(kind).map((e) => e.name)

const assertBidirectional = (docNames: string[], liveNames: string[], what: string): void => {
  const docs = new Set(docNames)
  const live = new Set(liveNames)
  const undocumented = [...live].filter((n) => !docs.has(n))
  const phantom = [...docs].filter((n) => !live.has(n))
  expect(undocumented, `${what}: live names missing a DocEntry`).toEqual([])
  expect(phantom, `${what}: DocEntries naming nothing live`).toEqual([])
  // no duplicate entries for one (name, kind)
  expect(docNames.length, `${what}: duplicate DocEntries`).toBe(docs.size)
}

describe('docs coverage: globals', () => {
  it('covers every baseScope key plus the per-eval staging names, bidirectionally', () => {
    // p / defineSynth / setCps are injected per-eval by evalCode() (see
    // STAGING_NAMES in src/session/evalCode.ts) — part of the vocabulary
    // even though they are not baseScope keys.
    const live = [...Object.keys(baseScope), 'p', 'defineSynth', 'setCps', 'sidechain', 'masterCompress']
    assertBidirectional(namesOfKind('global'), live, 'globals')
  })
})

describe('docs coverage: Pattern methods', () => {
  it('covers every public Pattern.prototype method, bidirectionally', () => {
    // Internal plumbing, excluded deliberately: each is marked "not part of
    // the musical API" in pattern.ts (withQueryTime / withHapTime /
    // splitQueries / compressSpan) or is TS-private (bindWhole).
    const INTERNAL = new Set(['constructor', 'bindWhole', 'withQueryTime', 'withHapTime', 'splitQueries', 'compressSpan'])
    const live = Object.getOwnPropertyNames(Pattern.prototype).filter(
      (n) =>
        !INTERNAL.has(n) &&
        typeof (Pattern.prototype as unknown as Record<string, unknown>)[n] === 'function',
    )
    expect(live.length).toBeGreaterThan(40) // sanity: the prototype is populated
    assertBidirectional(namesOfKind('pattern-method'), live, 'pattern methods')
  })
})

describe('docs coverage: synth ctx and Sig', () => {
  // Probe a real synth() build: capture the ctx object and one Sig.
  let ctx!: SynthCtx
  let post!: PostCtx
  let sig!: Sig
  synth(
    (c) => {
      ctx = c
      sig = c.sine(440)
      return sig
    },
    // Probe the post-chain ctx too — its extra surface (`input`) is documented
    // under the same 'synth-ctx' kind, so the coverage set is the UNION.
    (pc) => {
      post = pc
      return pc.input
    },
  )

  it('covers every SynthCtx + PostCtx member, bidirectionally', () => {
    const live = [...new Set([...Object.keys(ctx), ...Object.keys(post)])]
    assertBidirectional(namesOfKind('synth-ctx'), live, 'synth ctx')
  })

  it('covers every Sig method, bidirectionally', () => {
    // 'bin' is SigImpl's TS-private binary-node helper (builder.ts).
    const INTERNAL = new Set(['constructor', 'bin'])
    const proto = Object.getPrototypeOf(sig) as Record<string, unknown>
    const live = Object.getOwnPropertyNames(proto).filter(
      (n) => !INTERNAL.has(n) && typeof proto[n] === 'function',
    )
    expect(live.length).toBeGreaterThan(5) // sanity
    assertBidirectional(namesOfKind('sig-method'), live, 'sig methods')
  })
})

describe('docs coverage: mini-notation syntax', () => {
  it('documents exactly the v1 grammar operators', () => {
    // Pinned by hand against the grammar in packages/pattern/src/mini.ts
    // (header comment, "Grammar (v1)"). A grammar change updates BOTH the
    // parser and this list + the mini-syntax DocEntries.
    const GRAMMAR = [
      'mini:seq', // a b c   — sequence
      'mini:~', //   ~       — rest
      'mini:_', //   _       — elongate previous step
      'mini:[]', //  [a b]   — subgroup (',' stacks)
      'mini:<>', //  <a b>   — alternation, one per cycle
      'mini:{}', //  {..}%n  — polymeter
      'mini:*', //   a*n     — faster within the slot
      'mini:/', //   a/n     — slower across cycles
      'mini:!', //   a!n     — duplicate step
      'mini:@', //   a@n     — weight
      'mini:(p,s,r)', // a(3,8) — euclidean rhythm
      'mini:?', //   a?p     — random drop
      'mini:|', //   a | b   — random choice per cycle
    ]
    assertBidirectional(namesOfKind('mini-syntax'), GRAMMAR, 'mini syntax')
  })
})

describe('docs data shape', () => {
  it('every entry has a non-empty signature and a one-sentence summary', () => {
    for (const e of DSL_DOCS) {
      expect(e.signature.length, e.name).toBeGreaterThan(0)
      expect(e.summary.length, e.name).toBeGreaterThan(10)
    }
  })

  it('docsByName maps every entry and groups collisions', () => {
    expect(docsByName.get('mul')?.map((e) => e.kind).sort()).toEqual(['pattern-method', 'sig-method'])
    const total = [...docsByName.values()].reduce((a, l) => a + l.length, 0)
    expect(total).toBe(DSL_DOCS.length)
  })
})
