import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { compile } from '../src/compile'
import { decompile } from '../src/decompile'

/* The decompiler's contract:
 * 1. ROUND-TRIP — for real rondo programs: compile → decompile → compile
 *    again yields the SAME JavaScript (semantics + sugar both survive).
 * 2. TOTALITY — arbitrary JS decompiles to something that compiles back to
 *    equivalent code, with unrecognized statements wrapped verbatim in js
 *    blocks (never lost, never mangled). */

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

const EXAMPLES = ['acid', 'pad', 'wob', 'club', 'drums', 'poly'].map((name) => ({
  name,
  src: read(`../examples/${name}.rondo`),
}))

describe('decompile round-trips', () => {
  it('env/eq/vocoder sugar survives the round trip', () => {
    const src = [
      'synth talk',
      '  supersaw detune:.4',
      '  vocoder m bands:20 response:0.02',
      '  eq hp 170 peak 300 -3 2 highshelf 7000 4',
      '  * e',
      '  m = noise',
      '  e = env 0.005 1 0.15 0.4 0.5 0.6 release:0.3 curve:3 loop:1',
      '',
    ].join('\n')
    const first = compile(src)
    expect(first.ok, JSON.stringify(first.ok ? [] : first.errors)).toBe(true)
    if (!first.ok) return
    const rondo2 = decompile(first.code)
    const second = compile(rondo2)
    expect(second.ok, `re-compile: ${JSON.stringify(second.ok ? [] : second.errors)}\n--- decompiled ---\n${rondo2}`).toBe(true)
    if (!second.ok) return
    expect(second.code).toBe(first.code)
  })

  it('tempo-synced lfo/delay survive the round trip', () => {
    const src = [
      'synth wob mono glide:.05',
      '  supersaw detune:.5 mix:.85',
      '  ladder cut res:.8',
      '  delay 0.1875 0.25 maxtime:1 sync:1',
      '  * e',
      '  cut = lfo 0.125 tri sync:1 -> 150..3200',
      '  e = adsr 0.005 0.1 0.9 0.06',
      '',
    ].join('\n')
    const first = compile(src)
    expect(first.ok, JSON.stringify(first.ok ? [] : first.errors)).toBe(true)
    if (!first.ok) return
    const rondo2 = decompile(first.code)
    // sync survives as the bool named arg, not as a dropped opt or a js{ } bail
    expect(rondo2).toContain('sync:1')
    expect(rondo2).not.toContain('js{')
    const second = compile(rondo2)
    expect(second.ok, `re-compile: ${JSON.stringify(second.ok ? [] : second.errors)}\n--- decompiled ---\n${rondo2}`).toBe(true)
    if (!second.ok) return
    expect(second.code).toBe(first.code)
  })

  it('sample slice args survive the round trip, bools included', () => {
    const src = [
      'synth chop',
      '  sample take1 root:48 start:.25 end:.75 reverse:1 slices:8 fade:.004',
      '  * a',
      '  a = adsr .001 .1 1 .02',
      '',
    ].join('\n')
    const first = compile(src)
    expect(first.ok, JSON.stringify(first.ok ? [] : first.errors)).toBe(true)
    if (!first.ok) return
    const rondo2 = decompile(first.code)
    expect(rondo2).toContain('sample take1 root:48 start:0.25 end:0.75 reverse:1 slices:8 fade:0.004')
    const second = compile(rondo2)
    expect(second.ok, `re-compile: ${JSON.stringify(second.ok ? [] : second.errors)}`).toBe(true)
    if (!second.ok) return
    expect(second.code).toBe(first.code)
  })

  it('beat blocks and irand notation survive the round trip', () => {
    const src = [
      'synth kick',
      '  sine 55',
      '  * env',
      '  env = adsr 0.001 0.12 0 0.05',
      '',
      'beat',
      '  kick ~ kick ~',
      '  every 4: rev',
      '',
      'beat fills',
      '  ~ kick ~ kick',
      '',
      'play kick',
      '  irand 4 seg:8',
      '  scale: e-min',
      '',
    ].join('\n')
    const first = compile(src)
    expect(first.ok, JSON.stringify(first.ok ? [] : first.errors)).toBe(true)
    if (!first.ok) return
    const rondo2 = decompile(first.code)
    expect(rondo2).toContain('beat\n')
    expect(rondo2).toContain('beat fills')
    expect(rondo2).toContain('irand 4 seg:8')
    const second = compile(rondo2)
    expect(second.ok, `re-compile: ${JSON.stringify(second.ok ? [] : second.errors)}\n--- decompiled ---\n${rondo2}`).toBe(true)
    if (!second.ok) return
    expect(second.code).toBe(first.code)
  })

  it('beat velocity suffixes survive the round trip (flat rows zip back)', () => {
    const src = 'beat\n  kick ~ kick:0.6 ~\n  ~ hat:0.3 ~ hat\n'
    const first = compile(src)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const rondo2 = decompile(first.code)
    expect(rondo2).toContain('kick ~ kick:0.6 ~')
    expect(rondo2).toContain('~ hat:0.3 ~ hat')
    const second = compile(rondo2)
    expect(second.ok).toBe(true)
    if (second.ok) expect(second.code).toBe(first.code)
    // a STRUCTURED gain bails to a js block — totality holds
    const rich = compile('beat\n  [hat:0.9 hat]*2 ~\n')
    expect(rich.ok, JSON.stringify(rich.ok ? [] : rich.errors)).toBe(true)
    if (!rich.ok) return
    const d2 = decompile(rich.code)
    expect(d2).toContain('js\n')
    const back = compile(d2)
    expect(back.ok).toBe(true)
    if (back.ok) expect(back.code).toBe(rich.code)
  })

  it('sing blocks survive the round trip (pairs come back as one joined pair)', () => {
    const src = [
      'sing vox voice:barbara',
      '  twin-kle twin-kle lit-tle star',
      '  c4 c4 g4 g4 a4 a4 g4@2',
      '  how I won-der what you are',
      '  f4 f4 e4 e4 d4 d4 c4@2',
      '  gain: .95',
      '  post',
      '    reverb room:.8 mix:.25',
      '',
    ].join('\n')
    const first = compile(src)
    expect(first.ok, JSON.stringify(first.ok ? [] : first.errors)).toBe(true)
    if (!first.ok) return
    const rondo2 = decompile(first.code)
    expect(rondo2).toContain('sing vox voice:barbara')
    expect(rondo2).toContain('twin-kle twin-kle lit-tle star how I won-der what you are')
    const second = compile(rondo2)
    expect(second.ok, `re-compile: ${JSON.stringify(second.ok ? [] : second.errors)}\n--- decompiled ---\n${rondo2}`).toBe(true)
    if (!second.ok) return
    expect(second.code).toBe(first.code)
  })

  it('a sing() without opts.name bails to a js block (hash-named vocal — totality holds)', () => {
    const js = "p('vox', sing('barbara', 'la la', 'c4 e4'))\n"
    const r = decompile(js)
    expect(r).toContain('js\n')
    const back = compile(r)
    expect(back.ok).toBe(true)
    if (back.ok) expect(back.code).toContain("sing('barbara', 'la la', 'c4 e4')")
  })

  it('a channel routed to a different synth round-trips via play synth:', () => {
    const src = 'synth keys\n  saw\n\nplay pad synth:keys\n  <Dm7 G7>\n  dur: 0.95\n'
    const first = compile(src)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const rondo2 = decompile(first.code)
    expect(rondo2).toContain('play pad synth:keys')
    const second = compile(rondo2)
    expect(second.ok).toBe(true)
    if (second.ok) expect(second.code).toBe(first.code)
  })

  for (const { name, src } of EXAMPLES) {
    it(`${name}.rondo: compile → decompile → compile is a fixed point`, () => {
      const first = compile(src)
      expect(first.ok, JSON.stringify(first.ok ? [] : first.errors)).toBe(true)
      if (!first.ok) return
      const rondo2 = decompile(first.code)
      const second = compile(rondo2)
      expect(second.ok, `${name} re-compile: ${JSON.stringify(second.ok ? [] : second.errors)}\n--- decompiled ---\n${rondo2}`).toBe(true)
      if (!second.ok) return
      expect(second.code).toBe(first.code)
    })
  }
})

