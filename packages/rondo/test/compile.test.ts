import { describe, expect, it } from 'vitest'
import { compile } from '../src/compile'
import { maskJsLiterals } from '../src/codegen'

/** unwrap a successful compile or fail loudly with the diagnostics. */
function ok(src: string): string {
  const r = compile(src)
  if (!r.ok) throw new Error('compile failed: ' + JSON.stringify(r.errors))
  return r.code
}

/** expect a failing compile and hand back its FIRST diagnostic. Every
 *  diagnostic must carry a real position — line 0 means the squiggle lands
 *  nowhere (the line-0/col-0 fallback bug). */
function fails(src: string): { message: string; line: number; col: number } {
  const r = compile(src)
  expect(r.ok, 'expected a compile error').toBe(false)
  if (r.ok) throw new Error('unreachable')
  for (const e of r.errors) {
    expect(e.line, `diagnostic "${e.message}" lost its position`).toBeGreaterThanOrEqual(1)
    expect(e.col, `diagnostic "${e.message}" lost its position`).toBeGreaterThanOrEqual(1)
  }
  return r.errors[0]!
}

/** assert one diagnostic: message substring + exact line and column. */
function failsAt(src: string, msg: string, line: number, col: number): void {
  const e = fails(src)
  expect(e.message).toContain(msg)
  expect({ line: e.line, col: e.col }).toEqual({ line, col })
}

