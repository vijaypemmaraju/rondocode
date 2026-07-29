import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { stageCode, runPatterns, renderMix } from '../../server/src/render-runner'

/* Every preset in the synth library must EVAL and SOUND.
 *
 * These are the first thing a new user clicks, and a broken one is invisible
 * until someone tries it: the panel inserts the code and the track goes quiet.
 * Three of the six added here were wrong on the first attempt — a post chain
 * takes one ctx object rather than (input, ctx), width() takes its amount
 * positionally, and granular() takes the sample NAME as its second argument,
 * not a key in opts. None of that is caught by a typecheck of this file, since
 * the presets are strings. */

const src = readFileSync(join(__dirname, '../src/editor/synthlib.ts'), 'utf8')
const presets = [...src.matchAll(/name: '([a-z]+)',[\s\S]*?code: `([\s\S]*?)`,\n\s+demoTail: `([\s\S]*?)`,/g)]
  .map((m) => ({ name: m[1]!, code: m[2]!, tail: m[3]! }))

/** The demo samples the preview player loads, so a sampler preset is not
 *  silent for the wrong reason. */
const demoSamples = (sr: number) => {
  const pcm = new Float32Array(sr)
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin((2 * Math.PI * 220 * i) / sr) * 0.5
  return { pad: { data: pcm, sampleRate: sr }, vox: { data: pcm, sampleRate: sr }, break: { data: pcm, sampleRate: sr } }
}

const unescape = (s: string): string => s.replace(/\\n/g, '\n').replace(/\\`/g, '`').replace(/\\\$\{/g, '${')

describe('the synth library', () => {
  it('found the presets to test (guards against the regex silently matching none)', () => {
    expect(presets.length).toBeGreaterThanOrEqual(18)
  })

  it.each(presets.map((p) => [p.name, p] as const))('%s evaluates and makes sound', (_name, p) => {
    const program = `${unescape(p.code)}\n${unescape(p.tail)}`
    const staged = stageCode(program)
    const errs = staged.ok ? [] : staged.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message)
    expect(errs, errs.join('; ')).toEqual([])
    if (!staged.ok) return

    const cps = staged.cps ?? 0.5
    const sr = 22050
    const events = runPatterns(staged.patterns, { cycles: 2, cps })
    expect([...events.values()].flat().length, 'demo produced no events').toBeGreaterThan(0)
    const mix = renderMix(staged.synths, events, 2 / cps, { cps, sampleRate: sr, samples: demoSamples(sr) })
    let peak = 0
    for (const v of mix.left) { const a = Math.abs(v); if (a > peak) peak = a }
    expect(peak, 'rendered silence').toBeGreaterThan(0.001)
    for (const v of mix.left) expect(Number.isFinite(v)).toBe(true)
  })

  it('every preset inserts a synth whose name matches its entry', () => {
    // the panel inserts `code` at the cursor; a mismatched const name would
    // leave the demo's .sound() pointing at nothing
    for (const p of presets) {
      expect(unescape(p.code), p.name).toMatch(new RegExp(`const ${p.name}\\s*=\\s*synth\\(`))
    }
  })
})
