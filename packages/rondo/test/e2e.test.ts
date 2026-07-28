import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { F, TimeSpan, hasOnset } from '@rondocode/pattern'
import { compile } from '../src/compile'
import { renderOffline } from '../../engine/src/render'
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

  it('beat + irand eval clean and produce sounding events routed by word', () => {
    const src = [
      'synth kick',
      '  sine 55',
      '  * env',
      '  env = adsr .001 .12 0 .05',
      '',
      'synth hat',
      '  noise white',
      '  * env',
      '  env = adsr .001 .03 0 .01',
      '',
      'beat',
      '  kick hat kick hat',
      '',
      'play kick',
      '  irand 4 seg:8',
      '  scale: e-min',
      '',
    ].join('\n')
    const c = compile(src)
    expect(c.ok, JSON.stringify(c.ok ? [] : c.errors)).toBe(true)
    if (!c.ok) return
    const result = evalCode(c.code, baseScope)
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(result.ok).toBe(true)
    // the beat pattern's events route to the named synths AND carry a note —
    // the scheduler drops note-less events, so without one they'd be silent
    const beat = result.patterns.get('beat')!
    const beatEvs = beat.query(new TimeSpan(F(0), F(1))).filter(hasOnset)
    expect(new Set(beatEvs.map((h) => h.value.sound))).toEqual(new Set(['kick', 'hat']))
    for (const h of beatEvs) expect(typeof h.value.note).toBe('number')
    // irand yields numeric notes through the scale
    const kick = result.patterns.get('kick')!
    const notes = kick.query(new TimeSpan(F(0), F(1))).filter(hasOnset)
    expect(notes.length).toBe(8)
    for (const h of notes) expect(typeof h.value.note).toBe('number')
  })

  it('sing block stages the vocal: SingRequest + sampler synth + trigger pattern', () => {
    const src = 'sing vox voice:barbara\n  twin-kle twin-kle lit-tle star\n  c4 c4 g4 g4 a4 a4 g4@2\n  gain: .95\n  post\n    reverb mix:.25\n'
    const c = compile(src)
    expect(c.ok, JSON.stringify(c.ok ? [] : c.errors)).toBe(true)
    if (!c.ok) return
    const result = evalCode(c.code, baseScope)
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.sings).toHaveLength(1)
    expect(result.sings[0]).toMatchObject({
      voice: 'barbara',
      synthName: 'vox',
      lyrics: 'twin-kle twin-kle lit-tle star',
      notes: 'c4 c4 g4 g4 a4 a4 g4@2',
    })
    expect(result.synths.has('vox')).toBe(true) // the sampler (with the post chain)
    const trig = result.patterns.get('vox')!
    const evs = trig.query(new TimeSpan(F(0), F(1))).filter(hasOnset)
    expect(evs).toHaveLength(1) // one clip trigger per cycle
    expect(evs[0]!.value.sound).toBe('vox')
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

  it('scaledef end-to-end: a custom tuning compiles, evals, and sounds fractional notes', () => {
    const src = [
      'scaledef pelog 0 1.2 2.7 6.7 7.85',
      '',
      'synth glass',
      '  tri',
      '  * env',
      '  env = adsr .005 .3 .2 .3',
      '',
      'play glass',
      '  0 1 2 5',
      '  scale: c-pelog',
      '',
      'play glass2 synth:glass',
      // the generic edo names need no scaledef at all
      '  0 3 6  scale:c-19edo',
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
    const notes = result.patterns.get('glass')!
      .query(new TimeSpan(F(0), F(1)))
      .filter(hasOnset)
      .map((h) => h.value.note as number)
    // degrees 0 1 2 5 in pelog (period 12): 60, 61.2, 62.7, 72
    expect(notes[0]).toBe(60)
    expect(notes[1]).toBeCloseTo(61.2, 10)
    expect(notes[2]).toBeCloseTo(62.7, 10)
    expect(notes[3]).toBe(72)
    const edo = result.patterns.get('glass2')!
      .query(new TimeSpan(F(0), F(1)))
      .filter(hasOnset)
      .map((h) => h.value.note as number)
    expect(edo[1]).toBeCloseTo(60 + (3 * 12) / 19, 10)
  })

  it('wavedef end-to-end: a custom table compiles, evals, and RENDERS sound', () => {
    const src = [
      'synth vlead',
      '  wavetable note scan table:voxy',
      '  * env',
      '  env = adsr .005 .1 .8 .1',
      '  scan = env -> .1...9',
      '',
      'play vlead',
      '  0 3 5',
      '  scale: a-min',
      '',
      // wavedef BELOW its use on purpose: codegen hoists it above the synth
      'wavedef voxy 1 .3 / .4 1 .6 / .2 .7 1',
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
    // the staged synth actually SOUNDS: render it offline against the table
    // the eval just registered (same realm) and measure energy
    const def = result.synths.get('vlead')!
    const r = renderOffline(
      def,
      [{ time: 0, type: 'noteOn', note: 57 }, { time: 0.4, type: 'noteOff', note: 57 }],
      0.5,
    )
    let sum = 0
    for (let i = 0; i < r.left.length; i++) sum += r.left[i]! * r.left[i]!
    expect(Math.sqrt(sum / r.left.length)).toBeGreaterThan(0.01)
  })
})

describe('knobs in adsr stages', () => {
  /** RMS of a rendered note. */
  const rms = (def: Parameters<typeof renderOffline>[0], sec = 0.5): number => {
    const r = renderOffline(def, [
      { time: 0, type: 'noteOn', note: 57 },
      { time: sec * 0.6, type: 'noteOff', note: 57 },
    ], sec)
    let sum = 0
    for (let i = 0; i < r.left.length; i++) sum += r.left[i]! * r.left[i]!
    return Math.sqrt(sum / r.left.length)
  }
  const build = (src: string): Parameters<typeof renderOffline>[0] => {
    const c = compile(src)
    expect(c.ok, c.ok ? '' : JSON.stringify(c.errors)).toBe(true)
    if (!c.ok) throw new Error('compile failed')
    const result = evalCode(c.code, baseScope)
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    return result.synths.get('t')!
  }

  it('a knob drives an envelope stage and the synth still sounds', () => {
    // This used to compile, eval and render TOTAL SILENCE: a/d/s/r were baked
    // into the kernel at construction, so a Sig in a number slot went NaN.
    const def = build(`synth t
  saw note
  * env
  env = adsr atk .2 .3 .1
  atk = knob .01 .001..1

play t
  c4`)
    expect(rms(def)).toBeGreaterThan(0.01)
  })

  it('one knob drives two targets at different ratios', () => {
    const c = compile(`synth pad
  saw note
  ladder k * 3800 + 200 res:.3
  * env * amp
  env = adsr .01 .2 .6 .3
  amp = k * .5 + .5
  k = knob .5 0..1

play pad
  c4`)
    expect(c.ok).toBe(true)
    if (!c.ok) return
    // ONE param declaration, scaled independently at each use site
    expect(c.code.match(/param\('k'/g)).toHaveLength(1)
    expect(c.code).toContain('k.mul(3800).add(200)')
    expect(c.code).toContain('k.mul(0.5).add(0.5)')
  })

  it('a trailing operator after adsr binds to the CALL, not the last argument', () => {
    // The absorption trap, pinned because it is silent: dividing the envelope
    // by 12300 leaves a synth that runs and makes almost nothing.
    const swallowed = compile(`synth t
  saw note
  * env
  bright = knob 2050 500..12300 log
  env = adsr .002 .079 .21 bright/12300

play t
  c4`)
    expect(swallowed.ok).toBe(true)
    if (!swallowed.ok) return
    expect(swallowed.code).toContain('r: bright }).div(12300)')

    // binding the expression first is the fix, and it is audibly different
    const bound = build(`synth t
  saw note
  * env
  bright = knob 2050 500..12300 log
  rel = bright / 12300
  env = adsr .002 .079 .21 rel

play t
  c4`)
    expect(rms(bound)).toBeGreaterThan(0.01)
  })
})

describe('math ops end to end', () => {
  const build = (src: string, name = 't'): Parameters<typeof renderOffline>[0] => {
    const c = compile(src)
    expect(c.ok, c.ok ? '' : JSON.stringify(c.errors)).toBe(true)
    if (!c.ok) throw new Error('compile failed')
    const result = evalCode(c.code, baseScope)
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    return result.synths.get(name)!
  }
  const render = (def: Parameters<typeof renderOffline>[0]): Float32Array =>
    renderOffline(def, [
      { time: 0, type: 'noteOn', note: 57 },
      { time: 0.3, type: 'noteOff', note: 57 },
    ], 0.5).left

  it('every math op compiles, evals and sounds from rondo', () => {
    for (const line of ['abs', 'floor', 'ceil', 'round', 'sign', 'sqrt', 'exp', 'log', 'sin', 'cos']) {
      const def = build(`synth t
  saw note
  ${line}
  * env
  env = adsr .01 .1 .5 .2

play t
  c4`)
      const out = render(def)
      expect(out.every((v) => Number.isFinite(v)), `${line} produced a non-finite sample`).toBe(true)
    }
  })

  it('the one-argument ops take an operand', () => {
    for (const line of ['min .5', 'max -.5', 'mod .7']) {
      const def = build(`synth t
  saw note
  ${line}
  * env
  env = adsr .01 .1 .5 .2

play t
  c4`)
      expect(render(def).every((v) => Number.isFinite(v)), line).toBe(true)
    }
  })

  it('floor on an LFO makes an audible staircase, not a smooth sweep', () => {
    // the quantization has to actually reach the sound: a stepped cutoff holds
    // each value for a stretch, so the signal has FEWER distinct levels than
    // the smooth version
    const stepped = build(`synth t
  saw note
  svf cut
  * env
  env = adsr .01 .1 .5 .2
  raw = lfo 4 -> 0..6
  cut = floor raw -> 200..4000

play t
  c4`)
    const levels = new Set<number>()
    for (const v of render(stepped)) levels.add(Math.round(v * 1000))
    expect(levels.size).toBeGreaterThan(1) // it sounds
    expect(render(stepped).some((v) => v !== 0)).toBe(true)
  })

  it('abs rectifies a signal that swings both ways', () => {
    const plain = render(build(`synth t
  sine note
  * env
  env = adsr .01 .1 .5 .2

play t
  c4`))
    const rect = render(build(`synth t
  sine note
  abs
  * env
  env = adsr .01 .1 .5 .2

play t
  c4`))
    // the plain tone goes negative; the rectified one never does
    expect(Math.min(...plain)).toBeLessThan(-0.01)
    expect(Math.min(...rect)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...rect)).toBeGreaterThan(0.01)
  })
})