describe('rondo → rondocode codegen', () => {
  it('compiles a bare oscillator synth + degree pattern + cps', () => {
    const out = ok(`synth blip\n  saw\n\nplay blip\n  0 2 4 2\n\ncps .5\n`)
    expect(out).toContain('const blip = synth(({ note, saw }) => {')
    expect(out).toContain('return saw(note.freq)')
    expect(out).toContain("p('blip', n('0 2 4 2').sound('blip'))")
    expect(out).toContain('setCps(0.5)')
  })

  it('`bpm 128` is the tempo in the unit producers count in (one cycle = one 4/4 bar)', () => {
    // 128 / 60 / 4 beats per bar = 0.53333… cps; the conversion happens in the
    // JS layer (setBpm), so the rondo source keeps the number that was typed
    expect(ok('bpm 128\n')).toContain('setBpm(128)')
    expect(ok('bpm 120\n')).toContain('setBpm(120)')
    // both spellings are legal in one program; last one wins at eval time
    const both = ok('cps .5\n\nbpm 128\n')
    expect(both).toContain('setCps(0.5)')
    expect(both).toContain('setBpm(128)')
  })

  it('`timesig 3 4` is the meter, and it commutes with the tempo line', () => {
    expect(ok('timesig 3 4\n')).toContain('setTimeSig(3, 4)')
    // either order compiles to both calls; the evaluator resolves bpm against
    // the meter at the END of the eval, so the two lines mean the same thing
    // whichever way round they are written
    const a = ok('timesig 3 4\n\nbpm 120\n')
    const b = ok('bpm 120\n\ntimesig 3 4\n')
    for (const out of [a, b]) {
      expect(out).toContain('setTimeSig(3, 4)')
      expect(out).toContain('setBpm(120)')
    }
  })

  it('rejects a meter that is not one, at the line that wrote it', () => {
    // the beat unit is a power of two, because that is what a time signature
    // can express and what the MIDI meta event stores
    const bad = compile('synth z\n  saw\n\ntimesig 4 6\n')
    expect(bad.ok).toBe(false)
    if (bad.ok) return
    expect(bad.errors[0]!.message).toMatch(/power of two/)
    expect(bad.errors[0]!.line).toBe(4)
    expect(bad.errors[0]!.col).toBe(1)
    expect(compile('timesig 0 4\n').ok).toBe(false)
    expect(compile('timesig 3\n').ok).toBe(false)
    // …and the ordinary odd meters are fine
    for (const m of ['timesig 5 4', 'timesig 7 8', 'timesig 12 8', 'timesig 2 2']) {
      expect(compile(`${m}\n`).ok, m).toBe(true)
    }
  })

  it('threads the audio spine: source, filter (running signal first), VCA', () => {
    const out = ok(`synth acid\n  saw + square note/2\n  ladder cutoff * env^2 res:.85\n  * env\n  env    = adsr .003 .2 .3 .1\n  cutoff = knob 800 80..8000 log\n`)
    // oscillator blend
    expect(out).toContain('saw(note.freq).add(square(note.freq.div(2)))')
    // filter takes the running signal as its first arg, cutoff*env^2 as second
    expect(out).toContain('ladder(saw(note.freq).add(square(note.freq.div(2))), cutoff.mul(env.pow(2)), { res: 0.85 })')
    // final VCA multiply by env
    expect(out).toContain('.mul(env)')
    // bindings emitted (decay + knob param)
    expect(out).toContain('const env = adsr(gate, { a: 0.003, d: 0.2, s: 0.3, r: 0.1 })')
    expect(out).toContain("const cutoff = param('cutoff', 800, { min: 80, max: 8000, curve: 'log' })")
    // destructure includes exactly what's used
    expect(out).toContain('synth(({ note, gate, param, adsr, ladder, saw, square }) =>')
  })

  it('expands short scale names and picks note() for note-name patterns', () => {
    expect(ok(`synth q\n  saw\n\nplay q\n  0 3 5  scale:c-maj\n`)).toContain(".scale('c major')")
    expect(ok(`synth q\n  saw\n\nplay q\n  c4 e4 g4\n`)).toContain("note('c4 e4 g4')")
  })

  it('passes digit-bearing and long mode names through: 19edo, minorPentatonic', () => {
    // inline extractor and modifier line both accept them
    expect(ok(`synth q\n  saw\n\nplay q\n  0 3 5  scale:c-19edo\n`)).toContain(".scale('c 19edo')")
    expect(ok(`synth q\n  saw\n\nplay q\n  0 3 5\n  scale: e-minorPentatonic\n`)).toContain(".scale('e minorPentatonic')")
    expect(ok(`synth q\n  saw\n\nplay q\n  0 3 5\n  scale: c-my_bell\n`)).toContain(".scale('c my_bell')")
  })

  it('scaledef: a top-level tuning line → defineScale, HOISTED above the plays', () => {
    const out = ok(`synth q\n  saw\n\nplay q\n  0 1 2  scale:c-pelog\n\nscaledef pelog 0 1.2 2.7 5.4 6.7\n`)
    expect(out).toContain("defineScale('pelog', [0, 1.2, 2.7, 5.4, 6.7])")
    // hoisted: .scale() parses eagerly at eval, the tuning must register first
    expect(out.indexOf('defineScale(')).toBeLessThan(out.indexOf(".scale('c pelog')"))
  })

  it('scaledef accepts negative + float steps', () => {
    expect(ok(`scaledef odd -1.5 0 2.25\n\nsynth q\n  saw\n\nplay q\n  0 1\n`)).toContain(
      "defineScale('odd', [-1.5, 0, 2.25])",
    )
  })

  it('a notation line can route itself with `synth:`', () => {
    // layers share the block synth, which is right for a chord and wrong for
    // a drum pattern: one channel, several instruments
    const out = ok(`synth kick\n  sine 60\n\nsynth hat\n  noise\n\nplay drums\n  c1 ~ c1 ~ synth:kick\n  c5*8 synth:hat\n`)
    expect(out).toContain("stack(note('c1 ~ c1 ~').sound('kick'), note('c5*8').sound('hat'))")
    // and no second .sound() on the stack itself
    expect(out).not.toContain(".sound('drums')")
  })

  it('layers with no route of their own still share ONE .sound()', () => {
    // the ordinary stacked chord must not grow a .sound() per line
    const out = ok(`synth pad\n  saw\n\nplay pad\n  0 4\n  2 7\n  scale: c-maj\n`)
    expect(out).toContain("stack(n('0 4'), n('2 7'))")
    expect(out.match(/\.sound\(/g)).toHaveLength(1)
  })

  it('a line-level synth: on the FIRST line is the block route', () => {
    const out = ok(`synth lead\n  saw\n\nplay riff\n  0 4 7 synth:lead\n  scale: c-maj\n`)
    expect(out).toContain(".sound('lead')")
    expect(out).not.toContain('stack(')
  })

  it("a beat block's words are already synth names, so synth: is an error", () => {
    failsAt(`beat drums\n  kick hat synth:x\n`, "`synth:` doesn't apply", 2, 3)
  })

  it('scaledef takes the UNIT a tuning was published in, not just semitones', () => {
    // a pelog is published as cents and a Bohlen-Pierce as ratios; converting
    // either to semitones by hand is how a tuning gets typed in wrong
    expect(ok(`scaledef pelog cents 0 120 270 670 785\n\nsynth q\n  saw\n\nplay q\n  0 1\n`)).toContain(
      "defineScale('pelog', { cents: [0, 120, 270, 670, 785] })",
    )
    expect(ok(`scaledef bp ratios 1 1.19 1.4 period:3\n\nsynth q\n  saw\n\nplay q\n  0 1\n`)).toContain(
      "defineScale('bp', { ratios: [1, 1.19, 1.4], periodRatio: 3 })",
    )
    // period: reads in the SAME unit as the steps
    expect(ok(`scaledef w cents 0 100 200 period:1902\n\nsynth q\n  saw\n\nplay q\n  0 1\n`)).toContain(
      "{ cents: [0, 100, 200], periodCents: 1902 }",
    )
    // a scale named after its unit word is still a name, not a unit
    expect(ok(`scaledef cents 0 1 2\n\nsynth q\n  saw\n\nplay q\n  0 1\n`)).toContain(
      "defineScale('cents', [0, 1, 2])",
    )
  })

  it('scaledef: positioned errors for a missing name, bad steps, too few steps', () => {
    failsAt(`scaledef\n`, 'scaledef needs a name', 1, 1)
    failsAt(`scaledef pelog 0 x 2\n`, 'scaledef steps are numbers', 1, 18)
    failsAt(`scaledef pelog 0\n`, 'at least 2 steps', 1, 1)
    failsAt(`scaledef 19edo 0 1\n`, 'scaledef needs a name', 1, 1)
    // a period without a unit is ambiguous: semitones have no published period
    failsAt(`scaledef p 0 1 2 period:3\n`, '`period:` needs a unit', 1, 1)
    failsAt(`scaledef p cents 0 100 period:x\n`, '`period:` needs a positive number', 1, 24)
  })

  it('wavedef: a top-level table line → defineWavetable, HOISTED above the synths', () => {
    const out = ok(`synth q\n  wavetable note .3 table:vox\n\nplay q\n  0 1 2\n\nwavedef vox 1 .3 / .5 1 .6 / .3 .8 1\n`)
    expect(out).toContain("defineWavetable('vox', [[1, 0.3], [0.5, 1, 0.6], [0.3, 0.8, 1]])")
    // hoisted: synth() eager-compiles and the kernel resolves the table name
    // at construction, so the table must register before the synth
    expect(out.indexOf('defineWavetable(')).toBeLessThan(out.indexOf('const q ='))
  })

  it('wavetable warp args: warp is an enum, warpamt a signal aliased to warpAmt', () => {
    const out = ok(`synth q\n  wavetable note .3 table:vox warp:sync warpamt:.8\n\nwavedef vox 1 / .5 1\n\nplay q\n  0 1\n`)
    expect(out).toContain("wavetable(note.freq, 0.3, { table: 'vox', warp: 'sync', warpAmt: 0.8 })")
  })

  it('wavetable warpamt takes a signal (an envelope sweeps the warp)', () => {
    const out = ok(`synth q\n  wavetable note 0 warp:bend warpamt:e\n  e = adsr .01 .2 .5 .1\n\nplay q\n  0 1\n`)
    expect(out).toContain("wavetable(note.freq, 0, { warp: 'bend', warpAmt: e })")
  })

  it('wavedef accepts negative partials (phase flips) and floats', () => {
    expect(ok(`wavedef odd 1 -.5 / .25 1\n\nsynth q\n  saw\n\nplay q\n  0 1\n`)).toContain(
      "defineWavetable('odd', [[1, -0.5], [0.25, 1]])",
    )
  })

  it('wavedef: positioned errors for missing name, bad partials, empty/too few frames, >32 partials', () => {
    failsAt(`wavedef\n`, 'wavedef needs a name', 1, 1)
    failsAt(`wavedef vox 1 x / 1\n`, 'wavedef frames are numbers', 1, 15)
    failsAt(`wavedef vox 1\n`, 'at least 2 frames', 1, 1)
    failsAt(`wavedef vox 1 / / 1\n`, 'empty frame', 1, 17)
    failsAt(`wavedef vox 1 / 1 /\n`, 'empty frame', 1, 1)
    failsAt(`wavedef 9lives 1 / 1\n`, 'wavedef needs a name', 1, 1)
    failsAt(`wavedef big ${Array.from({ length: 33 }, () => '1').join(' ')} / 1\n`, 'at most 32 partials', 1, 77)
  })

  it('topologically orders bindings so each const precedes its use', () => {
    const out = ok(`synth z\n  sine mod\n  mod = sine base\n  base = adsr .01 .1 .5 .1\n`)
    expect(out.indexOf('const base =')).toBeLessThan(out.indexOf('const mod ='))
  })

  it('reports a positioned error for an unknown top-level block', () => {
    const r = compile(`wobble foo\n  saw\n`)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0]!.line).toBe(1)
  })

  it('rejects a binding cycle', () => {
    const r = compile(`synth z\n  saw\n  a = b\n  b = a\n`)
    expect(r.ok).toBe(false)
  })

  it('compiles play modifier lines: ctrl signal sweep, every, gain', () => {
    const out = ok(
      `synth z\n  saw\n  cutoff = knob 800 80..8000\n\n` +
      `play z\n  0 2 4  scale:a-min\n  cutoff: sine 200..2400 slow:4\n  gain: .8\n  every 4: rev\n`,
    )
    expect(out).toContain(".ctrl('cutoff', sine.range(200, 2400).slow(4))")
    expect(out).toContain('.gain(0.8)')
    expect(out).toContain('.every(4, x => x.rev())')
  })

  it('signal-driven modifiers apply AFTER combinators (rev remixes notes, never the sweep)', () => {
    // REGRESSION (user report, acid example): .ctrl('cutoff', sine…) BEFORE
    // .every(4, rev) meant reversed cycles ran the filter sweep backwards —
    // a combinator outside a ctrl reverses the signal's query time.
    const out = ok(
      `synth s1\n  saw\n  cutoff = knob 800 80..8000\n\n` +
      `play s1\n  0 3 5\n  cutoff: sine 200..2400 slow:4\n  every 4: rev\n`,
    )
    expect(out.indexOf('.every(4,')).toBeLessThan(out.indexOf(".ctrl('cutoff'"))
    // step-tied values (num/mini) keep their source order — accents travel
    // with the notes they decorate
    const out2 = ok(`synth s1\n  saw\n\nplay s1\n  0 3 5\n  gain: 1 .5 1\n  every 4: rev\n`)
    expect(out2.indexOf('.gain(')).toBeLessThan(out2.indexOf('.every(4,'))
  })

  it('reports notation spans whose offset exactly matches the source substring', () => {
    // this invariant is what lets note-play flash light the rondo buffer: a
    // mini-notation Loc is an offset into `content`, and content sits at
    // [from, from+len) in the source, so from+loc.start is the buffer position.
    const src = `synth z\n  saw\n\nplay z\n  0 3 5 7  scale:c-maj\n`
    const r = compile(src)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.notes).toHaveLength(1)
    const { content, from } = r.notes[0]!
    expect(content).toBe('0 3 5 7')
    expect(src.slice(from, from + content.length)).toBe(content)
  })

  it('js{ … } escape hatch: inline expression destructures the ctx it names', () => {
    const out = ok(`synth z\n  js{ saw(note.freq).tanh() }\n`)
    expect(out).toContain('return saw(note.freq).tanh()')
    expect(out).toContain('synth(({ note, saw }) =>')
  })

  it('js{ … } escape hatch: a top-level one-liner passes through verbatim', () => {
    const out = ok(`synth z\n  saw\n\nplay z\n  0 3 5\n\njs{ sidechain('kick', { depth: 0.7 }) }\n`)
    expect(out).toContain("sidechain('kick', { depth: 0.7 })")
  })

  it('js block is truly verbatim: `#` inside strings and nested indent survive', () => {
    // REGRESSION: body lines were taken from the comment-stripped lexer text,
    // so a '#' inside a JS string got truncated and nested indent flattened.
    const out = ok(`synth z\n  saw\n\nplay z\n  0 3\n\njs\n  bus('space', ({ input, reverb }) => reverb(input), {\n    s: 0.4, // send #1 stays intact\n  })\n`)
    expect(out).toContain('// send #1 stays intact')
    expect(out).toContain('  s: 0.4,') // nested indent preserved relative to the block
  })

  it('js escape hatch: a `js` block emits its indented body verbatim', () => {
    const out = ok(`synth z\n  saw\n\nplay z\n  0 3 5\n\njs\n  sidechain('kick', { depth: 0.6 })\n  masterCompress({ threshold: -6 })\n`)
    expect(out).toContain("sidechain('kick', { depth: 0.6 })")
    expect(out).toContain('masterCompress({ threshold: -6 })')
  })

  it('numeric-LHS arithmetic: folds constants, rewrites num−sig, rejects the rest', () => {
    // REGRESSION: `1 - env` emitted `1.sub(env)` — a JS SyntaxError
    const out = ok(`synth z\n  saw\n  * inv\n  inv = 1 - env\n  env = adsr .01 .1 .5 .1\n`)
    expect(out).toContain('env.mul(-1).add(1)')
    // number⊗number folds to a constant
    expect(ok(`synth z\n  saw\n  * g\n  g = 2 * 3\n`)).toContain('const g = 6')
    // num / sig and num ^ sig have no Sig form → positioned error, not garbage
    failsAt(`synth z\n  saw\n  * x\n  x = 2 / env\n  env = adsr .01 .1 .5 .1\n`,
      "`number / signal` isn't expressible", 4, 9)
    failsAt(`synth z\n  saw\n  * x\n  x = 2 ^ env\n  env = adsr .01 .1 .5 .1\n`,
      "`number ^ signal` isn't expressible", 4, 9)
  })

  it('`->` binds at statement level, not inside call arguments', () => {
    // REGRESSION: parsed as sine(2 -> 200..2000) → invalid `2.range(…)`
    const out = ok(`synth z\n  sine\n  * env\n  env = adsr .01 .1 .5 .1\n  lfo = sine 2 -> 200..2000\n`)
    expect(out).toContain('sine(2).range(200, 2000)')
  })

  it('rejects a duplicate binding instead of silently dropping the second', () => {
    const r = compile(`synth z\n  saw\n  * env\n  env = adsr .01 .1 .7 .2\n  env = adsr .5 .5 .5 .5\n`)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0]!.message).toContain('duplicate')
  })

  it('rejects a binding named after a special ref (note/gate/adsr/knob/…)', () => {
    const r = compile(`synth z\n  saw\n  gate = 1\n  * gate\n`)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0]!.message).toContain('shadows a builtin')
  })

  it('allows a binding named after an unused builtin, rejects it when the chain calls that builtin', () => {
    // `lfo = sine 2` is idiomatic — legal while the chain never calls lfo()
    expect(compile(`synth z\n  saw\n  * lfo\n  lfo = sine 2 -> 0..1\n`).ok).toBe(true)
    // but binding `fm` AND calling the builtin fm() collides: the ctx
    // destructure and the const would both declare `fm`
    const r = compile(`synth z\n  saw\n  * fm 200\n  fm = adsr .1 .1 .5 .1\n`)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0]!.message).toContain("shadows the builtin 'fm'")
  })

  it('js{} escape does not destructure ctx names shadowed by chain bindings', () => {
    // REGRESSION (user report): a js{ } mentioning `env` + an `env = …` binding
    // emitted `({ …, env, … }) => { const env = … }` → "Identifier 'env' has
    // already been declared" at eval time.
    const src = `synth pad\n  js{ saw(note.freq).mul(env.range(0, 1)) }\n  * env\n  env = adsr .01 .2 .5 .2\n`
    const r = compile(src)
    expect(r.ok).toBe(true)
    if (r.ok) expect(() => new Function(r.code)).not.toThrow()
  })

  it('env: flat time/level pairs → a breakpoint envelope call', () => {
    const out = ok(`synth z\n  saw\n  * e\n  e = env .005 1 .15 .4 .5 .6 release:.3 curve:3 loop:1\n`)
    expect(out).toContain('env(gate, [[0.005, 1], [0.15, 0.4], [0.5, 0.6]], { release: 0.3, curve: 3, loop: true })')
    // odd number of values = half a pair — error, not a silent drop
    failsAt(`synth z\n  saw\n  * e\n  e = env .005 1 .15\n`, 'env takes time/level pairs', 4, 7)
    // bare `env` is still a reference to a binding named env
    expect(ok(`synth z\n  saw\n  * env\n  env = adsr .01 .1 .5 .1\n`)).toContain('.mul(env)')
  })

  it('sync:1 makes lfo rates and delay times musical, sync:0 and absence do not', () => {
    // lfo WITH a shape word, and without it (opts land in the shape slot)
    expect(ok(`synth z\n  saw\n  ladder cut\n  cut = lfo .25 tri sync:1 -> 150..3200\n`))
      .toContain("lfo(0.25, 'tri', { sync: true })")
    expect(ok(`synth z\n  saw\n  ladder cut\n  cut = lfo .25 sync:1 -> 150..3200\n`))
      .toContain('lfo(0.25, { sync: true })')
    // sync:0 is explicit OFF, and no sync at all emits no opts object
    expect(ok(`synth z\n  saw\n  ladder cut\n  cut = lfo 4 tri sync:0 -> 150..3200\n`))
      .toContain("lfo(4, 'tri', { sync: false })")
    expect(ok(`synth z\n  saw\n  ladder cut\n  cut = lfo 4 tri -> 150..3200\n`))
      .toContain("lfo(4, 'tri')")
    // delay: sync alongside the existing maxtime alias
    expect(ok(`synth z\n  saw\n  delay .1875 .25 sync:1\n`))
      .toContain('delay(saw(note.freq), 0.1875, 0.25, { sync: true })')
    expect(ok(`synth z\n  saw\n  delay .1875 .25 maxtime:1 sync:1\n`))
      .toContain('delay(saw(note.freq), 0.1875, 0.25, { maxTime: 1, sync: true })')
    expect(ok(`synth z\n  saw\n  delay .375 .25\n`))
      .toContain('delay(saw(note.freq), 0.375, 0.25)')
  })

  it('eq: word-then-numbers band groups → the bands array', () => {
    const out = ok(`synth z\n  saw\n  eq hp 170 highshelf 7000 4\n`)
    expect(out).toContain("eq(saw(note.freq), [{ type: 'hp', freq: 170 }, { type: 'highshelf', freq: 7000, gain: 4 }])")
    // peak takes freq gain q
    expect(ok(`synth z\n  saw\n  eq peak 300 -3 2\n`)).toContain("{ type: 'peak', freq: 300, gain: -3, q: 2 }")
    // unknown band type + missing freq are positioned errors
    failsAt(`synth z\n  saw\n  eq bandpass 300\n`, 'unknown eq band type `bandpass`', 3, 6)
    failsAt(`synth z\n  saw\n  eq hp\n`, 'eq band is missing its freq', 3, 3)
    // more numbers than the band type takes is an error, not a silent drop
    failsAt(`synth z\n  saw\n  eq hp 170 200 300\n`, 'too many numbers in an eq band', 3, 3)
  })

  it('vocoder: the pipe is the carrier, the positional is the modulator', () => {
    const out = ok(`synth z\n  supersaw\n  vocoder m bands:20\n  m = noise\n`)
    expect(out).toContain('vocoder(supersaw(note.freq), m, { bands: 20 })')
  })

  it('beat block: notation words are synth names → s(…); modifiers apply', () => {
    expect(ok(`beat\n  kick hat kick hat\n  every 4: rev\n`))
      .toContain(`p('beat', s('kick hat kick hat').every(4, x => x.rev()))`)
    // a named beat keeps its channel name; scale is rejected (words aren't notes)
    expect(ok(`beat fills\n  kick [hat hat]\n`)).toContain(`p('fills', s('kick [hat hat]'))`)
    // the error points at the scale LINE, not the beat header
    failsAt(`beat\n  kick hat\n  scale: a-min\n`, "`scale:` doesn't apply", 3, 3)
  })

  it('beat velocity suffixes: `kick:.6` → an aligned per-voice gain pattern', () => {
    expect(ok(`beat\n  kick ~ kick:.6 ~\n`))
      .toContain(`s('kick ~ kick ~').gain('1 ~ 0.6 ~')`)
    // no suffixes → no .gain; each stacked voice carries its OWN accents
    expect(ok(`beat\n  kick ~ kick ~\n`)).toContain(`s('kick ~ kick ~'))`)
    expect(ok(`beat\n  kick ~ kick:.6 ~\n  ~ hat:.3 ~ hat\n`))
      .toContain(`stack(s('kick ~ kick ~').gain('1 ~ 0.6 ~'), s('~ hat ~ hat').gain('~ 0.3 ~ 1'))`)
    // structure-preserving: works inside any mini nesting
    expect(ok(`beat\n  [hat:.9 hat]*2 <ohat:.4 ~>\n`))
      .toContain(`s('[hat hat]*2 <ohat ~>').gain('[0.9 1]*2 <0.4 ~>')`)
  })

  it('irand notation line: `irand N [seg:M]` → n(irand(N).segment(M))', () => {
    expect(ok(`synth s1\n  saw\n\nplay s1\n  irand 8 seg:16\n  scale: e-min\n`))
      .toContain(`n(irand(8).segment(16)).scale('e minor').sound('s1')`)
    // seg defaults to 8; malformed forms are errors, not notation strings
    expect(ok(`synth s1\n  saw\n\nplay s1\n  irand 4\n`)).toContain('n(irand(4).segment(8))')
    // the error points at the irand LINE, not the play header
    failsAt(`synth s1\n  saw\n\nplay s1\n  irand eight\n`, 'irand notation is `irand N [seg:M]`', 5, 3)
    failsAt(`beat\n  irand 4\n`, 'it belongs in a `play` block, not `beat`', 2, 3)
  })

  it('a fn-comb modifier directly after the notation is a modifier, not a voice', () => {
    // REGRESSION: `every 4: rev` with no name:value modifier before it was
    // classified as a stacked notation voice → note('every 4: rev') garbage
    expect(ok(`synth s1\n  saw\n\nplay s1\n  0 3 5\n  every 4: rev\n`))
      .toContain(`n('0 3 5').sound('s1').every(4, x => x.rev())`)
  })

  it('beat NoteSpans strip velocity suffixes and carry buffer-mapping pieces', () => {
    // REGRESSION (user report): the hat row `~ hat:.6 ~ hat …` never flashed —
    // the emitted mini is STRIPPED but the span still held the original text,
    // so events' loc.src matched nothing
    const src = 'beat\n  ~ hat:.6 ~ hat ~ hat:.6 ~ hat\n'
    const r = compile(src)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const span = r.notes[0]!
    expect(span.content).toBe('~ hat ~ hat ~ hat ~ hat') // equals events' loc.src
    expect(span.pieces).toBeDefined()
    // every piece maps a chunk of the stripped string to identical buffer text
    for (const p of span.pieces!) {
      expect(src.slice(p.sourceStart, p.sourceStart + p.length))
        .toBe(span.content.slice(p.assembledStart, p.assembledStart + p.length))
    }
    // a plain beat line keeps the simple contiguous form
    const plain = compile('beat\n  kick ~ kick ~\n')
    if (plain.ok) expect(plain.notes[0]!.pieces).toBeUndefined()
  })

  it('irand lines get PULSE spans (their events carry no mini locs to flash)', () => {
    const src = 'synth bass\n  saw\n\nplay bass\n  irand 5 seg:8\n  scale: a-min\n'
    const r = compile(src)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.pulses).toHaveLength(1)
    expect(src.slice(r.pulses[0]!.from, r.pulses[0]!.to)).toBe('irand 5 seg:8')
    expect(r.pulses[0]!.sound).toBe('bass')
    // ordinary notation lines don't pulse — they flash per atom
    const plain = compile('synth s1\n  saw\n\nplay s1\n  0 3 5\n')
    if (plain.ok) expect(plain.pulses).toEqual([])
  })

  it('reports js escape regions with exact source offsets (for note-flash)', () => {
    const src = [
      'synth s1',
      '  js{ saw(note.freq).mul(0.5) }',
      '',
      'js',
      "  p('x', n('0 3 5')",
      "    .sound('s1'))",
      '',
      "js{ setCps(0.5) }",
      '',
    ].join('\n')
    const r = compile(src)
    expect(r.ok, JSON.stringify(r.ok ? [] : r.errors)).toBe(true)
    if (!r.ok) return
    const texts = r.jsRegions.map((g) => src.slice(g.from, g.to))
    // inline escapes: the text between the braces; block: the WHOLE body
    // (one region, so multi-line statements stay parseable by the scanner)
    expect(texts).toContainEqual(' saw(note.freq).mul(0.5) ')
    expect(texts).toContainEqual(' setCps(0.5) ')
    expect(texts).toContainEqual("  p('x', n('0 3 5')\n    .sound('s1'))")
    expect(r.jsRegions).toHaveLength(3)
  })

  it('sing block: lyric/melody pairs join; voice, name, mods, post all map', () => {
    const out = ok([
      'sing vox voice:barbara',
      '  twin-kle twin-kle lit-tle star',
      '  c4 c4 g4 g4 a4 a4 g4@2',
      '  how I won-der what you are',
      '  f4 f4 e4 e4 d4 d4 c4@2',
      '  gain: .95',
      '  post',
      '    reverb room:.8 mix:.25',
      '',
    ].join('\n'))
    expect(out).toContain("sing('barbara', 'twin-kle twin-kle lit-tle star how I won-der what you are', 'c4 c4 g4 g4 a4 a4 g4@2 f4 f4 e4 e4 d4 d4 c4@2', { name: 'vox', post: ({ input, reverb }) =>")
    expect(out).toContain('.gain(0.95)')
    expect(out).toContain("p('vox', sing(")
    // no voice → the 2-string default-voice form
    expect(ok('sing v\n  la la\n  c4 e4\n')).toContain("sing('la la', 'c4 e4', { name: 'v' })")
  })

  it('sing block: positioned errors for unpaired lines, missing name, scale', () => {
    const odd = compile('sing v\n  la la la\n')
    expect(odd.ok).toBe(false)
    if (!odd.ok) expect(odd.errors[0]!.message).toContain('pairs')
    expect(compile('sing\n  la\n  c4\n').ok).toBe(false)
    const sc = compile('sing v\n  la la\n  c4 e4\n  scale: a-min\n')
    expect(sc.ok).toBe(false)
    if (!sc.ok) expect(sc.errors[0]!.message).toContain("doesn't apply")
  })

  it('play synth: routes a channel to a different synth (two patterns, one synth)', () => {
    const out = ok('synth keys\n  saw\n\nplay pad synth:keys\n  <Dm7 G7>\n\nplay arp synth:keys\n  <Dm7 G7>\n  arp updown\n')
    expect(out).toContain("p('pad', chord('<Dm7 G7>').sound('keys'))")
    expect(out).toContain("p('arp', chord('<Dm7 G7>').sound('keys').arp('updown'))")
    failsAt('synth s1\n  saw\n\nplay x nonsense\n  0 3\n', 'unknown play option (only `synth:NAME`)', 4, 8)
  })

  it('mic: the live microphone as a source (bare, and as a vocoder modulator)', () => {
    expect(ok('synth thru\n  mic\n  * .5\n')).toContain('return mic().mul(0.5)')
    expect(ok('synth talkbox\n  supersaw\n  vocoder mic bands:24\n'))
      .toContain('vocoder(supersaw(note.freq), mic(), { bands: 24 })')
  })

  it('rejects a near-miss scale instead of shipping it inside the notation', () => {
    failsAt(`synth z\n  saw\n\nplay z\n  0 3 5  scale:minor\n`, 'bad scale — write it like `scale:a-min`', 5, 3)
  })

  it('supports negative number literals (sign glued, space-preceded)', () => {
    const out = ok(`synth z\n  saw\n  * g\n  g = knob -6 -12..0\n`)
    expect(out).toContain("param('g', -6, { min: -12, max: 0 })")
    // subtraction still works, spaced or glued
    expect(ok(`synth z\n  saw\n  * x\n  x = env - 1\n  env = adsr .01 .1 .5 .1\n`)).toContain('env.sub(1)')
  })

  it('js{ … } one-liner survives a `#` inside a string', () => {
    // REGRESSION: comment stripping ran quote-blind and truncated the line
    const out = ok(`synth z\n  saw\n\nplay z\n  0 3\n\njs{ p('x', sound('bd # sn')) }\n`)
    expect(out).toContain("sound('bd # sn')")
  })

  it('registry oscillators: supersaw/pulse/noise/fm/lfo with enums + named args', () => {
    const out = ok(
      `synth z\n  supersaw detune:.4 mix:.8\n  * env\n  env = adsr .01 .1 .8 .1\n  wob = lfo 4 tri -> 200..3000\n\n` +
      `synth t\n  pulse note .25\n  + noise pink\n  * env\n  env = adsr .01 .1 .8 .1\n\n` +
      `synth u\n  fm note mod feedback:.2\n  * env\n  mod = fm note*2\n  env = adsr .01 .1 .8 .1\n`,
    )
    expect(out).toContain('supersaw(note.freq, { detune: 0.4, mix: 0.8 })')
    expect(out).toContain("lfo(4, 'tri').range(200, 3000)")
    expect(out).toContain('pulse(note.freq, 0.25)')
    expect(out).toContain("noise('pink')")
    expect(out).toContain('fm(note.freq, mod, { feedback: 0.2 })')
  })

  it('registry processors + sig ops as pipeline lines', () => {
    const out = ok(
      `synth z\n  saw\n  shape 2.2 type:tube\n  delay .375 .3\n  bitcrush bits:8\n  pan -0.4\n  tanh\n  clip -1 1\n`,
    )
    expect(out).toContain("shape(saw(note.freq), 2.2, { type: 'tube' })")
    expect(out).toContain(', 0.375, 0.3)') // delay(…, time, feedback)
    expect(out).toContain('bits: 8')
    expect(out).toContain(', -0.4)') // pan position
    expect(out).toContain('.tanh()')
    expect(out).toContain('.clip(-1, 1)')
  })

  it('gated sources with a freq default read the note when no freq is given', () => {
    // REGRESSION: bare `modal model:bell` emitted modal(gate, { model }) with
    // NO freq — the opts object landed in the freq slot and eval failed
    expect(ok(`synth b\n  modal model:bell decay:.4\n`))
      .toContain("modal(gate, note.freq, { model: 'bell', decay: 0.4 })")
    expect(ok(`synth q\n  pluck\n`)).toContain('pluck(gate, note.freq)')
    // an explicit freq still wins
    expect(ok(`synth b\n  modal 1400 model:bar\n`)).toContain("modal(gate, 1400, { model: 'bar' })")
  })

  it('gated sources inject the gate; names + bools emit correctly', () => {
    const out = ok(`synth v\n  sample vox root:57 loop:1\n  * env\n  env = adsr .01 .3 .7 .3\n`)
    expect(out).toContain("sample(gate, 'vox', { root: 57, loop: true })")
    const out2 = ok(`synth q\n  pluck note decay:.4\n`)
    expect(out2).toContain('pluck(gate, note.freq, { decay: 0.4 })')
  })

  it('sample slicing: the window, the chops and reverse all emit', () => {
    expect(ok(`synth c\n  sample take1 start:.25 end:.5\n`))
      .toContain("sample(gate, 'take1', { start: 0.25, end: 0.5 })")
    expect(ok(`synth c\n  sample take1 slices:8\n`)).toContain("sample(gate, 'take1', { slices: 8 })")
    // the full chopper spelling: a windowed, reversed, chopped, root-mapped take
    expect(ok(`synth c\n  sample take1 root:48 start:.25 end:.75 reverse:1 slices:8 fade:.005\n`)).toContain(
      "sample(gate, 'take1', { root: 48, start: 0.25, end: 0.75, reverse: true, slices: 8, fade: 0.005 })",
    )
    expect(ok(`synth c\n  sample take1 reverse:0\n`)).toContain("sample(gate, 'take1', { reverse: false })")
  })

  it('rejects a named arg the builtin does not declare, AT the argument', () => {
    /* The column moved from the start of the call to the offending argument
     * itself (3 -> 12 / 16) when named args started binding to the nearest
     * call that ACCEPTS them. That is the better place for it: the author was
     * looking at `wobble:` when they typed it, not at `supersaw`. */
    failsAt(`synth z\n  supersaw wobble:3\n`, '`supersaw` has no `wobble:` argument', 2, 12)
    failsAt(`synth z\n  sample take1 slice:3\n`, '`sample` has no `slice:` argument', 2, 16)
  })

  it('a named arg binds to the nearest call that ACCEPTS it, not the nearest call', () => {
    /* `supersaw` declares `detune:` and not `bands:`, so `bands:` belongs to
     * the vocoder wrapped around it. This used to be a parse error, and it is
     * why giving `mic` a `device:` argument broke `vocoder mic bands:24`:
     * adding a named argument to a NESTED builtin must not change how a
     * following one binds. */
    const out = ok(`synth z\n  vocoder supersaw detune:.4 bands:16\n`)
    expect(out).toContain('{ detune: 0.4 }')
    expect(out).toContain('{ bands: 16 }')
  })

  it('and still rejects one that NOBODY takes', () => {
    // walking outward must not turn a typo into silence
    failsAt(`synth z\n  vocoder supersaw nonsense:1\n`, 'has no `nonsense:` argument', 2, 20)
  })

  it('synth header voice options → the synth() opts arg', () => {
    const out = ok(`synth bass mono glide:.08\n  saw\n  * env\n  env = adsr .005 .1 .9 .05\n`)
    expect(out).toContain('}, { mono: true, glide: 0.08 })')
    const out2 = ok(`synth wide unison:5 detune:14 spread:.9\n  saw\n  post\n    reverb mix:.3\n`)
    expect(out2).toContain(', { unison: 5, detune: 14, spread: 0.9 })')
  })

  it('unison-shaping header options (curve/blend/octaves) → the synth() opts arg', () => {
    const out = ok(`synth stakk unison:5 curve:2 blend:.6 octaves:2\n  saw\n`)
    expect(out).toContain(', { unison: 5, curve: 2, blend: 0.6, octaves: 2 })')
    failsAt(`synth z wobble:2\n  saw\n`, 'unknown synth option `wobble`', 1, 9)
  })

  it('dualsvf: two cutoff positionals, routing + per-stage modes as named enums', () => {
    const out = ok(`synth duo\n  saw\n  dualsvf 400 4000 mode:parallel a:lp b:hp res:.3\n`)
    expect(out).toContain("dualsvf(saw(note.freq), 400, 4000, { res: 0.3, mode: 'parallel', a: 'lp', b: 'hp' })")
    // bare serial cascade: only the cutoffs
    const out2 = ok(`synth twin\n  saw\n  dualsvf 800 1200\n`)
    expect(out2).toContain('dualsvf(saw(note.freq), 800, 1200)')
  })

  it('quotes word arguments in bare combinators (arp updown)', () => {
    const out = ok(`synth z\n  saw\n\nplay z\n  0 2 4\n  arp updown\n`)
    expect(out).toContain(".arp('updown')")
  })

  it('sidechain line: depth/release reserved, other named args are duck amounts', () => {
    const out = ok(`synth kick\n  sine 60\n\nplay kick\n  c2 ~\n\nsidechain kick depth:.7 release:90 lead:.5 pad:.65\n`)
    expect(out).toContain("sidechain('kick', { depth: 0.7, release: 90, duck: { lead: 0.5, pad: 0.65 } })")
  })

  it('master line → masterCompress (negative values glued to the colon work)', () => {
    const out = ok(`synth z\n  saw\n\nplay z\n  0\n\nmaster threshold:-6 ratio:2 makeup:1\n`)
    expect(out).toContain('masterCompress({ threshold: -6, ratio: 2, makeup: 1 })')
  })

  /* `gain` is the only line that scales every part equally. It exists because
   * the offline render peak-normalizes anything over 0.89 back down to it, so
   * a project mixed past that ceiling cannot be turned down by any per-part
   * gain — they are all inert up there — and could not be turned down at all
   * before this. */
  /* `sum k 1..16` — the body summed once per k.
   *
   * An additive voice is N copies of one line with the numbers moving, and
   * writing them out was the only way rondo had. The piano that motivated
   * this needs `k * sqrt(1 + B*k^2)`, which has NO parenless spelling — so
   * the test that matters is that bindings can carry the index, because
   * bindings are how rondo writes what other languages need parens for. */
  it('sum: the body is repeated and added, once per index', () => {
    const out = ok('synth organ\n  sum k 1..3\n    sine note * k\n\nplay organ\n  c3\n')
    expect(out).toContain('sine(note.freq.mul(1)).add(sine(note.freq.mul(2))).add(sine(note.freq.mul(3)))')
  })

  it('sum: a binding may be built FROM the index, and from another binding', () => {
    const out = ok('synth v\n  sum k 1..2\n    sine note * ratio\n    inner = 1 + .0004 * k^2\n    ratio = k * inner^.5\n\nplay v\n  c3\n')
    // k=1: 1*sqrt(1+.0004) = 1.0002; k=2: 2*sqrt(1+.0016) = 2.0016
    expect(out).toMatch(/mul\(1\.0001999/)
    expect(out).toMatch(/mul\(2\.0015993/)
  })

  it('sum: index arithmetic FOLDS instead of building nodes', () => {
    // after substitution `7.5 / k^.66` is a number; left unfolded it is not
    // even expressible (`number / signal` has no spelling) let alone useful
    const out = ok('synth v\n  sum k 1..2\n    sine note\n    * env\n    dk = 7.5 / k^.66\n    env = adsr .002 dk 0 .28\n\nplay v\n  c3\n')
    expect(out).toContain('d: 7.5')
    expect(out).not.toContain('Math.pow')
  })

  it('sum: sits alongside ordinary spine lines', () => {
    const out = ok('synth v\n  sum k 1..2\n    sine note * k\n  * env\n  env = adsr .01 .2 .5 .2\n\nplay v\n  c3\n')
    expect(out).toContain('.mul(env)')
  })

  /* `section NAME N with OTHER` — play a section on top of another.
   *
   * Measured on a real arrangement: `intro2` repeated 4 of its 8 parts
   * verbatim from `intro`, and `main` repeated 2 of 4 from `build`. `song`
   * can only put sections in a ROW, so a section that is "that one plus
   * these" had to be written out in full. This is both missing things at
   * once: LAYERING (a drums-only section stacked under several others) and
   * VARIATION (a section that is another plus two more parts). */
  describe('a section can play with another', () => {
    const S = 'synth a\n  saw note\n\nsynth b\n  sine 60\n\n'

    it('stacks the other section IN, by reference', () => {
      const out = ok(`${S}section one 4\n  play a\n    c3\n\nsection two 4 with one\n  play b\n    c4\n`)
      // a REFERENCE, not a copy: editing `one` must change `two`
      expect(out).toContain('const __sec_two = stack(')
      expect(out).toContain('__sec_one')
      expect(out.match(/note\('c3'\)/g), "one's pattern is written ONCE").toHaveLength(1)
    })

    it('layers several, so a drum section can sit under anything', () => {
      const out = ok(
        `${S}section d 4\n  play a\n    c3\n\nsection m 4\n  play b\n    c4\n\nsection full 4 with d with m\n  play a\n    e3\n`,
      )
      expect(out).toContain('__sec_d')
      expect(out).toContain('__sec_m')
    })

    it('is allowed to add nothing of its own — a pure layering', () => {
      const out = ok(`${S}section one 4\n  play a\n    c3\n\nsection two 4 with one\n  play b\n    c4\n`)
      expect(out).toContain('__sec_one')
    })

    it('refuses a section that is not defined ABOVE it', () => {
      // sections emit in source order; a forward reference would be a const
      // used before its declaration, which is a runtime error not a message
      failsAt(
        `${S}section two 4 with one\n  play a\n    c3\n\nsection one 4\n  play b\n    c4\n`,
        "no section 'one' defined above 'two'",
        7,
        1,
      )
    })

    it('refuses a section that plays with itself', () => {
      failsAt(`${S}section one 4 with one\n  play a\n    c3\n`, 'cannot play with itself', 7, 1)
    })

    it('says what a malformed header is missing', () => {
      failsAt(`${S}section one 4 with\n  play a\n    c3\n`, 'with needs a section name', 7, 15)
    })
  })

  /* PATDEF — name a pattern so it is written once.
   *
   * Measured on a real 472-line arrangement: 16% of the file was a repeat of
   * a line already in it, one 333-character riff four times over. Editing
   * that riff meant finding every copy, and missing one let two sections
   * drift apart with nothing to say so. */
  describe('patdef names a pattern', () => {
    const S = 'synth lead\n  saw note\n\n'

    it('emits the notation at every use site', () => {
      const out = ok(`patdef riff <[0 ~ 3] [5 ~ 7]>\n\n${S}play lead\n  riff\n\nplay lead\n  riff\n  add 7\n`)
      const uses = [...out.matchAll(/\b(?:n|note|mini)\('([^']+)'\)/g)].map((m) => m[1])
      expect(uses).toEqual(['<[0 ~ 3] [5 ~ 7]>', '<[0 ~ 3] [5 ~ 7]>'])
    })

    it('leaves NOTHING of itself at runtime', () => {
      // it is a compile-time substitution, like macro — nothing downstream
      // (scheduler, roll widget, offline render) learns a name was involved
      expect(ok(`patdef riff <[0 ~ 3]>\n\n${S}play lead\n  riff\n`)).not.toContain('patdef')
    })

    it('works inside a section, and alongside modifiers', () => {
      const out = ok(`patdef riff <[0 ~ 3]>\n\n${S}section a 2\n  play lead\n    riff\n    gain: .6\n\nsong a\n`)
      expect(out).toContain('<[0 ~ 3]>')
      expect(out).toContain('.gain(0.6)')
    })

    it('leaves a notation that merely CONTAINS the name alone', () => {
      // only a whole line is a reference; `riff` inside a bracket is a word
      const out = ok(`patdef riff <[0 ~ 3]>\n\nsynth riffy\n  saw note\n\nbeat\n  riffy ~ riffy ~\n`)
      expect(out).toContain('riffy ~ riffy ~')
    })

    it('refuses a name that is ALSO a synth, rather than picking one', () => {
      // a beat line's bare word already means a synth: it cannot mean both
      failsAt(
        'patdef kick <[0 ~ 3]>\n\nsynth kick\n  sine 60\n\nbeat\n  kick ~\n',
        'both a synth and a patdef',
        3,
        1,
      )
    })

    it('refuses a duplicate definition', () => {
      failsAt('patdef riff <[0]>\n\npatdef riff <[3]>\n\nsynth z\n  saw\n', 'defined twice', 3, 1)
    })

    it('says which way the header is wrong', () => {
      failsAt('patdef\n', 'patdef needs a name', 1, 1)
      failsAt('patdef riff\n', "patdef 'riff' has no notation", 1, 1)
    })
  })

  /* PARENS. They were not rejected before this — they were DROPPED, along with
   * every other character the lexer did not recognise, because notation lines
   * read `(` from raw text as euclid. So `gate * (1 + gate)` lexed as
   * `gate * 1 + gate` and computed something else with no error anywhere. */
  describe('parens group arithmetic', () => {
    const env = (line: string) => {
      const out = ok(`synth v\n  saw note\n  * env\n  env = ${line}\n\nplay v\n  c3\n`)
      return (out.split('\n').find((l) => l.includes('const env')) ?? '').trim()
    }

    it('changes the answer, where before they changed nothing', () => {
      expect(env('1 + 2 * 3')).toContain('6.add(1)') // 7
      expect(env('(1 + 2) * 3')).toContain('3.mul(3)') // 9 — silently 7 before
    })

    it('groups a signal operand instead of re-associating it', () => {
      expect(env('gate * (1 + gate)')).toContain('gate.mul(gate.add(1))')
    })

    it('nests, and a group may hold a range map', () => {
      // no constant folding outside a `sum` — the point is the SHAPE: the
      // inner group is built first, which is what parens are for
      expect(env('((1 + 1) * 2) ^ 2')).toContain('2.mul(2).pow(2)')
      expect(ok('synth v\n  saw note\n  svf cut\n  cut = (gate -> 200..2000)\n\nplay v\n  c3\n')).toContain('range(200, 2000)')
    })

    it('may begin a space-separated argument', () => {
      expect(ok('synth v\n  saw note\n  * adsr .002 (1 / 2) 0 .28\n\nplay v\n  c3\n')).toContain('d: 0.5')
    })

    it('says which paren is wrong', () => {
      failsAt('synth v\n  saw note\n  * (1 + 2\n', 'unclosed `(`', 3, 5)
      failsAt('synth v\n  saw note\n  * 1 + 2)\n', 'unmatched `)`', 3, 10)  // AT the paren
    })

    it('leaves euclid in a notation line alone', () => {
      // `(` means something else there, and notation is read from raw text
      const out = ok('synth rim\n  noise\n\nbeat\n  rim(7,16)\n')
      expect(out).toContain('rim(7,16)')
    })
  })

  /* MULTILINE NOTATION. Two notation lines already mean two STACKED voices,
   * so a pattern can only be continued where the meaning is currently an
   * ERROR: while a group is still open. That is also the rule with nothing to
   * learn — you have not closed your bracket, so the pattern is not finished. */
  describe('a pattern may run across lines while a group is open', () => {
    const S = 'synth v\n  saw note\n\n'

    it('joins the lines into one pattern', () => {
      const out = ok(`${S}play v\n  <[c2 e2]\n   [f2 a2]>\n`)
      expect(out).toMatch(/note\('<\[c2 e2\] +\[f2 a2\]>'\)/)
      expect(out, 'not two voices').not.toContain('stack(')
    })

    it('leaves two BALANCED lines as the stacked voices they already were', () => {
      const out = ok(`${S}play v\n  c2 e2\n  g3 b3\n`)
      expect(out).toContain('stack(note(\'c2 e2\'), note(\'g3 b3\'))')
    })

    it('keeps every character at its DOCUMENT offset', () => {
      // the join fills the gap with spaces rather than closing it up, so the
      // note-play flash still lights the right characters on a continued line
      const src = `${S}play v\n  <[c2 e2]\n   [f2 a2]>\n`
      const out = ok(src)
      const joined = /note\('([^']*)'\)/.exec(out)![1]!
      const start = src.indexOf('<[c2 e2]')
      expect(src.slice(start, start + joined.length).replace(/\s/g, ' ')).toBe(joined)
    })

    it('works in a beat block and across three lines', () => {
      const out = ok('synth kick\n  sine 60\n\nbeat\n  <[kick ~]\n   [~ kick]\n   [kick kick]>\n')
      expect(out).toContain('kick kick]>')
    })

    it('says so when the group is never closed', () => {
      // reported on the line that OPENED the group, not where the body ran out
      failsAt(`${S}play v\n  <[c2 e2]\n  dur: .9\n`, 'notation leaves a group open', 5, 3)
    })
  })

  it('level line → masterGain, in dB, negative included', () => {
    expect(ok(`synth z\n  saw\n\nplay z\n  0\n\nlevel -4.5\n`)).toContain('masterGain(-4.5)')
    expect(ok(`synth z\n  saw\n\nplay z\n  0\n\nlevel 2\n`)).toContain('masterGain(2)')
  })

  it('bus block: FX folded from input + send routing; knobs are rejected', () => {
    const out = ok(`synth z\n  saw\n\nplay z\n  0 3\n\nbus space\n  reverb room:.9 damp:.3\n  send s .35\n`)
    expect(out).toContain("bus('space', ({ input, reverb }) => {")
    expect(out).toContain('reverb(input, { roomSize: 0.9, damp: 0.3 })')
    expect(out).toContain(', { s: 0.35 })')
    expect(compile(`synth z\n  saw\n\nbus b\n  reverb mix:g\n  g = knob .3 0..1\n`).ok).toBe(false)
  })

  it('visual block passes WGSL through verbatim', () => {
    const out = ok(`synth z\n  saw\n\nplay z\n  0\n\nvisual\n  fn render(uv: vec2f) -> vec4f {\n    return vec4f(uv, 0.0, 1.0);\n  }\n`)
    expect(out).toContain('visual(`')
    expect(out).toContain('fn render(uv: vec2f) -> vec4f {')
    expect(out).toContain('  return vec4f(uv, 0.0, 1.0);') // nested indent kept
  })

  it('chord names (uppercase root) pick chord(); stacked lines pick stack()', () => {
    const out = ok(`synth pad\n  saw\n\nplay pad\n  <Am F C G>\n  dur: .95\n`)
    expect(out).toContain("chord('<Am F C G>')")
    const out2 = ok(`synth pad\n  saw\n\nplay pad\n  <0 5 2 6>\n  <2 7 4 8>\n  <4 9 6 10>\n  scale: c-min\n  dur: .98\n`)
    expect(out2).toContain("stack(n('<0 5 2 6>'), n('<2 7 4 8>'), n('<4 9 6 10>')).scale('c minor')")
  })

  it('sections + song compile to arrange() over stacked section patterns', () => {
    const out = ok(
      `synth kick\n  sine 60\n\nsynth pad\n  saw\n\n` +
      `section intro 4\n  play pad\n    <0 5 2 6>\n    scale: c-min\n\n` +
      `section drop 8\n  play kick\n    c2 c2 c2 c2\n  play pad\n    <0 5 2 6>\n    scale: c-min\n\n` +
      `song intro drop drop intro\n`,
    )
    expect(out).toContain("const __sec_intro = n('<0 5 2 6>').scale('c minor').sound('pad')")
    expect(out).toContain("const __sec_drop = stack(note('c2 c2 c2 c2').sound('kick'), n('<0 5 2 6>')")
    expect(out).toContain("p('song', arrange([4, __sec_intro], [8, __sec_drop], [8, __sec_drop], [4, __sec_intro]))")
  })

  it('sections without a song line arrange in definition order', () => {
    const out = ok(`synth z\n  saw\n\nsection a 2\n  play z\n    0\n\nsection b 4\n  play z\n    3\n`)
    expect(out).toContain("p('song', arrange([2, __sec_a], [4, __sec_b]))")
  })

  it('song referencing an unknown section is an error', () => {
    failsAt(`synth z\n  saw\n\nsection a 2\n  play z\n    0\n\nsong a nope\n`,
      "song references unknown section 'nope'", 8, 1)
  })

  it('function-taking combinators: jux/off/superimpose/sometimesby', () => {
    const out = ok(
      `synth z\n  saw\n\nplay z\n  0 2 4\n  jux: rev\n  off .25: gain .3\n  superimpose: late .125\n  sometimesby .3: fast 2\n`,
    )
    expect(out).toContain('.jux(x => x.rev())')
    expect(out).toContain('.off(0.25, x => x.gain(0.3))')
    expect(out).toContain('.superimpose(x => x.late(0.125))')
    expect(out).toContain('.sometimesBy(0.3, x => x.fast(2))')
    // the camelCase spelling is accepted too (FN_COMBS matches case-insensitively)
    expect(ok(`synth z\n  saw\n\nplay z\n  0 2 4\n  sometimesBy .3: fast 2\n`))
      .toContain('.sometimesBy(0.3, x => x.fast(2))')
  })

  it('rise/fall as ctrl values (build ramps)', () => {
    const out = ok(`synth z\n  saw\n  wet = knob .2 0..1\n\nplay z\n  0 2\n  wet: rise 8 0..1\n  gain: fall 4\n`)
    expect(out).toContain(".ctrl('wet', rise(8).range(0, 1))")
    expect(out).toContain('.gain(fall(4))')
  })

  it('routes bare combinators and a mini-string ctrl value', () => {
    const out = ok(`synth z\n  saw\n\nplay z\n  0 2 4\n  struct t ~ t t\n  fast 2\n  index: <1 2.5>\n`)
    expect(out).toContain(".struct(mini('t ~ t t'))")
    expect(out).toContain('.fast(2)')
    expect(out).toContain(".ctrl('index', '<1 2.5>')")
  })

  it('emits a post chain as the synth() second arg, with mix wet/dry sugar', () => {
    const out = ok(`synth pad\n  saw\n  * env\n  env = adsr .3 .5 .8 1\n  post\n    reverb room:.85 mix:.35\n`)
    // two-function synth(): voice then post (post ctx destructures `input`)
    expect(out).toContain('}, ({ input')
    // reverb is wet-only, so mix: blends it back over the dry input
    expect(out).toContain('((x) => x.mix(reverb(x, { roomSize: 0.85 }), 0.35))(input)')
  })

  it('supports a drivable POST param (knob in post → param, driven by .ctrl)', () => {
    const out = ok(
      `synth pad\n  saw\n  post\n    reverb room:.85 mix:wet\n    wet = knob .35 0..0.7\n\n` +
      `play pad\n  0 3 5\n  wet: sine 0..0.7 slow:8\n`,
    )
    expect(out).toContain("const wet = param('wet', 0.35, { min: 0, max: 0.7 })")
    expect(out).toContain('((x) => x.mix(reverb(x, { roomSize: 0.85 }), wet))(input)')
    expect(out).toContain(".ctrl('wet', sine.range(0, 0.7).slow(8))")
  })
})

