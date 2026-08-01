import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  follow, MAX_CHANNELS, VIZ_FNS, VIZ_GLOBALS, VIZ_PARAM_FIELD, VIZ_PARAM_PREFIX, VIZ_SYNTH_GLOBALS, vizLayout,
} from '../src/shaderviz/api'
import { buildPrelude } from '../src/shaderviz/renderer'
import { SECTIONS } from '../src/docs/content'

/* ------------------------------------------------------------------------- *
 * The visual API is ONE list (shaderviz/api.ts) with four consumers: the WGSL
 * prelude, the uniform packing, the editor's highlighting/completions, and the
 * docs table. It used to be four hand-written copies, and `dt` is what that
 * costs: packed into the uniform and uploaded every frame with no global to
 * read it through. Nothing failed, because nothing checked.
 * ------------------------------------------------------------------------- */

const read = (rel: string): string => readFileSync(join(__dirname, '..', 'src', rel), 'utf8')

describe('the visual API is declared once', () => {
  it('every global has a name, a type, a group and a real description', () => {
    for (const g of VIZ_GLOBALS) {
      expect(g.name, 'not a WGSL identifier').toMatch(/^[a-z][a-z0-9_]*$/)
      expect(['f32', 'vec2f']).toContain(g.type)
      expect(g.detail.length, `${g.name} needs a description`).toBeGreaterThan(12)
    }
    // names are unique, or one silently shadows another in the struct
    const names = VIZ_GLOBALS.map((g) => g.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('no consumer rebuilds the list', () => {
    // the tell is a literal set/array of the audio globals somewhere other
    // than api.ts — the exact shape the four copies had
    for (const rel of ['shaderviz/renderer.ts', 'editor/wgsl.ts', 'docs/content.ts']) {
      const src = read(rel)
      expect(src, `${rel} should import the list`).toMatch(/from '(\.\.\/)?(\.\/)?shaderviz\/api'|from '\.\/api'/)
      // 'treble' next to 'bass' in a literal is the signature of a copy
      const copy = /['"]bass['"][,\s]+['"]mid['"]/.test(src)
      expect(copy, `${rel} rebuilds the global list`).toBe(false)
    }
  })

  it('the uniform layout is WGSL-legal: vec2f aligned, block a multiple of 4', () => {
    const { index, base, fields } = vizLayout()
    for (const g of VIZ_GLOBALS) {
      expect(index[g.name], `${g.name} unplaced`).toBeTypeOf('number')
      // a vec2f needs 8-byte (2-float) alignment
      if (g.type === 'vec2f') expect(index[g.name]! % 2).toBe(0)
    }
    // array<vec4f> needs 16-byte (4-float) alignment
    expect(base % 4).toBe(0)
    expect(fields.length).toBeGreaterThanOrEqual(VIZ_GLOBALS.length)
  })

  it('vec2f values are placed before the scalars, whatever order they are authored in', () => {
    const { index } = vizLayout()
    const lastVec = Math.max(...VIZ_GLOBALS.filter((g) => g.type === 'vec2f').map((g) => index[g.name]! + 1))
    const firstScalar = Math.min(...VIZ_GLOBALS.filter((g) => g.type === 'f32').map((g) => index[g.name]!))
    expect(firstScalar).toBeGreaterThan(lastVec)
  })

  it('the generated families each have their own uniform array', () => {
    const fields = [...VIZ_SYNTH_GLOBALS.map((g) => g.field), VIZ_PARAM_FIELD]
    expect(new Set(fields).size, 'two families share one array').toBe(fields.length)
    for (const g of VIZ_SYNTH_GLOBALS) expect(g.prefix).toMatch(/^[a-z]+_$/)
    expect(VIZ_PARAM_PREFIX).toMatch(/^[a-z]+_$/)
    expect(MAX_CHANNELS % 4, 'channels pack into vec4f').toBe(0)
  })

  it('the docs table lists every global, generated not retyped', () => {
    const visuals = SECTIONS.find((s) => s.id === 'visuals')
    expect(visuals, 'no visuals section').toBeDefined()
    const rows = (visuals?.blocks ?? []).flatMap((b) => (b.kind === 'table' ? b.rows : []))
    const listed = new Set(rows.map((r) => (r[0] ?? '').replace(/`/g, '')))
    for (const g of VIZ_GLOBALS) {
      expect(listed.has(g.name), `${g.name} is missing from the docs table`).toBe(true)
    }
  })

  it('the helpers the prelude defines are the helpers the docs name', () => {
    const prelude = read('shaderviz/renderer.ts')
    for (const f of VIZ_FNS) expect(prelude).toContain(`fn ${f.name}(`)
  })

  /* No GPU here, so nothing in CI compiles the prelude. These assert the
   * shape a WGSL compiler would reject, which is the class of break this
   * change could plausibly cause. */
  describe('the generated prelude', () => {
    const src = buildPrelude(['kick', 'pad'], ['bright'])

    it('declares and publishes every global exactly once', () => {
      for (const g of VIZ_GLOBALS) {
        const decl = new RegExp(`^var<private> ${g.name}: ${g.type};$`, 'm')
        expect(src, `${g.name} not declared`).toMatch(decl)
        expect(src, `${g.name} not assigned`).toMatch(new RegExp(`^\\s+${g.name} = uni\\.${g.name};$`, 'm'))
        expect(src, `${g.name} not in the struct`).toMatch(new RegExp(`^\\s+${g.name}: ${g.type},$`, 'm'))
      }
    })

    it('generates a global per family per synth, and per param', () => {
      for (const g of VIZ_SYNTH_GLOBALS) {
        for (const s of ['kick', 'pad']) expect(src).toContain(`var<private> ${g.prefix}${s}: f32;`)
      }
      expect(src).toContain(`var<private> ${VIZ_PARAM_PREFIX}bright: f32;`)
    })

    it('indexes the vec4f arrays within bounds', () => {
      const lanes = MAX_CHANNELS / 4
      for (const m of src.matchAll(/uni\.(\w+)\[(\d+)\]\[(\d+)\]/g)) {
        expect(Number(m[2]), `${m[0]} row out of range`).toBeLessThan(lanes)
        expect(Number(m[3]), `${m[0]} lane out of range`).toBeLessThan(4)
      }
    })

    it('is brace-balanced and defines the entry points', () => {
      const open = (src.match(/\{/g) ?? []).length
      const close = (src.match(/\}/g) ?? []).length
      expect(open, 'unbalanced braces').toBe(close)
      expect(src).toContain('@vertex fn vs(')
      expect(src).toContain('@fragment fn fs(')
    })

    it('names no synth twice, however a program spells them', () => {
      // two synths sanitizing to one identifier would emit a duplicate global
      const dup = buildPrelude(['a-b', 'a_b'], [])
      const decls = [...dup.matchAll(/^var<private> (\w+):/gm)].map((m) => m[1]!)
      expect(new Set(decls).size).toBe(decls.length)
    })
  })

  /* Meters arrive at ~37 Hz and frames run at 60+, so a value written through
   * raw is held for a frame and jumps the next. This is the easing that fixes
   * it, and the asymmetry is the part that is easy to write backwards. */
  describe('meter smoothing', () => {
    const FRAME = 1 / 60

    it('moves toward the target and settles on it', () => {
      let v = 0
      for (let i = 0; i < 200; i++) v = follow(v, 1, FRAME, 30, 30)
      expect(v).toBeCloseTo(1, 5)
      // and monotonically, never overshooting
      let prev = 0
      let x = 0
      for (let i = 0; i < 50; i++) {
        x = follow(x, 1, FRAME, 30, 30)
        expect(x).toBeGreaterThanOrEqual(prev)
        expect(x).toBeLessThanOrEqual(1)
        prev = x
      }
    })

    it('is frame-rate independent: 120 fps reaches the same place as 60', () => {
      let a = 0
      for (let i = 0; i < 60; i++) a = follow(a, 1, FRAME, 40, 40)
      let b = 0
      for (let i = 0; i < 120; i++) b = follow(b, 1, FRAME / 2, 40, 40)
      expect(b).toBeCloseTo(a, 3)
    })

    it('falls fast and rises slow when asked to, which is what keeps a duck snappy', () => {
      // one frame of a duck snapping 1 -> 0.2 with a 3 ms fall
      const down = follow(1, 0.2, FRAME, 45, 3)
      expect(down, 'the snap should be essentially instant').toBeLessThan(0.21)
      // and one frame of it releasing back, which should barely move
      const up = follow(0.2, 1, FRAME, 45, 3)
      expect(up, 'the release should be eased').toBeLessThan(0.5)
      expect(up).toBeGreaterThan(0.2)
    })

    it('a zero time constant jumps, and negative dt cannot move it backwards', () => {
      expect(follow(0, 1, FRAME, 0, 0)).toBe(1)
      expect(follow(0.5, 1, -1, 30, 30)).toBeCloseTo(0.5, 6)
    })
  })

  it('dt is reachable — the bug that motivated all of this', () => {
    // it was in the struct and in the packing, with no var<private> to read it
    expect(VIZ_GLOBALS.some((g) => g.name === 'dt')).toBe(true)
    const src = read('shaderviz/renderer.ts')
    expect(src).toContain('var<private> ${g.name}: ${g.type}')
  })
})
