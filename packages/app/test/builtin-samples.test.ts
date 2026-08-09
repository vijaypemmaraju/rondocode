import { describe, expect, it } from 'vitest'
import { BUILT_IN_SAMPLE_NAMES, builtInSamples } from '../src/audio/demo-samples'
import { compile } from '@rondocode/rondo'
import { stageCode, runPatterns, renderMix, mixOptsFor } from '../../server/src/render-runner'
import { RECIPES } from '../src/docs/cookbook'
import { EXAMPLES } from '../src/examples'
import { SECTIONS } from '../src/docs/content'

/* ------------------------------------------------------------------------- *
 * ONE list of built-in sample names.
 *
 * There were three, maintained by hand, and all three were already wrong:
 * the editor's completions, a comment in AudioSession, and a sentence in the
 * guide each said "vox, riser and pad" long after `break` had shipped. A
 * reader following the guide had no way to learn `break` existed.
 *
 * The list is now derived from the generators. These tests are what stops a
 * new one being added in the generator and nowhere else.
 * ------------------------------------------------------------------------- */

describe('the built-in samples', () => {
  it('every declared name actually generates audio', () => {
    const bank = builtInSamples(48000)
    expect(Object.keys(bank).sort()).toEqual([...BUILT_IN_SAMPLE_NAMES].sort())
    for (const name of BUILT_IN_SAMPLE_NAMES) {
      const s = bank[name]!
      expect(s.data.length, `${name} is empty`).toBeGreaterThan(1000)
      let peak = 0
      for (const v of s.data) peak = Math.max(peak, Math.abs(v))
      expect(peak, `${name} is silent`).toBeGreaterThan(0.01)
      expect(s.data.every((v) => Number.isFinite(v)), `${name} has non-finite samples`).toBe(true)
    }
  })

  it('is deterministic — the same build gives the same audio', () => {
    // a render has to be reproducible; a seeded generator that drifted would
    // make every bounce different
    const a = builtInSamples(48000)
    const b = builtInSamples(48000)
    for (const name of BUILT_IN_SAMPLE_NAMES) {
      const x = a[name]!.data, y = b[name]!.data
      expect(y.length).toBe(x.length)
      for (let i = 0; i < x.length; i += 997) expect(y[i]!, `${name} sample ${i}`).toBe(x[i]!)
    }
  })

  it('the GUIDE names every one of them', () => {
    /* The drift that actually happened. Prose is where a new sample gets
     * forgotten, because nothing else reads it. */
    const prose = SECTIONS.flatMap((s) => s.blocks)
      .map((b) => JSON.stringify(b))
      .join(' ')
    for (const name of BUILT_IN_SAMPLE_NAMES) {
      expect(prose.includes(`\`${name}\``), `the guide never mentions the built-in sample '${name}'`).toBe(true)
    }
  })
})

describe('the hall impulse response', () => {
  const ir = builtInSamples(48000)['hall']!.data
  const sr = 48000

  const rms = (from: number, to: number): number => {
    let s = 0
    for (let i = from; i < to; i++) s += ir[i]! * ir[i]!
    return Math.sqrt(s / (to - from))
  }

  it('starts with a PREDELAY — silence while the sound crosses the room', () => {
    // most of what "big" sounds like, and the easiest part to leave out
    const firstHit = ir.findIndex((v) => Math.abs(v) > 1e-6)
    expect(firstHit / sr, 'no predelay').toBeGreaterThan(0.005)
    expect(firstHit / sr, 'the predelay is longer than any real hall').toBeLessThan(0.05)
  })

  it('decays smoothly, roughly 60 dB over a couple of seconds', () => {
    const ref = rms(Math.round(0.02 * sr), Math.round(0.07 * sr))
    const db = (t: number): number =>
      20 * Math.log10(rms(Math.round(t * sr), Math.round((t + 0.05) * sr)) / ref)
    // monotonic, and in the right ballpark for a hall
    expect(db(0.3)).toBeGreaterThan(db(0.6))
    expect(db(0.6)).toBeGreaterThan(db(1.0))
    expect(db(1.0)).toBeGreaterThan(db(1.5))
    expect(db(1.0), 'decays far too fast for a hall').toBeLessThan(-20)
    expect(db(1.0), 'barely decays at all').toBeGreaterThan(-50)
  })

  it('ends at silence — a truncated IR convolves as a click', () => {
    expect(Math.abs(ir[ir.length - 1]!)).toBeLessThan(1e-6)
  })

  it('gets DARKER as it decays, the way a real room does', () => {
    /* Air and soft surfaces absorb treble first, so the late tail must have
     * less high-frequency content than the early one. Measured as the mean
     * absolute sample-to-sample difference, which rises with brightness. */
    const slope = (from: number, to: number): number => {
      let s = 0
      for (let i = from + 1; i < to; i++) s += Math.abs(ir[i]! - ir[i - 1]!)
      return s / (to - from) / rms(from, to)
    }
    const early = slope(Math.round(0.1 * sr), Math.round(0.3 * sr))
    const late = slope(Math.round(1.2 * sr), Math.round(1.5 * sr))
    expect(late, 'the tail is as bright as the early reflections').toBeLessThan(early * 0.9)
  })
})