describe('maskJsLiterals', () => {
  it('blanks string literal TEXT so ctx names inside quotes never match', () => {
    const masked = maskJsLiterals("mix('saw', 0.5)")
    expect(masked).toBe("mix('   ', 0.5)")
  })

  it('handles escaped quotes without ending the string early', () => {
    const src = "f('it\\'s a saw') + saw"
    const masked = maskJsLiterals(src)
    expect(masked.length).toBe(src.length)
    expect(masked).toBe("f('           ') + saw") // only the literal's text blanked
  })

  it('blanks line comments to end of line', () => {
    const src = 'saw(note.freq) // uses mix and delay\n1'
    const masked = maskJsLiterals(src)
    expect(masked).toContain('saw(note.freq)')
    expect(masked).not.toContain('mix')
    expect(masked).not.toContain('delay')
    expect(masked.endsWith('\n1')).toBe(true)
  })

  it('blanks block comments, preserving newlines', () => {
    const src = '/* saw\n mix */ delay(x)'
    const masked = maskJsLiterals(src)
    expect(masked).not.toContain('saw')
    expect(masked).not.toContain('mix')
    expect(masked).toContain('delay(x)')
    expect(masked.split('\n').length).toBe(2)
  })

  it('template literals: TEXT is masked, ${ } interpolations stay visible', () => {
    const masked = maskJsLiterals('f(`saw and ${mix}`)')
    expect(masked).not.toContain('saw')
    expect(masked).toContain('${mix}')
  })

  it('nested templates: inner text masked, inner interpolation kept', () => {
    const masked = maskJsLiterals('f(`a ${g(`saw ${mix}`)} b`)')
    expect(masked).not.toContain('saw')
    expect(masked).toContain('${mix}')
    expect(masked).toContain('g(`')
  })

  it('object braces inside ${ } do not close the interpolation early', () => {
    const masked = maskJsLiterals('f(`x ${ h({ a: saw }) } saw`)')
    expect(masked).toContain('h({ a: saw })')
    // the trailing ` saw` is template TEXT → masked
    expect(masked.match(/saw/g)).toHaveLength(1)
  })

  it('a ctx name in a string does not phantom-destructure (compile-level)', () => {
    const r = compile("synth z\n  js{ sample(gate, 'saw').mul(0.5) }\n")
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // `saw` appears only as sample-name DATA — it must not be destructured
    const head = /synth\(\(\{ ([^}]*) \}\)/.exec(r.code)![1]!
    expect(head.split(', ')).not.toContain('saw')
    expect(head.split(', ')).toContain('sample')
  })
})

