import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { F, TimeSpan, hasOnset } from '@rondocode/pattern'
import { compile } from '../src/compile'
// Deep source imports across packages are the established pattern here (see
// packages/server/src/render-runner.ts). Vitest/Vite resolve the raw TS.
import { evalCode } from '../../app/src/session/evalCode'
import { baseScope } from '../../app/src/session/scope'

const acid = readFileSync(fileURLToPath(new URL('../examples/acid.rondo', import.meta.url)), 'utf8')
const pad = readFileSync(fileURLToPath(new URL('../examples/pad.rondo', import.meta.url)), 'utf8')
const wob = readFileSync(fileURLToPath(new URL('../examples/wob.rondo', import.meta.url)), 'utf8')
const club = readFileSync(fileURLToPath(new URL('../examples/club.rondo', import.meta.url)), 'utf8')

describe('rondo end-to-end: source → transpile → evalCode → sound', () => {
  it('the acid example compiles and evals clean with no error diagnostics', () => {
    const c = compile(acid)
    expect(c.ok, JSON.stringify(c.errors)).toBe(true)
    if (!c.ok) return
    const result = evalCode(c.code, baseScope)
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.synths.has('acid')).toBe(true)
    expect(result.patterns.has('acid')).toBe(true)
    expect(result.cps).toBe(0.6)
  })

  it('the compiled pattern produces sounding events (numeric note + routed sound)', () => {
    const c = compile(acid)
    if (!c.ok) throw new Error(JSON.stringify(c.errors))
    const result = evalCode(c.code, baseScope)
    const pat = result.patterns.get('acid')!
    const sounding = pat
      .query(new TimeSpan(F(0), F(2)))
      .filter(hasOnset)
      .filter((h) => typeof h.value.note === 'number' && typeof h.value.sound === 'string')
    expect(sounding.length).toBeGreaterThan(0)
    for (const h of sounding) expect(result.synths.has(h.value.sound as string)).toBe(true)
  })

  it('env/eq/vocoder sugar evals clean against the real scope (last three ctx names)', () => {
    const src = [
      'synth talk',
      '  supersaw detune:.4',
      '  vocoder m bands:20',
      '  eq hp 170 highshelf 7000 4',
      '  * e',
      '  m = noise',
      '  e = env .005 1 .15 .4 .5 .6 release:.3 curve:3',
      '',
      'play talk',
      '  0 3 5  scale:a-min',
      '',
    ].join('\n')
    const c = compile(src)
    expect(c.ok, JSON.stringify(c.ok ? [] : c.errors)).toBe(true)
    if (!c.ok) return
    const result = evalCode(c.code, baseScope)
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.synths.has('talk')).toBe(true)
  })

  it('the pad example (post chain + drivable post param) evals clean', () => {
    const c = compile(pad)
    expect(c.ok, JSON.stringify(c.errors)).toBe(true)
    if (!c.ok) return
    const result = evalCode(c.code, baseScope)
    // a .ctrl('wet') driving a POST param('wet') is exactly the interaction the
    // API audit made valid — it must eval with no error diagnostics
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.synths.get('pad')?.post).toBeDefined()
  })

  it('the wob example (registry batch: supersaw/lfo/shape/delay/tanh + mono glide) evals clean and sounds', () => {
    const c = compile(wob)
    expect(c.ok, JSON.stringify(c.ok ? [] : c.errors)).toBe(true)
    if (!c.ok) return
    const result = evalCode(c.code, baseScope)
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(result.ok).toBe(true)
    const sounding = result.patterns.get('wob')!
      .query(new TimeSpan(F(0), F(2)))
      .filter(hasOnset)
      .filter((h) => typeof h.value.note === 'number' && typeof h.value.sound === 'string')
    expect(sounding.length).toBeGreaterThan(0)
  })

  it('the club example (pure rondo: bus + sidechain + master + chords + gated) stages everything', () => {
    const c = compile(club)
    expect(c.ok, JSON.stringify(c.ok ? [] : c.errors)).toBe(true)
    if (!c.ok) return
    const result = evalCode(c.code, baseScope)
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(result.ok).toBe(true)
    // every song-level staging feature landed, no js{ } anywhere in the source
    expect(club).not.toContain('js{')
    expect(result.sidechain?.source).toBe('kick')
    expect(result.sidechain?.amounts).toBeDefined()
    expect(result.masterComp).toBeDefined()
    expect(result.buses.has('space')).toBe(true)
    expect(result.sends).toContainEqual({ synth: 'stab', bus: 'space', amount: 0.3 })
    // sections arrange into ONE 'song' pattern; the drop (cycles 4..12) routes
    // events to all three synths
    const song = result.patterns.get('song')!
    const sounds = new Set(
      song.query(new TimeSpan(F(4), F(6)))
        .filter(hasOnset)
        .filter((h) => typeof h.value.note === 'number' && typeof h.value.sound === 'string')
        .map((h) => h.value.sound as string),
    )
    for (const name of ['kick', 'sub', 'stab']) expect(sounds.has(name), name).toBe(true)
  })

  it('parity via escape hatch: a js{ … } sidechain evals clean through the real engine', () => {
    // sidechain has no rondo sugar yet — reach it through js{ … }. This proves
    // the escape hatch gives total parity today: anything the JS DSL can do,
    // rondo can express now, then gets sugared later.
    const src = [
      'synth kick',
      '  sine 60',
      '  * env',
      '  env = adsr .001 .2 0 .05',
      '',
      'play kick', // note names → numeric notes reach the engine (drum convention)
      '  c2 ~ c2 ~',
      '',
      'js',
      "  sidechain('kick', { depth: 0.6, release: 0.12 })",
      '',
      'cps .5',
      '',
    ].join('\n')
    const c = compile(src)
    expect(c.ok, JSON.stringify(c.ok ? [] : c.errors)).toBe(true)
    if (!c.ok) return
    const result = evalCode(c.code, baseScope)
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.sidechain?.source).toBe('kick') // the js{ … } sidechain staged
    const sounding = result.patterns.get('kick')!
      .query(new TimeSpan(F(0), F(2)))
      .filter(hasOnset)
      .filter((h) => typeof h.value.note === 'number' && typeof h.value.sound === 'string')
    expect(sounding.length).toBeGreaterThan(0)
  })
})