describe('decompile round-trips (audit additions)', () => {
  /** compile → decompile → compile must be byte-identical. */
  function fixedPoint(src: string): { rondo2: string; code: string } {
    const first = compile(src)
    expect(first.ok, JSON.stringify(first.ok ? [] : first.errors)).toBe(true)
    if (!first.ok) throw new Error('unreachable')
    const rondo2 = decompile(first.code)
    const second = compile(rondo2)
    expect(second.ok, `re-compile: ${JSON.stringify(second.ok ? [] : second.errors)}\n--- decompiled ---\n${rondo2}`).toBe(true)
    if (!second.ok) throw new Error('unreachable')
    expect(second.code).toBe(first.code)
    return { rondo2, code: first.code }
  }

  it('visual blocks survive the round trip (WGSL verbatim)', () => {
    const { rondo2 } = fixedPoint(
      'synth s\n  saw\n\nplay s\n  0\n\nvisual\n  fn render(uv: vec2f) -> vec4f {\n    return vec4f(uv, 0.0, 1.0);\n  }\n',
    )
    expect(rondo2).toContain('visual\n')
    expect(rondo2).toContain('  fn render(uv: vec2f) -> vec4f {')
    expect(rondo2).toContain('    return vec4f(uv, 0.0, 1.0);') // nested indent kept
  })

  it('fast: ctrl values and pan: method modifiers round-trip', () => {
    const { rondo2 } = fixedPoint(
      'synth s\n  saw\n\nplay s\n  0 2\n  cutoff: sine 200..2400 fast:2\n  pan: sine slow:4\n',
    )
    expect(rondo2).toContain('cutoff: sine 200..2400 fast:2')
    expect(rondo2).toContain('pan: sine slow:4')
  })

  it('sing modifiers beyond gain round-trip: ctrl, dur, fn-comb', () => {
    const { rondo2 } = fixedPoint('sing v\n  la la\n  c4 e4\n  air: .3\n  dur: .9\n  every 2: rev\n')
    expect(rondo2).toContain('air: 0.3')
    expect(rondo2).toContain('dur: 0.9')
    expect(rondo2).toContain('every 2: rev')
  })

  it('unison-shaping header opts + dualsvf lines round-trip', () => {
    const { rondo2 } = fixedPoint(
      'synth stack unison:5 curve:2 blend:.6 octaves:2\n  saw\n  dualsvf 400 4000 mode:parallel a:lp b:hp res:.3\n\nplay stack\n  0 2\n',
    )
    expect(rondo2).toContain('synth stack unison:5 curve:2 blend:0.6 octaves:2')
    expect(rondo2).toContain('dualsvf 400 4000 res:0.3 mode:parallel a:lp b:hp')
  })

  it('width/transient/flanger post lines + humanize round-trip', () => {
    const { rondo2 } = fixedPoint(
      [
        'synth pad humanize:.5',
        '  saw',
        '  post',
        '    transient attack:.6 sustain:-.35',
        '    width .7 mode:tight',
        '    flanger rate:.12 depth:.8 feedback:-.5 mix:.45',
        '',
        'play pad',
        '  0 2',
        '',
      ].join('\n'),
    )
    expect(rondo2).toContain('synth pad humanize:0.5')
    expect(rondo2).toContain('transient attack:0.6 sustain:-0.35')
    expect(rondo2).toContain('width 0.7 mode:tight')
    expect(rondo2).toContain('flanger rate:0.12 depth:0.8 feedback:-0.5 mix:0.45')
  })

  it('a bare `width` fills its amount default rather than sliding opts into it', () => {
    // `width mode:tight` with no positional must NOT emit
    // `width(input, { mode })` — the opts object would land in the amount slot.
    const { code, rondo2 } = fixedPoint('synth s\n  saw\n  post\n    width mode:tight\n\nplay s\n  0\n')
    expect(code).toContain("width(input, 0.5, { mode: 'tight' })")
    expect(rondo2).toContain('width 0.5 mode:tight')
  })

  it('a bare `master` line round-trips through masterCompress()', () => {
    const { rondo2 } = fixedPoint('synth s\n  saw\n\nplay s\n  0\n\nmaster\n')
    expect(rondo2).toContain('\nmaster\n')
  })

  it('scaledef lines round-trip (floats, negatives, custom scale references)', () => {
    const { rondo2 } = fixedPoint(
      'scaledef pelog 0 1.2 2.7 5.4 6.7\n\nsynth s\n  saw\n\nplay s\n  0 1 2  scale:c-pelog\n',
    )
    expect(rondo2).toContain('scaledef pelog 0 1.2 2.7 5.4 6.7')
    expect(rondo2).toContain('scale: c-pelog')
    fixedPoint('scaledef odd -1.5 0 2.25\n\nsynth s\n  saw\n\nplay s\n  0\n')
  })

  it('wavedef lines round-trip (frames, floats, negatives, table references)', () => {
    const { rondo2 } = fixedPoint(
      'wavedef vox 1 0.3 / 0.5 1 0.6 / -0.5 1\n\nsynth s\n  wavetable note 0.3 table:vox\n\nplay s\n  0 1 2\n',
    )
    expect(rondo2).toContain('wavedef vox 1 0.3 / 0.5 1 0.6 / -0.5 1')
    expect(rondo2).toContain('table:vox')
  })

  it('wavetable warp args round-trip (warp enum, warpAmt aliased back to warpamt)', () => {
    const { rondo2 } = fixedPoint(
      'synth s\n  wavetable note 0.3 warp:sync warpamt:0.8\n  e = adsr .01 .2 .5 .1\n\nplay s\n  0 1\n',
    )
    expect(rondo2).toContain('warp:sync warpamt:0.8')
    // a signal-valued warpamt survives too
    const r2 = fixedPoint('synth s\n  wavetable note 0 warp:mirror warpamt:e\n  e = adsr .01 .2 .5 .1\n\nplay s\n  0\n')
    expect(r2.rondo2).toContain('warp:mirror warpamt:e')
  })

  it('non-sugar defineWavetable forms bail to js blocks (totality)', () => {
    for (const stmt of [
      'defineWavetable(name, [[1], [0.5]])', // non-literal name
      "defineWavetable('x', [[1, y], [1]])", // non-literal partial
      "defineWavetable('x', [[1]])", // one frame: wavedef needs 2+ to morph
      "defineWavetable('x', frames)", // computed frames
      "defineWavetable('bad name', [[1], [1]])",
    ]) {
      const r = decompile(stmt + '\n')
      expect(r, stmt).toContain('js\n')
      expect(r, stmt).toContain(stmt)
      expect(r).not.toContain('wavedef')
      // totality: the wrapped block compiles back to the same statement
      const back = compile(r)
      expect(back.ok).toBe(true)
      if (back.ok) expect(back.code.trim()).toBe(stmt)
    }
  })

  it('edo and long-mode scale names round-trip', () => {
    const { rondo2 } = fixedPoint('synth s\n  saw\n\nplay s\n  0 3 5  scale:c-19edo\n')
    expect(rondo2).toContain('scale: c-19edo')
    fixedPoint('synth s\n  saw\n\nplay s\n  0 3 5\n  scale: e-minorPentatonic\n')
  })

  it('a cents or ratios spec is a unit word, not a js block', () => {
    // real tunings are published in cents or in ratios, and converting either
    // to semitones by hand is how a tuning gets typed in wrong
    const r = decompile("defineScale('pelog', { cents: [0, 120, 270, 670, 785] })\n")
    expect(r.trim()).toBe('scaledef pelog cents 0 120 270 670 785')
    const back = compile(r)
    expect(back.ok).toBe(true)
    if (back.ok) expect(back.code.trim()).toBe("defineScale('pelog', { cents: [0, 120, 270, 670, 785] })")

    const bp = decompile("defineScale('bp', { ratios: [1, 1.19, 1.4], periodRatio: 3 })\n")
    expect(bp.trim()).toBe('scaledef bp ratios 1 1.19 1.4 period:3')
    const bpBack = compile(bp)
    expect(bpBack.ok).toBe(true)
    if (bpBack.ok) expect(bpBack.code.trim()).toBe("defineScale('bp', { ratios: [1, 1.19, 1.4], periodRatio: 3 })")
  })

  it('non-sugar defineScale forms bail to js blocks (totality): unknown key, non-literal args, 1 step', () => {
    for (const stmt of [
      // an unrecognised key would be silently DROPPED by the sugar
      "defineScale('pelog', { cents: [0, 120, 270], stretch: 2 })",
      "defineScale('pelog', { steps: [0, 120, 270] })",
      'defineScale(name, [0, 1, 2])',
      "defineScale('x', [0, y])",
      "defineScale('one', [0])",
      "defineScale('bad name', [0, 1])",
    ]) {
      const r = decompile(stmt + '\n')
      expect(r, stmt).toContain('js\n')
      expect(r, stmt).toContain(stmt)
      expect(r).not.toContain('scaledef')
      // totality: the wrapped block compiles back to the same statement
      const back = compile(r)
      expect(back.ok).toBe(true)
      if (back.ok) expect(back.code.trim()).toBe(stmt)
    }
  })

  it('a .scale() whose name cannot re-lex as `scale:root-mode` bails to a js block', () => {
    for (const js of [
      "p('s', n('0').scale('h weird').sound('s'))\n", // root outside a..g
      "p('s', n('0').scale('c bad-name').sound('s'))\n", // '-' inside the mode
      "p('s', n('0').scale('c one two').sound('s'))\n", // three words
    ]) {
      const r = decompile(js)
      expect(r, js).toContain('js\n')
      expect(r, js).not.toContain('scale:')
    }
  })
})