describe('positioned diagnostics', () => {
  it('end-of-line errors land past the last token, never at 0:0', () => {
    // REGRESSION: Cursor.err fell back to { line: 0, col: 0 } at end-of-tokens,
    // so a trailing operator squiggled the top of the buffer
    failsAt('synth z\n  saw\n  * env +\n  env = adsr .01 .1 .5 .1\n', 'unexpected end of line', 3, 10)
    // an incomplete knob reports on ITS line too (two errors, both positioned)
    const e = fails('synth z\n  saw\n  * g\n  g = knob\n')
    expect(e.line).toBe(4)
    expect(e.col).toBe(11)
  })

  it('a spine line with no tokens at all still reports on its own line', () => {
    // `~ ~ ~` lexes to ZERO tokens (mini characters are skipped) — the error
    // must fall back to the line's position, not 0:0
    failsAt('synth z\n  saw\n  ~ ~ ~\n', 'expected a transform', 3, 3)
  })

  it('block headers: missing names and arguments are positioned', () => {
    failsAt('synth\n  saw\n', 'synth needs a name (`synth lead`)', 1, 1)
    failsAt('play\n  0 3\n', 'play needs a synth name (`play lead`)', 1, 1)
    failsAt('cps\n', 'cps needs a number (`cps .6`)', 1, 1)
    failsAt('cps fast\n', 'cps needs a number (`cps .6`)', 1, 1)
    failsAt('bpm\n', 'bpm needs a number (`bpm 128`)', 1, 1)
    failsAt('bpm fast\n', 'bpm needs a number (`bpm 128`)', 1, 1)
    failsAt('bus\n  reverb room:.5\n', 'bus needs a name (`bus space`)', 1, 1)
    failsAt('sing\n  la\n  c4\n', 'sing needs a channel name (`sing vox`)', 1, 1)
    failsAt('section\n  play z\n    0\n', 'section needs a name and a length in cycles', 1, 1)
  })

  it('post must be the last section — error points at the post line', () => {
    failsAt('synth z\n  saw\n  post\n    reverb room:.5\n  * 2\n', 'post must be the last section of a synth', 3, 3)
    failsAt('sing v\n  la la\n  c4 e4\n  post\n    reverb room:.5\n  gain: .9\n', 'post must be the last section of a sing block', 4, 3)
  })

  it('play without notation / section without plays', () => {
    failsAt('synth z\n  saw\n\nplay z\n', "play 'z' has no notation", 4, 1)
    failsAt('synth z\n  saw\n\nsection a 4\n', "section 'a' has no plays", 4, 1)
    failsAt('synth z\n  saw\n\nsection a 4\n  cutoff: 3\n', 'a section holds `play` and `beat` blocks', 5, 3)
  })

  it('malformed sidechain/master name:number pairs point at the bad pair', () => {
    // a bare word is now allowed HERE — it names a project control — so the
    // error moved from "not a number" to "no such control", which is the more
    // useful thing to be told. It must stay an error either way: resolving an
    // unknown name to 0 would be a pump silently switched off by a typo.
    failsAt('synth kick\n  sine 60\n\nsidechain kick depth:fast\n', "no macro or switch named 'fast'", 4, 1)
    // ...and a DECLARED one compiles
    expect(compile('macro x 1 0..2\n\nsynth kick\n  sine 60\n\nsidechain kick depth:x\n').ok).toBe(true)
    failsAt('sidechain\n', 'sidechain needs a source synth', 1, 1)
    failsAt('synth z\n  saw\n\nmaster threshold:x\n', 'master args are `name:number` pairs', 4, 8)
    failsAt('synth z\n  saw\n\nlevel\n', 'level needs a number of dB', 4, 1)
    // sum: every way the header can be wrong says which way
    failsAt('synth v\n  sum\n    sine note\n', 'sum needs an index name and a range', 2, 3)
    failsAt('synth v\n  sum k\n    sine note\n', 'sum needs a range after the index', 2, 3)
    failsAt('synth v\n  sum k 8..2\n    sine note\n', 'sum range runs backwards', 2, 3)
    failsAt('synth v\n  sum k 1..900\n    sine note\n', 'more voices than this can build', 2, 3)
    failsAt('synth v\n  sum k 1..4\n', 'sum needs an indented body', 2, 3)
    failsAt('synth v\n  sum k 1.5..4\n    sine note\n', 'whole numbers', 2, 3)
  })

  it('unknown synth voice option points at the option token', () => {
    failsAt('synth z wobble:3\n  saw\n', 'unknown synth option `wobble`', 1, 9)
  })

  it('unexpected indentation points at the stray line', () => {
    failsAt('cps .5\n  0 3\n', 'unexpected indentation', 2, 1)
  })

  it('lexer: unterminated js{ … } is positioned and never cascades a 0:0 error', () => {
    const e = fails('synth z\n  js{ saw(note.freq\n')
    expect(e.message).toContain('unterminated js{ … } block')
    expect({ line: e.line, col: e.col }).toEqual({ line: 2, col: 3 })
  })

  it('lexer: tabs in indentation are positioned', () => {
    failsAt('synth z\n\tsaw\n', 'use spaces, not tabs, for indentation', 2, 1)
  })

  it('codegen: knob outside a binding / non-constant -> bounds on a number', () => {
    failsAt('synth z\n  saw\n  * knob 1 0..2\n', 'knob can only appear on a binding', 3, 5)
    failsAt('synth z\n  saw\n  * x\n  x = 2 -> 0..env\n  env = adsr .01 .1 .5 .1\n',
      'the left side of `->` must be a signal', 4, 9)
  })
})