/* ------------------------------------------------------------------------- *
 * AN OFFLINE RENDER HAS THE SAME BANK THE APP DOES.
 *
 * It used to be the caller's job to pass `samples`, and exactly two callers in
 * the repo did it — so every other render resolved `sample`, `granular` and
 * `convolve` names against an EMPTY bank. Measured before the fix: ten doc
 * programs name a built-in, and four of them rendered completely silent while
 * the rest quietly lost their sampled part. All still passed "makes sound",
 * because the synthesised parts make sound.
 * ------------------------------------------------------------------------- */
describe('doc programs that name a built-in sample actually get it', () => {
  const SR = 22050
  const naming = new RegExp(`\\b(?:sample|granular|convolve)\\b[^\\n]*\\b(?:${BUILT_IN_SAMPLE_NAMES.join('|')})\\b`)

  const progs: { label: string; code: string; rondo: boolean }[] = []
  for (const r of RECIPES) if (naming.test(r.code)) progs.push({ label: `recipe:${r.id}`, code: r.code, rondo: true })
  for (const e of EXAMPLES) {
    const src = e.rondo ?? e.code
    if (naming.test(src)) progs.push({ label: `example:${e.name}`, code: src, rondo: e.rondo !== undefined })
  }

  it('there are some, or this block tests nothing', () => {
    expect(progs.length).toBeGreaterThan(3)
  })

  for (const pr of progs) {
    it(`${pr.label} renders WITHOUT being handed a bank`, () => {
      let code = pr.code
      if (pr.rondo) {
        const c = compile(code)
        expect(c.ok, 'does not compile').toBe(true)
        code = c.code!
      }
      const st = stageCode(code)
      expect(st.ok, 'does not stage').toBe(true)
      if (!st.ok) return
      const cps = st.cps ?? 0.5
      const evs = runPatterns(st.patterns, { cycles: 2, cps })
      // deliberately NO `samples` — that is the whole point
      const mix = renderMix(st.synths, evs, 2 / cps, mixOptsFor(st, { cps, sampleRate: SR }))
      let peak = 0
      for (const v of mix.left) peak = Math.max(peak, Math.abs(v))
      expect(peak, 'rendered silence — the sample bank never reached it').toBeGreaterThan(0.001)
    })
  }

  it('a caller-supplied sample SHADOWS the built-in of the same name', () => {
    /* The live bank behaves this way: load your own `vox` and it wins. An
     * offline render that ignored the override would bounce a different
     * instrument than the app played. */
    const code = `const v = synth(({ gate, adsr, sample }) =>
  sample(gate, 'vox', { root: 57 }).mul(adsr(gate, { a: 0.01, d: 0.5, s: 0.9, r: 0.2 })))
p('v', note('c3').sound('v'))
setCps(0.5)`
    const st = stageCode(code)
    expect(st.ok).toBe(true)
    if (!st.ok) return
    const evs = runPatterns(st.patterns, { cycles: 1, cps: 0.5 })
    const loud = new Float32Array(4096).fill(0.9)
    const theirs = renderMix(st.synths, evs, 2, { cps: 0.5, sampleRate: SR, samples: { vox: { data: loud, sampleRate: SR } } })
    const builtin = renderMix(st.synths, evs, 2, { cps: 0.5, sampleRate: SR })
    let a = 0, b = 0
    for (const v of theirs.left) a = Math.max(a, Math.abs(v))
    for (const v of builtin.left) b = Math.max(b, Math.abs(v))
    // both must SOUND, and they must sound DIFFERENT: which is louder is not
    // the point (a flat buffer through an envelope and root-57 resampling
    // measures 0.64 against the demo vox's 0.77), only that the name resolved
    // to the caller's audio instead of the built-in
    expect(b, 'the built-in vox did not render').toBeGreaterThan(0.001)
    expect(a, 'the override rendered silence').toBeGreaterThan(0.001)
    expect(Math.abs(a - b), 'the override was ignored').toBeGreaterThan(0.01)
  })
})
