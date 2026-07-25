import { describe, expect, it } from 'vitest'
import { compile } from '../src/compile'

/** unwrap a successful compile or fail loudly with the diagnostics. */
function ok(src: string): string {
  const r = compile(src)
  if (!r.ok) throw new Error('compile failed: ' + JSON.stringify(r.errors))
  return r.code
}

describe('rondo → rondocode codegen', () => {
  it('compiles a bare oscillator synth + degree pattern + cps', () => {
    const out = ok(`synth blip\n  saw\n\nplay blip\n  0 2 4 2\n\ncps .5\n`)
    expect(out).toContain('const blip = synth(({ note, saw }) => {')
    expect(out).toContain('return saw(note.freq)')
    expect(out).toContain("p('blip', n('0 2 4 2').sound('blip'))")
    expect(out).toContain('setCps(0.5)')
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
    expect(ok(`synth p\n  saw\n\nplay p\n  0 3 5  scale:c-maj\n`)).toContain(".scale('c major')")
    expect(ok(`synth p\n  saw\n\nplay p\n  c4 e4 g4\n`)).toContain("note('c4 e4 g4')")
  })

  it('topologically orders bindings so each const precedes its use', () => {
    const out = ok(`synth s\n  sine mod\n  mod = sine base\n  base = adsr .01 .1 .5 .1\n`)
    expect(out.indexOf('const base =')).toBeLessThan(out.indexOf('const mod ='))
  })

  it('reports a positioned error for an unknown top-level block', () => {
    const r = compile(`wobble foo\n  saw\n`)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0]!.line).toBe(1)
  })

  it('rejects a binding cycle', () => {
    const r = compile(`synth s\n  saw\n  a = b\n  b = a\n`)
    expect(r.ok).toBe(false)
  })

  it('compiles play modifier lines: ctrl signal sweep, every, gain', () => {
    const out = ok(
      `synth s\n  saw\n  cutoff = knob 800 80..8000\n\n` +
      `play s\n  0 2 4  scale:a-min\n  cutoff: sine 200..2400 slow:4\n  gain: .8\n  every 4: rev\n`,
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
    const src = `synth s\n  saw\n\nplay s\n  0 3 5 7  scale:c-maj\n`
    const r = compile(src)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.notes).toHaveLength(1)
    const { content, from } = r.notes[0]!
    expect(content).toBe('0 3 5 7')
    expect(src.slice(from, from + content.length)).toBe(content)
  })

  it('js{ … } escape hatch: inline expression destructures the ctx it names', () => {
    const out = ok(`synth s\n  js{ saw(note.freq).tanh() }\n`)
    expect(out).toContain('return saw(note.freq).tanh()')
    expect(out).toContain('synth(({ note, saw }) =>')
  })

  it('js{ … } escape hatch: a top-level one-liner passes through verbatim', () => {
    const out = ok(`synth s\n  saw\n\nplay s\n  0 3 5\n\njs{ sidechain('kick', { depth: 0.7 }) }\n`)
    expect(out).toContain("sidechain('kick', { depth: 0.7 })")
  })

  it('js block is truly verbatim: `#` inside strings and nested indent survive', () => {
    // REGRESSION: body lines were taken from the comment-stripped lexer text,
    // so a '#' inside a JS string got truncated and nested indent flattened.
    const out = ok(`synth s\n  saw\n\nplay s\n  0 3\n\njs\n  bus('space', ({ input, reverb }) => reverb(input), {\n    s: 0.4, // send #1 stays intact\n  })\n`)
    expect(out).toContain('// send #1 stays intact')
    expect(out).toContain('  s: 0.4,') // nested indent preserved relative to the block
  })

  it('js escape hatch: a `js` block emits its indented body verbatim', () => {
    const out = ok(`synth s\n  saw\n\nplay s\n  0 3 5\n\njs\n  sidechain('kick', { depth: 0.6 })\n  masterCompress({ threshold: -6 })\n`)
    expect(out).toContain("sidechain('kick', { depth: 0.6 })")
    expect(out).toContain('masterCompress({ threshold: -6 })')
  })

  it('numeric-LHS arithmetic: folds constants, rewrites num−sig, rejects the rest', () => {
    // REGRESSION: `1 - env` emitted `1.sub(env)` — a JS SyntaxError
    const out = ok(`synth s\n  saw\n  * inv\n  inv = 1 - env\n  env = adsr .01 .1 .5 .1\n`)
    expect(out).toContain('env.mul(-1).add(1)')
    // number⊗number folds to a constant
    expect(ok(`synth s\n  saw\n  * g\n  g = 2 * 3\n`)).toContain('const g = 6')
    // num / sig and num ^ sig have no Sig form → positioned error, not garbage
    expect(compile(`synth s\n  saw\n  * x\n  x = 2 / env\n  env = adsr .01 .1 .5 .1\n`).ok).toBe(false)
  })

  it('`->` binds at statement level, not inside call arguments', () => {
    // REGRESSION: parsed as sine(2 -> 200..2000) → invalid `2.range(…)`
    const out = ok(`synth s\n  sine\n  * env\n  env = adsr .01 .1 .5 .1\n  lfo = sine 2 -> 200..2000\n`)
    expect(out).toContain('sine(2).range(200, 2000)')
  })

  it('rejects a duplicate binding instead of silently dropping the second', () => {
    const r = compile(`synth s\n  saw\n  * env\n  env = adsr .01 .1 .7 .2\n  env = adsr .5 .5 .5 .5\n`)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0]!.message).toContain('duplicate')
  })

  it('rejects a binding named after a special ref (note/gate/adsr/knob/…)', () => {
    const r = compile(`synth s\n  saw\n  gate = 1\n  * gate\n`)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0]!.message).toContain('shadows a builtin')
  })

  it('allows a binding named after an unused builtin, rejects it when the chain calls that builtin', () => {
    // `lfo = sine 2` is idiomatic — legal while the chain never calls lfo()
    expect(compile(`synth s\n  saw\n  * lfo\n  lfo = sine 2 -> 0..1\n`).ok).toBe(true)
    // but binding `fm` AND calling the builtin fm() collides: the ctx
    // destructure and the const would both declare `fm`
    const r = compile(`synth s\n  saw\n  * fm 200\n  fm = adsr .1 .1 .5 .1\n`)
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
    const out = ok(`synth s\n  saw\n  * e\n  e = env .005 1 .15 .4 .5 .6 release:.3 curve:3 loop:1\n`)
    expect(out).toContain('env(gate, [[0.005, 1], [0.15, 0.4], [0.5, 0.6]], { release: 0.3, curve: 3, loop: true })')
    // odd number of values = half a pair — error, not a silent drop
    expect(compile(`synth s\n  saw\n  * e\n  e = env .005 1 .15\n`).ok).toBe(false)
    // bare `env` is still a reference to a binding named env
    expect(ok(`synth s\n  saw\n  * env\n  env = adsr .01 .1 .5 .1\n`)).toContain('.mul(env)')
  })

  it('eq: word-then-numbers band groups → the bands array', () => {
    const out = ok(`synth s\n  saw\n  eq hp 170 highshelf 7000 4\n`)
    expect(out).toContain("eq(saw(note.freq), [{ type: 'hp', freq: 170 }, { type: 'highshelf', freq: 7000, gain: 4 }])")
    // peak takes freq gain q
    expect(ok(`synth s\n  saw\n  eq peak 300 -3 2\n`)).toContain("{ type: 'peak', freq: 300, gain: -3, q: 2 }")
    // unknown band type + missing freq are positioned errors
    expect(compile(`synth s\n  saw\n  eq bandpass 300\n`).ok).toBe(false)
    expect(compile(`synth s\n  saw\n  eq hp\n`).ok).toBe(false)
  })

  it('vocoder: the pipe is the carrier, the positional is the modulator', () => {
    const out = ok(`synth s\n  supersaw\n  vocoder m bands:20\n  m = noise\n`)
    expect(out).toContain('vocoder(supersaw(note.freq), m, { bands: 20 })')
  })

  it('beat block: notation words are synth names → s(…); modifiers apply', () => {
    expect(ok(`beat\n  kick hat kick hat\n  every 4: rev\n`))
      .toContain(`p('beat', s('kick hat kick hat').every(4, x => x.rev()))`)
    // a named beat keeps its channel name; scale is rejected (words aren't notes)
    expect(ok(`beat fills\n  kick [hat hat]\n`)).toContain(`p('fills', s('kick [hat hat]'))`)
    expect(compile(`beat\n  kick hat\n  scale: a-min\n`).ok).toBe(false)
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
    expect(compile(`synth s1\n  saw\n\nplay s1\n  irand eight\n`).ok).toBe(false)
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
    expect(compile('synth s1\n  saw\n\nplay x nonsense\n  0 3\n').ok).toBe(false)
  })

  it('mic: the live microphone as a source (bare, and as a vocoder modulator)', () => {
    expect(ok('synth thru\n  mic\n  * .5\n')).toContain('return mic().mul(0.5)')
    expect(ok('synth talkbox\n  supersaw\n  vocoder mic bands:24\n'))
      .toContain('vocoder(supersaw(note.freq), mic(), { bands: 24 })')
  })

  it('rejects a near-miss scale instead of shipping it inside the notation', () => {
    expect(compile(`synth s\n  saw\n\nplay s\n  0 3 5  scale:minor\n`).ok).toBe(false)
  })

  it('supports negative number literals (sign glued, space-preceded)', () => {
    const out = ok(`synth s\n  saw\n  * g\n  g = knob -6 -12..0\n`)
    expect(out).toContain("param('g', -6, { min: -12, max: 0 })")
    // subtraction still works, spaced or glued
    expect(ok(`synth s\n  saw\n  * x\n  x = env - 1\n  env = adsr .01 .1 .5 .1\n`)).toContain('env.sub(1)')
  })

  it('js{ … } one-liner survives a `#` inside a string', () => {
    // REGRESSION: comment stripping ran quote-blind and truncated the line
    const out = ok(`synth s\n  saw\n\nplay s\n  0 3\n\njs{ p('x', sound('bd # sn')) }\n`)
    expect(out).toContain("sound('bd # sn')")
  })

  it('registry oscillators: supersaw/pulse/noise/fm/lfo with enums + named args', () => {
    const out = ok(
      `synth s\n  supersaw detune:.4 mix:.8\n  * env\n  env = adsr .01 .1 .8 .1\n  wob = lfo 4 tri -> 200..3000\n\n` +
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
      `synth s\n  saw\n  shape 2.2 type:tube\n  delay .375 .3\n  bitcrush bits:8\n  pan -0.4\n  tanh\n  clip -1 1\n`,
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
    expect(ok(`synth p\n  pluck\n`)).toContain('pluck(gate, note.freq)')
    // an explicit freq still wins
    expect(ok(`synth b\n  modal 1400 model:bar\n`)).toContain("modal(gate, 1400, { model: 'bar' })")
  })

  it('gated sources inject the gate; names + bools emit correctly', () => {
    const out = ok(`synth v\n  sample vox root:57 loop:1\n  * env\n  env = adsr .01 .3 .7 .3\n`)
    expect(out).toContain("sample(gate, 'vox', { root: 57, loop: true })")
    const out2 = ok(`synth p\n  pluck note decay:.4\n`)
    expect(out2).toContain('pluck(gate, note.freq, { decay: 0.4 })')
  })

  it('rejects a named arg the builtin does not declare', () => {
    expect(compile(`synth s\n  supersaw wobble:3\n`).ok).toBe(false)
  })

  it('synth header voice options → the synth() opts arg', () => {
    const out = ok(`synth bass mono glide:.08\n  saw\n  * env\n  env = adsr .005 .1 .9 .05\n`)
    expect(out).toContain('}, { mono: true, glide: 0.08 })')
    const out2 = ok(`synth wide unison:5 detune:14 spread:.9\n  saw\n  post\n    reverb mix:.3\n`)
    expect(out2).toContain(', { unison: 5, detune: 14, spread: 0.9 })')
  })

  it('quotes word arguments in bare combinators (arp updown)', () => {
    const out = ok(`synth s\n  saw\n\nplay s\n  0 2 4\n  arp updown\n`)
    expect(out).toContain(".arp('updown')")
  })

  it('sidechain line: depth/release reserved, other named args are duck amounts', () => {
    const out = ok(`synth kick\n  sine 60\n\nplay kick\n  c2 ~\n\nsidechain kick depth:.7 release:.09 lead:.5 pad:.65\n`)
    expect(out).toContain("sidechain('kick', { depth: 0.7, release: 0.09, duck: { lead: 0.5, pad: 0.65 } })")
  })

  it('master line → masterCompress (negative values glued to the colon work)', () => {
    const out = ok(`synth s\n  saw\n\nplay s\n  0\n\nmaster threshold:-6 ratio:2 makeup:1\n`)
    expect(out).toContain('masterCompress({ threshold: -6, ratio: 2, makeup: 1 })')
  })

  it('bus block: FX folded from input + send routing; knobs are rejected', () => {
    const out = ok(`synth s\n  saw\n\nplay s\n  0 3\n\nbus space\n  reverb room:.9 damp:.3\n  send s .35\n`)
    expect(out).toContain("bus('space', ({ input, reverb }) => {")
    expect(out).toContain('reverb(input, { roomSize: 0.9, damp: 0.3 })')
    expect(out).toContain(', { s: 0.35 })')
    expect(compile(`synth s\n  saw\n\nbus b\n  reverb mix:g\n  g = knob .3 0..1\n`).ok).toBe(false)
  })

  it('visual block passes WGSL through verbatim', () => {
    const out = ok(`synth s\n  saw\n\nplay s\n  0\n\nvisual\n  fn render(uv: vec2f) -> vec4f {\n    return vec4f(uv, 0.0, 1.0);\n  }\n`)
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
    const out = ok(`synth s\n  saw\n\nsection a 2\n  play s\n    0\n\nsection b 4\n  play s\n    3\n`)
    expect(out).toContain("p('song', arrange([2, __sec_a], [4, __sec_b]))")
  })

  it('song referencing an unknown section is an error', () => {
    expect(compile(`synth s\n  saw\n\nsection a 2\n  play s\n    0\n\nsong a nope\n`).ok).toBe(false)
  })

  it('function-taking combinators: jux/off/superimpose/sometimesby', () => {
    const out = ok(
      `synth s\n  saw\n\nplay s\n  0 2 4\n  jux: rev\n  off .25: gain .3\n  superimpose: late .125\n  sometimesby .3: fast 2\n`,
    )
    expect(out).toContain('.jux(x => x.rev())')
    expect(out).toContain('.off(0.25, x => x.gain(0.3))')
    expect(out).toContain('.superimpose(x => x.late(0.125))')
    expect(out).toContain('.sometimesBy(0.3, x => x.fast(2))')
  })

  it('rise/fall as ctrl values (build ramps)', () => {
    const out = ok(`synth s\n  saw\n  wet = knob .2 0..1\n\nplay s\n  0 2\n  wet: rise 8 0..1\n  gain: fall 4\n`)
    expect(out).toContain(".ctrl('wet', rise(8).range(0, 1))")
    expect(out).toContain('.gain(fall(4))')
  })

  it('routes bare combinators and a mini-string ctrl value', () => {
    const out = ok(`synth s\n  saw\n\nplay s\n  0 2 4\n  struct t ~ t t\n  fast 2\n  index: <1 2.5>\n`)
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