/* PATDEF and the two things that only break OUTSIDE the compiler.
 *
 * Both were silent. A one-character name compiled and played nonsense; a
 * substituted play line reported the notation's text with the REFERENCE's
 * offset, so the editor lit five characters of `riffA` with a ninety-character
 * figure and note-flash went wrong everywhere the feature was used. */
describe('patdef: the notation, and where it came from', () => {
  it('takes the notation after the NAME, not after the first letter of it', () => {
    // `indexOf(name)` found the `a` inside "p-a-tdef", so the notation became
    // the string "tdef a <[0 1]>" — which compiled
    const out = ok('patdef a <[0 1]>\n\nsynth q\n  saw\n\nplay q\n  a\n\ncps .5\n')
    expect(out).toContain("n('<[0 1]>')")
    expect(out, 'the keyword must not be eaten').not.toContain('tdef')
  })

  it('reports the substituted notation at the PATDEF line, not the reference', () => {
    // the span note-flash highlights: content and offset have to agree, or the
    // editor decorates whatever text happens to sit there
    const src = 'patdef riff <[0 1 2 3]>\n\nsynth q\n  saw\n\nplay q\n  riff\n\ncps .5\n'
    const c = compile(src)
    if (!c.ok) throw new Error(JSON.stringify(c.errors))
    expect(c.notes).toHaveLength(1)
    const span = c.notes[0]!
    expect(src.slice(span.from, span.from + span.content.length)).toBe(span.content)
    expect(span.content).toBe('<[0 1 2 3]>')
  })

  it('does the same for every voice of a stacked play block', () => {
    const src = 'patdef a1 <[0 1]>\npatdef b1 <[2 3]>\n\nsynth q\n  saw\n\nplay q\n  a1\n  b1\n\ncps .5\n'
    const c = compile(src)
    if (!c.ok) throw new Error(JSON.stringify(c.errors))
    expect(c.notes).toHaveLength(2)
    for (const s of c.notes) expect(src.slice(s.from, s.from + s.content.length)).toBe(s.content)
  })

  it('leaves an ordinary inline notation pointing at itself', () => {
    const src = 'synth q\n  saw\n\nplay q\n  <[0 1 2]>\n\ncps .5\n'
    const c = compile(src)
    if (!c.ok) throw new Error(JSON.stringify(c.errors))
    const s = c.notes[0]!
    expect(src.slice(s.from, s.from + s.content.length)).toBe(s.content)
  })
})