describe('decompile cosmetics', () => {
  it('emits SHORT scale names (a-min, not a-minor)', () => {
    // REGRESSION: SCALE_MODE's identity entries (minor→minor) overwrote the
    // short forms when inverted, so decompile emitted `scale: a-minor`
    const r = compile('synth s1\n  saw\n\nplay s1\n  0 3 5  scale:a-min\n')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(decompile(r.code)).toContain('scale: a-min\n')
  })
})

describe('decompile: the tempo unit round-trips', () => {
  // THE RULE: the unit is part of the program. `bpm` ↔ setBpm and `cps` ↔
  // setCps, in both directions — a doc that says 128 bpm never comes back as
  // `cps .5333`, and a doc that says cps never grows a bpm line.
  it('setBpm decompiles to `bpm`, setCps to `cps`', () => {
    expect(decompile('setBpm(128)\n')).toContain('bpm 128')
    expect(decompile('setCps(0.5333)\n')).toContain('cps 0.5333')
  })

  it('setTimeSig decompiles to `timesig`, keeping the line order', () => {
    expect(decompile('setTimeSig(3, 4)\n')).toContain('timesig 3 4')
    const both = decompile('setTimeSig(3, 4)\nsetBpm(120)\n')
    expect(both.indexOf('timesig 3 4')).toBeLessThan(both.indexOf('bpm 120'))
  })

  it('a computed meter stays a js block rather than becoming a wrong line', () => {
    // there is no rondo spelling for setTimeSig(n, 4): naming a number it
    // cannot write down would be a lie about what the program does
    expect(decompile('const n = 3\nsetTimeSig(n, 4)\n')).toContain('js')
  })

  it('rondo → JS → rondo keeps the spelling the author typed', () => {
    for (const src of ['bpm 128\n', 'cps 0.5333\n', 'timesig 3 4\n', 'timesig 7 8\n']) {
      const c = compile(src)
      expect(c.ok).toBe(true)
      if (!c.ok) return
      expect(decompile(c.code)).toBe(src)
    }
  })
})