/* PATDEFS COMPOSE. A figure is usually a variation on another one: in a real
 * arrangement three riffs shared the same three-bar tail and differed only in
 * the opening bar. Without composition that tail is written out once per
 * figure, which is the duplication patdef exists to remove. */
describe('patdef composition', () => {
  it('expands a reference INSIDE a figure, not just on its own line', () => {
    const out = ok('patdef tail [1 2] [3 4]\npatdef riff <[0 0] tail>\n\nsynth q\n  saw\n\nplay q\n  riff\n\ncps .5\n')
    expect(out).toContain("n('<[0 0] [1 2] [3 4]>')")
  })

  it('chains: a figure may build on one that builds on another', () => {
    const out = ok('patdef inner [1 2]\npatdef mid <inner inner>\npatdef outer <[0] mid>\n\nsynth q\n  saw\n\nplay q\n  outer\n\ncps .5\n')
    expect(out).toContain("n('<[0] <[1 2] [1 2]>>')")
  })

  it('a PLAY LINE splices a reference inline, not just as the whole line', () => {
    /* The documented promise is "write the name anywhere notation goes -- a
     * play line, a beat row, another patdef". A play line only substituted a
     * LONE name, so `2 ~ ghost 2` passed straight through and failed later as
     * "'ghost' is not a note name" — false exactly where a reader first tries
     * it, and the one place a per-note figure most wants to be named once. */
    const out = ok('patdef ghost [1 2]\n\nsynth q\n  saw\n\nplay q\n  0 ~ ghost 3\n\ncps .5\n')
    expect(out).toContain("n('0 ~ [1 2] 3')")
  })

  it('inline on a play line works inside brackets and alternations', () => {
    const g = 'patdef ghost [1 2]\n\nsynth q\n  saw\n\nplay q\n'
    expect(ok(`${g}  [ghost] 3\n\ncps .5\n`)).toContain("n('[[1 2]] 3')")
    expect(ok(`${g}  <ghost 3>*2\n\ncps .5\n`)).toContain("n('<[1 2] 3>*2')")
  })

  it('a per-note LANE survives the splice, which is the point of naming it', () => {
    const out = ok("patdef ghost 2'dur:.1'gain:0.1\n\nsynth q\n  saw\n\nplay q\n  2 ~ ghost 2\n\ncps .5\n")
    expect(out).toContain("2\\'dur:.1\\'gain:0.1")
  })

  it('a name that reads as a NOTE is still not spliced on a play line', () => {
    /* Same rule as inside a figure: notation is where note names live, so
     * expanding `patdef e …` would rewrite every `e` in every line. */
    const out = ok('patdef e [1 2]\n\nsynth q\n  saw\n\nplay q\n  2 ~ e 2\n\ncps .5\n')
    expect(out).toContain("note('2 ~ e 2')")
  })

  it('an inline splice keeps note-flash pointing at the right TEXT', () => {
    /* The whole reason expansion carries a piece map. An assembled play line
     * exists nowhere in the buffer as one run — `0 ~ ghost 3` is eleven
     * characters standing for text from two different lines — so a span that
     * only knew its start would light whatever happened to sit there. Each
     * chunk must map back to where it actually came from. */
    const src = 'patdef ghost [1 2]\n\nsynth q\n  saw\n\nplay q\n  0 ~ ghost 3\n\ncps .5\n'
    const c = compile(src)
    if (!c.ok) throw new Error(JSON.stringify(c.errors))
    const span = c.notes[0]!
    expect(span.content).toBe('0 ~ [1 2] 3')
    expect(span.pieces, 'an assembled line needs its origin map').toBeDefined()
    for (const p of span.pieces!) {
      expect(src.slice(p.sourceStart, p.sourceStart + p.length))
        .toBe(span.content.slice(p.assembledStart, p.assembledStart + p.length))
    }
    // and the reference itself is lightable, so a note inside `ghost` lights
    // the word `ghost` where it stands
    expect(span.refs?.map((r) => src.slice(r.from, r.to))).toEqual(['ghost'])
  })

  it('a line with no reference is left exactly alone', () => {
    expect(ok('patdef ghost [1 2]\n\nsynth q\n  saw\n\nplay q\n  0 3 5\n\ncps .5\n')).toContain("n('0 3 5')")
  })

  it('a cycle is an ERROR, not a hang', () => {
    failsAt('patdef loop <[0] loop>\n\nsynth q\n  saw\n\nplay q\n  loop\n\ncps .5\n', 'expands forever', 1, 1)
  })

  it('a mutual cycle is caught too', () => {
    const c = compile('patdef x1 <[0] y1>\npatdef y1 <[1] x1>\n\nsynth q\n  saw\n\nplay q\n  x1\n\ncps .5\n')
    expect(c.ok).toBe(false)
    expect(c.errors[0]!.message).toMatch(/expands forever/)
  })

  /* The one that would silently ruin a document: a NOTE is spelled exactly
   * like a name, and notation is where notes live. */
  it('does not eat note names that match a patdef', () => {
    const out = ok('patdef e <[0 1]>\npatdef tune <c3 e4 g4>\n\nsynth q\n  saw\n\nplay q\n  tune\n\ncps .5\n')
    expect(out, 'e4 is a NOTE here, not a reference').toContain("note('<c3 e4 g4>')")
  })

  it('and a note-like name still works on its own line, as it always did', () => {
    // backwards compatible: whole-line substitution predates composition
    expect(ok('patdef e <[0 1]>\n\nsynth q\n  saw\n\nplay q\n  e\n\ncps .5\n')).toContain("n('<[0 1]>')")
  })

  it('leaves an ordinary figure with no references untouched', () => {
    expect(ok('synth q\n  saw\n\nplay q\n  <[0 1] c3 e4>\n\ncps .5\n')).toContain("note('<[0 1] c3 e4>')")
  })
})

/* WHERE AN ASSEMBLED FIGURE CAME FROM. `<openA tail>` is twelve characters
 * standing for forty-six, so the expansion exists nowhere in the buffer as one
 * run. Note-flash highlights the text at the offset it is handed, so without a
 * chunk map composition would light the reference with the expansion — the
 * same bug that broke highlighting when patdef substitution first shipped. */
describe('patdef composition keeps its source map', () => {
  const SRC = [
    'patdef tail [1 2] [3 4]',
    'patdef riff <[0 0] tail>',
    '',
    'synth q',
    '  saw',
    '',
    'play q',
    '  riff',
    '',
    'cps .5',
    '',
  ].join('\n')

  const span = () => {
    const c = compile(SRC)
    if (!c.ok) throw new Error(JSON.stringify(c.errors))
    expect(c.notes).toHaveLength(1)
    return c.notes[0]!
  }

  it('carries pieces when the figure was assembled', () => {
    const s = span()
    expect(s.content).toBe('<[0 0] [1 2] [3 4]>')
    expect(s.pieces, 'an assembled figure needs a chunk map').toBeDefined()
  })

  it('every chunk matches the buffer at the offset it claims', () => {
    const s = span()
    for (const q of s.pieces!) {
      expect(SRC.slice(q.sourceStart, q.sourceStart + q.length)).toBe(
        s.content.slice(q.assembledStart, q.assembledStart + q.length),
      )
    }
  })

  it('the chunks COVER the content — a gap is a note that flashes nothing', () => {
    const s = span()
    expect(s.pieces!.reduce((n, q) => n + q.length, 0)).toBe(s.content.length)
  })

  it('points the expanded part at the DEFINITION, not at the reference', () => {
    const s = span()
    // the `[1 2] [3 4]` chunk must resolve into the `patdef tail` line
    const tailAt = SRC.indexOf('[1 2] [3 4]')
    expect(s.pieces!.some((q) => q.sourceStart === tailAt)).toBe(true)
  })

  it('a figure written inline carries NO pieces (it matches the buffer already)', () => {
    const c = compile('synth q\n  saw\n\nplay q\n  <[0 1]>\n\ncps .5\n')
    if (!c.ok) throw new Error('failed')
    expect(c.notes[0]!.pieces).toBeUndefined()
  })
})