describe('decompile totality', () => {
  it('wraps unrecognized statements verbatim in js blocks', () => {
    const js = `const weird = [1, 2, 3].map((x) => x * 2)\nconsole.log(weird)\n\nsetCps(0.5)\n`
    const r = decompile(js)
    expect(r).toContain('js\n')
    expect(r).toContain('const weird = [1, 2, 3].map((x) => x * 2)')
    expect(r).toContain('cps 0.5')
    const c = compile(r)
    expect(c.ok).toBe(true)
    if (c.ok) {
      expect(c.code).toContain('const weird = [1, 2, 3].map((x) => x * 2)')
      expect(c.code).toContain('setCps(0.5)')
    }
  })

  it('a JS binding reusing a builtin name (const delay) still decompiles — JS scoping guarantees the builtin is unused', () => {
    const js = `const ok = synth(({ note, gate, adsr, saw }) => {
  const delay = adsr(gate, { a: 0.1, d: 0.1, s: 0.5, r: 0.1 })
  return saw(note.freq).mul(delay)
})
`
    const r = decompile(js)
    expect(r).toContain('delay = adsr 0.1 0.1 0.5 0.1')
    const c = compile(r)
    expect(c.ok).toBe(true)
    if (c.ok) expect(() => new Function(c.code)).not.toThrow()
  })

  it('bails a synth whose binding name is a reserved special ref', () => {
    // `const knob = 2` is fine in JS, but a rondo binding named `knob`
    // shadows the grammar's own keyword — the synth must stay a js block
    // instead of round-tripping into a compile error.
    const js = `const bad = synth(({ note, saw }) => {
  const knob = 2
  return saw(note.freq).mul(knob)
})
`
    const r = decompile(js)
    expect(r).toContain('js\n')
    const c = compile(r)
    expect(c.ok).toBe(true)
    if (c.ok) expect(() => new Function(c.code)).not.toThrow()
  })

  it('non-JS input comes back wrapped, not lost', () => {
    const r = decompile('this is not (valid js')
    expect(r).toContain('js\n')
    expect(r).toContain('this is not (valid js')
  })

  it('a hand-written JS synth with an inexpressible chain falls back per-expression', () => {
    // a.add(b).mul(c) is left-assoc — rondo infix would re-associate it, so
    // the decompiler must NOT sugar it into `a + b * c`
    const js = `const x = synth(({ note, gate, adsr, sine, saw }) => {
  const env = adsr(gate, { a: 0.01, d: 0.1, s: 0.5, r: 0.1 })
  return sine(note.freq).add(saw(note.freq)).mul(env)
})

p('x', n('0 3').scale('c major').sound('x'))

setCps(0.5)
`
    const r = decompile(js)
    const c = compile(r)
    expect(c.ok, `--- decompiled ---\n${r}`).toBe(true)
    if (!c.ok) return
    // pipeline peeling makes this expressible: `* env` line over `sine + saw`
    expect(r).toContain('play x')
    expect(r).toContain('scale: c-maj')
  })

  it('an orphan __sec_ const (no matching arrange) is restored as a js block', () => {
    const js = "const __sec_a = n('0 3').scale('c major').sound('s1')\n"
    const r = decompile(js)
    expect(r).toContain('js\n')
    expect(r).toContain("const __sec_a = n('0 3').scale('c major').sound('s1')")
    expect(r).not.toContain('section') // never a half-formed section block
    const back = compile(r)
    expect(back.ok).toBe(true)
    if (back.ok) expect(back.code).toContain('__sec_a')
  })

  it('an arrange referencing an unknown section bails BOTH statements to js blocks', () => {
    const js = "const __sec_a = n('0 3').scale('c major').sound('s1')\n\np('song', arrange([4, __sec_a], [2, __sec_b]))\n"
    const r = decompile(js)
    expect(r).not.toContain('section a')
    expect(r).not.toContain('song ')
    expect(r).toContain("const __sec_a = n('0 3').scale('c major').sound('s1')")
    expect(r).toContain("p('song', arrange([4, __sec_a], [2, __sec_b]))")
    const back = compile(r)
    expect(back.ok).toBe(true)
    if (back.ok) {
      expect(back.code).toContain("p('song', arrange([4, __sec_a], [2, __sec_b]))")
    }
  })

  it('an arrange with INCONSISTENT lens for one section bails to js blocks', () => {
    const js = "const __sec_a = n('0 3').scale('c major').sound('s1')\n\np('song', arrange([4, __sec_a], [8, __sec_a]))\n"
    const r = decompile(js)
    expect(r).not.toContain('section a')
    expect(r).toContain("p('song', arrange([4, __sec_a], [8, __sec_a]))")
    const back = compile(r)
    expect(back.ok).toBe(true)
    if (back.ok) expect(back.code).toContain('arrange([4, __sec_a], [8, __sec_a])')
  })

  it('an inexpressible binding RHS falls back to an inline js{ … }', () => {
    const js = 'const x = synth(({ note, saw }) => {\n  const amt = Math.min(0.5, 0.9)\n  return saw(note.freq).mul(amt)\n})\n'
    const r = decompile(js)
    expect(r).toContain('amt = js{ Math.min(0.5, 0.9) }')
    const back = compile(r)
    expect(back.ok, `--- decompiled ---\n${r}`).toBe(true)
    if (!back.ok) return
    expect(back.code).toContain('const amt = Math.min(0.5, 0.9)')
    // and the recompile is a fixed point from here on
    const again = compile(decompile(back.code))
    expect(again.ok).toBe(true)
    if (again.ok) expect(again.code).toBe(back.code)
  })

  it('decompiles a play chain with ctrls, fn combinators, and struct', () => {
    const js = `const s = synth(({ note, gate, adsr, saw }) => saw(note.freq).mul(adsr(gate, { a: 0.01, d: 0.1, s: 0.5, r: 0.1 })))

p('s', n('0 2 4').scale('a minor').sound('s').ctrl('cutoff', sine.range(200, 2400).slow(4)).gain(0.8).every(4, x => x.rev()).struct(mini('~ t ~ t')))
`
    const r = decompile(js)
    expect(r).toContain('cutoff: sine 200..2400 slow:4')
    expect(r).toContain('gain: 0.8')
    expect(r).toContain('every 4: rev')
    expect(r).toContain('struct ~ t ~ t')
    // and the decompiled rondo COMPILES, reaching a fixed point: hand-written
    // JS normalizes on the first recompile, and from there decompile → compile
    // is byte-identical
    const back = compile(r)
    expect(back.ok, `--- decompiled ---\n${r}`).toBe(true)
    if (!back.ok) return
    expect(back.code).toContain(".ctrl('cutoff', sine.range(200, 2400).slow(4))")
    const again = compile(decompile(back.code))
    expect(again.ok).toBe(true)
    if (again.ok) expect(again.code).toBe(back.code)
  })
})