describe('zonedef: a multisample instrument', () => {
  /* Key zones shipped as a JavaScript-only option because rondo node
   * arguments are num/sig/bool/enum and there is no way to write a list of
   * records inline. A BLOCK is the fit: `wavedef` gets away with a
   * `/`-separated line because its rows are bare numbers, while a zone row
   * carries a range, a name and a root. */
  it('inlines the zones into the `sample` node that names it', () => {
    const out = ok([
      'zonedef piano',
      '  c1..b2 piano_low root:c2',
      '  c3..b4 piano_mid root:c4',
      '',
      'synth kit',
      '  sample piano',
      '',
      'play kit',
      '  c3',
      '',
      'cps .5',
    ].join('\n'))
    expect(out).toContain("sample(gate, 'piano', { zones: [")
    expect(out).toContain("{ lo: 24, hi: 47, name: 'piano_low', root: 36 }")
    expect(out).toContain("{ lo: 48, hi: 71, name: 'piano_mid', root: 60 }")
  })

  it('takes MIDI numbers as well as note names', () => {
    const out = ok('zonedef k\n  0..59 lo root:48\n  60..127 hi root:72\n\nsynth kit\n  sample k\n\nplay kit\n  c3\n\ncps .5')
    expect(out).toContain('{ lo: 0, hi: 59, name: \'lo\', root: 48 }')
    expect(out).toContain('{ lo: 60, hi: 127, name: \'hi\', root: 72 }')
  })

  it('a zone name may be a FAMILY member, so round robin still works inside it', () => {
    const out = ok('zonedef k\n  0..127 snare:1 root:60\n\nsynth kit\n  sample k\n\nplay kit\n  c3\n\ncps .5')
    expect(out).toContain("name: 'snare:1'")
  })

  it('defaults the root to 60 when a row omits it', () => {
    expect(ok('zonedef k\n  0..127 one\n\nsynth kit\n  sample k\n\nplay kit\n  c3\n\ncps .5')).toContain('root: 60')
  })

  it('emits NOTHING of its own — it is inlined, not registered', () => {
    const out = ok('zonedef k\n  0..127 one root:60\n\nsynth kit\n  sample k\n\nplay kit\n  c3\n\ncps .5')
    expect(out, 'a zonedef should have no runtime existence').not.toContain('zonedef')
  })

  it('a sample name that is NOT a zonedef is left alone', () => {
    const out = ok('synth kit\n  sample vox\n\nplay kit\n  c3\n\ncps .5')
    expect(out).toContain("sample(gate, 'vox')")
    expect(out).not.toContain('zones')
  })

  it('says what a malformed row should look like', () => {
    const c = compile('zonedef k\n  nonsense here\n\nsynth kit\n  saw\n\nplay kit\n  0\n\ncps .5')
    expect(c.ok).toBe(false)
    expect(c.errors[0]!.message).toMatch(/lo\.\.hi SAMPLE root/)
  })

  it('refuses a backwards range rather than drawing no notes at all', () => {
    const c = compile('zonedef k\n  c4..c2 low root:c3\n\nsynth kit\n  saw\n\nplay kit\n  0\n\ncps .5')
    expect(c.ok).toBe(false)
    expect(c.errors[0]!.message).toMatch(/backwards/)
  })

  it('needs rows', () => {
    const c = compile('zonedef k\n\nsynth kit\n  saw\n\nplay kit\n  0\n\ncps .5')
    expect(c.ok).toBe(false)
    expect(c.errors[0]!.message).toMatch(/needs rows/)
  })
})

describe('looper: the loop pedal builtin', () => {
  it('takes the pipe as input, the record gate as the positional, the rest named', () => {
    const code = ok(`synth pedal
  mic
  looper rec feedback:decay clear:wipe
  rec = knob 0 0..1
  decay = knob 1 0..1
  wipe = knob 0 0..1

play pedal
  0

cps .5
`)
    expect(code).toMatch(/looper\(/)
    expect(code).toContain('feedback: decay')
    expect(code).toContain('clear: wipe')
  })

  it('a gate-less `looper feedback:…` still compiles: the gate defaults to 0', () => {
    const code = ok('synth pedal\n  mic\n  looper feedback:.9\n\nplay pedal\n  0\n\ncps .5\n')
    expect(code).toContain(', 0, { feedback: 0.9 }')
  })

  it("name: registers the pedal for bouncing, emitted as a string", () => {
    const code = ok('synth pedal\n  mic\n  looper rec name:jam\n  rec = knob 0 0..1\n\nplay pedal\n  0\n\ncps .5\n')
    expect(code).toContain("name: 'jam'")
  })

  it('maxtime: is a NUMBER (it allocates the buffer), refused as a signal', () => {
    const e = fails('synth pedal\n  mic\n  looper rec maxtime:k\n  rec = knob 0 0..1\n  k = knob 10 1..60\n\nplay pedal\n  0\n\ncps .5\n')
    expect(e.message).toMatch(/NUMBER, not a signal/)
  })
})

describe('slur: smart bowing as a modifier line', () => {
  it('compiles a slur lane to the .slur(...) pattern method', () => {
    const code = ok('synth v mono\n  ddsp violin\n\nplay v\n  c3 d3 e3 ~\n  slur .85\n\ncps .5\n')
    expect(code).toMatch(/\.slur\(/)
    expect(code).toContain('.85')
  })
})