/* ------------------------------------------------------------------------- *
 * Hand-written JavaScript, converted for the docs language toggle.
 *
 * These are the shapes real snippets are written in, and each was a `js{ }`
 * blob before. rondo has NO PARENTHESES, so the answer to an operand that
 * will not fit inline is the one a person writes: give it a name.
 * ------------------------------------------------------------------------- */
describe('decompile: hand-written JS that has no inline rondo spelling', () => {
  /** Decompile, and assert the result is real rondo that means the same thing. */
  const roundTrip = (js: string): string => {
    const r = decompile(js)
    expect(r, `left a js block:\n${r}`).not.toMatch(/js\{|^js$/m)
    const back = compile(r)
    expect(back.ok, `did not recompile:\n${r}`).toBe(true)
    if (!back.ok) return r
    // and it is STABLE, in the sense the decompiler guarantees: once through
    // the compiler, decompile → compile is a fixed point. (The rondo TEXT is
    // not guaranteed identical — the compiler orders named arguments its own
    // way, so `root:60 pos:pos` comes back as `pos:pos root:60`.)
    const again = compile(decompile(back.code))
    expect(again.ok).toBe(true)
    if (again.ok) expect(again.code).toBe(back.code)
    return r
  }

  it('names a modulator that cannot sit inside a call', () => {
    // `sine adsr .001 .09 0 .05 -> 45..160` would apply the range to the
    // whole sine call, so the envelope becomes a binding instead
    const r = roundTrip(
      `const kick = synth(({ gate, sine, adsr }) =>\n` +
        `  sine(adsr(gate, { a: 0.001, d: 0.09, s: 0, r: 0.05 }).pow(2).range(45, 160)))\n`,
    )
    expect(r).toContain('-> 45..160')
    expect(r).toMatch(/sine \w+/)
  })

  it('names an operand at the same precedence as its operator', () => {
    // `* adsr … * 0.2` re-associates; only accidentally right for `*`
    const r = roundTrip(
      `const k = synth(({ note, gate, saw, adsr }) =>\n` +
        `  saw(note.freq).mul(adsr(gate, { a: 0.01, d: 0.1, s: 0.5, r: 0.2 }).mul(0.2)))\n`,
    )
    expect(r).toContain('amp = adsr 0.01 0.1 0.5 0.2 * 0.2')
    expect(r).toContain('* amp')
  })

  it('names a modulated named argument', () => {
    const r = roundTrip(
      `const g = synth(({ gate, granular, lfo }) =>\n` +
        `  granular(gate, 'pad', { root: 60, pos: lfo(0.05).range(0, 1), size: 0.12 }))\n`,
    )
    expect(r).toContain('-> 0..1')
    expect(r).toMatch(/pos:\w+/)
  })

  it('a generated name never shadows a builtin', () => {
    // the role name for a `^` operand is `exp`, which IS a builtin — a binding
    // that shadows one is a compile error, so it has to step aside
    const r = roundTrip(
      `const k = synth(({ note, saw, noise }) => saw(note.freq).pow(noise('pink').add(2)))\n`,
    )
    expect(r).not.toMatch(/^\s*exp = /m)
  })

  it('an inline param becomes the knob it is', () => {
    const r = roundTrip(
      `const b = synth(({ note, gate, saw, svf, param, adsr }) =>\n` +
        `  svf(saw(note.freq), param('cutoff', 900, { min: 80, max: 8000, curve: 'log' }), { res: 0.3 })\n` +
        `    .mul(adsr(gate, { a: 0.004, d: 0.2, s: 0.6, r: 0.1 })))\n`,
    )
    expect(r).toContain('cutoff = knob 900 80..8000 log')
    expect(r).toContain('svf cutoff res:0.3')
  })

  it('a post chain named partway through still folds from input', () => {
    // a post spine starts at `input` implicitly and cannot start anywhere
    // else, so a single-use `const` in the middle folds into its one use
    const r = roundTrip(
      `const s = synth(({ note, saw }) => saw(note.freq), ({ input, delay, reverb }) => {\n` +
        `  const echo = input.add(delay(input, 0.375, 0.4))\n` +
        `  return echo.mix(reverb(echo, { roomSize: 0.85, damp: 0.4 }), 0.35)\n` +
        `})\n`,
    )
    expect(r).toContain('+ delay input 0.375 0.4')
    expect(r).toContain('reverb room:0.85 damp:0.4 mix:0.35')
  })

  it('reads a skipped post slot as skipped, not as options', () => {
    const r = roundTrip(
      `const sub = synth(({ note, saw }) => saw(note.freq), undefined, { mono: true, glide: 0.05 })\n`,
    )
    expect(r).toContain('synth sub mono glide:0.05')
  })

  it('a generated name never collides with a binding declared LATER', () => {
    // `pitch` is declared first and its value hoists an operand; `amp` is
    // declared two lines down. Claiming names as they are reached let the
    // hoist take `amp` first, and two `amp =` lines is a compile error.
    const r = roundTrip(
      `const blip = synth(({ note, gate, env, saw, svf }) => {\n` +
        `  const pitch = note.freq.mul(env(gate, [[0.03, 1]], { release: 0.05 }).range(2, 1))\n` +
        `  const amp = env(gate, [[0.004, 1], [0.12, 0.5]], { release: 0.25, curve: 3 })\n` +
        `  return svf(saw(pitch), 3500, { res: 0.3 }).mul(amp)\n` +
        `})\n`,
    )
    const names = [...r.matchAll(/^\s*(\w+) = /gm)].map((m) => m[1]!)
    expect(new Set(names).size, `duplicate binding in:\n${r}`).toBe(names.length)
  })

  it('a sig op called as a function is the same line as the method form', () => {
    // the ctx offers `mix(a, b, t)` and `a.mix(b, t)`; rondo has one line, and
    // reaching it lets the wet/dry recognizer see this for what it is
    expect(
      roundTrip(
        `const s = synth(({ note, saw }) => saw(note.freq), ({ input, reverb, mix }) =>\n` +
          `  mix(input, reverb(input), 0.22))\n`,
      ),
    ).toContain('reverb mix:0.22')
    // a mix that is NOT wet/dry stays the sig-op line it is
    expect(
      roundTrip(
        `const s = synth(({ note, saw, square, mix }) => mix(saw(note.freq), square(note.freq), 0.3))\n`,
      ),
    ).toContain('mix square note 0.3')
  })

  it('converts a sung phrase, post chain and all', () => {
    const r = roundTrip(
      `p('vox', sing('barbara',\n` +
        `  'lo-ver come and sing with me',\n` +
        `  'e4 e4 g4 g4 a4 g4 e4',\n` +
        `  { name: 'vox', post: ({ input, reverb, mix }) => mix(input, reverb(input), 0.22) }).gain(0.95))\n`,
    )
    expect(r).toContain('sing vox voice:barbara')
    expect(r).toContain('lo-ver come and sing with me')
    expect(r).toContain('gain: 0.95')
    expect(r).toContain('post')
  })

  it('a stack whose layers have different sounds becomes per-line routes', () => {
    const r = roundTrip(
      `const kick = synth(({ sine }) => sine(60))\n` +
        `const hat = synth(({ noise }) => noise())\n\n` +
        `p('drums', stack(note('c1 ~ c1 ~').sound('kick'), note('c5*8').sound('hat')))\n`,
    )
    expect(r).toContain('play drums')
    expect(r).toContain('c1 ~ c1 ~ synth:kick')
    expect(r).toContain('c5*8 synth:hat')
  })

  it('a stack whose layers share one sound keeps ONE route on the header', () => {
    const r = roundTrip(
      `const keys = synth(({ note, tri }) => tri(note.freq))\n\n` +
        `p('parts', stack(note('c4 e4').sound('keys'), note('g4 b4').sound('keys')))\n`,
    )
    expect(r).toContain('play parts synth:keys')
    expect(r).not.toContain('synth:keys\n  g4')
  })

  it('flattens a nested stack, which is what stacking already means', () => {
    // an importer groups by track and emits stack(stack(a, b), c)
    const r = roundTrip(
      `const keys = synth(({ note, tri }) => tri(note.freq))\n` +
        `const bass = synth(({ note, saw }) => saw(note.freq))\n\n` +
        `p('imported', stack(\n` +
        `  stack(note('c4@8').sound('keys'), note('e4@8').sound('keys')),\n` +
        `  note('c2@8').sound('bass'),\n` +
        `))\n`,
    )
    expect(r).toContain('c4@8 synth:keys')
    expect(r).toContain('e4@8 synth:keys')
    expect(r).toContain('c2@8 synth:bass')
  })

  it('bails when a routed stack has a layer with no route', () => {
    // inventing one would put the layer on a synth the source never named
    expect(
      decompile(`p('x', stack(note('c4').sound('keys'), note('e4')))\n`),
    ).toContain('js')
  })

  it('keeps a js block when a sung phrase is on another channel', () => {
    // rondo says the channel once; `p('a', sing(…{ name: 'b' }))` says it twice
    expect(decompile(`p('a', sing('hi', 'c4', { name: 'b' }))\n`)).toContain('js')
  })

  it('keeps a js block when the operand itself is inexpressible', () => {
    // hoisting rescues an operand rondo cannot PLACE, never one it cannot SAY
    expect(decompile(`const k = synth(({ note, saw }) => saw(note.freq).mul(Math.random()))\n`))
      .toContain('js{')
  })
})
