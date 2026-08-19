import { describe, expect, it } from 'vitest'
import { compile } from '@rondocode/rondo'
import { stageCode, runPatterns, renderMix, mixOptsFor } from '../../server/src/render-runner'
import { RECIPES } from '../src/docs/cookbook'
import { EXAMPLES } from '../src/examples'

/* ------------------------------------------------------------------------- *
 * A SPACE belongs to the mix, not to each voice.
 *
 * Reported by a user whose audio cut in and out. The program was the shipped
 * `real-room` recipe, copied verbatim, and its `convolve` sat on a spine line
 * -- so the convolver was rebuilt per VOICE, and the recipe plays four-note
 * chords. Measured: 3.1x the render cost for a sample-for-sample identical
 * result, because convolution is linear and convolving the sum is the same as
 * summing the convolutions.
 *
 * Three shipped programs had the same shape, one of them at `voices:12`.
 * ------------------------------------------------------------------------- */

interface GraphLike { nodes?: { type: string }[] }

/** Effect types that are a SHARED SPACE: one instance belongs to the mix. */
const SPACES = ['convolve', 'reverb']

const voiceSpaces = (js: string): { synth: string; types: string[] }[] => {
  let st
  try { st = stageCode(js) } catch { return [] }
  if (!st.ok) return []
  const out: { synth: string; types: string[] }[] = []
  for (const [name, def] of st.synths as Map<string, { graph?: GraphLike }>) {
    const types = (def.graph?.nodes ?? []).filter((n) => SPACES.includes(n.type)).map((n) => n.type)
    if (types.length > 0) out.push({ synth: String(name), types })
  }
  return out
}

describe('no shipped program puts a space inside a voice', () => {
  it('not in the cookbook', () => {
    const bad: string[] = []
    for (const r of RECIPES) {
      const c = compile(r.code)
      if (!c.ok) continue
      for (const v of voiceSpaces(c.code)) bad.push(`${r.id}/${v.synth}: ${v.types.join(',')}`)
    }
    expect(bad, 'put it in `post`: one shared space, a third of the cost, same sound').toEqual([])
  })

  it('and not in the examples', () => {
    const bad: string[] = []
    for (const e of EXAMPLES) for (const v of voiceSpaces(e.code)) bad.push(`${e.name}/${v.synth}: ${v.types.join(',')}`)
    expect(bad).toEqual([])
  })
})

describe('why the move is free', () => {
  /* The claim the fix rests on. If it were ever false, moving these would have
   * changed the sound of three shipped programs, so it is asserted rather than
   * believed: these effects are LINEAR, and the mix is a sum. */
  const mk = (fx: string, where: 'voice' | 'post'): string => `synth keys
  (saw note) * .5
  svf 2400 res:.15
  * adsr .01 .25 .5 .35
${where === 'voice' ? `  ${fx}` : `  post\n    ${fx}`}

play keys
  <Cmaj7 Am7 Fmaj7 G>
  dur: .95

cps .4`

  /* SHORT and at a low rate: this asserts an algebraic identity, not a
   * musical result, and a convolution render is expensive enough that six
   * seconds at 22050 timed out on CI at five seconds. Two at 11025 catches any
   * real difference just as well. */
  const render = (code: string): Float32Array => {
    const c = compile(code)
    expect(c.ok, c.ok ? '' : JSON.stringify(c.errors)).toBe(true)
    if (!c.ok) throw new Error('compile')
    const st = stageCode(c.code)
    if (!st.ok) throw new Error(JSON.stringify(st.diagnostics))
    const cps = st.cps ?? 0.5
    const evs = runPatterns(st.patterns, { cycles: Math.ceil(2 * cps), cps })
    return renderMix(st.synths, evs, 2, mixOptsFor(st, { cps, sampleRate: 11025 })).left
  }

  for (const fx of ['convolve hall mix:.45', 'reverb room:.8 mix:.45']) {
    it(`${fx.split(' ')[0]} sounds the same in post as in the voice`, () => {
      const v = render(mk(fx, 'voice'))
      const p = render(mk(fx, 'post'))
      expect(p.length).toBe(v.length)
      let maxd = 0
      for (let i = 0; i < v.length; i++) maxd = Math.max(maxd, Math.abs(v[i]! - p[i]!))
      expect(maxd, `moving it changed the sound by ${maxd}`).toBeLessThan(1e-4)
    })
  }

  /* The 3.1x cost difference is NOT asserted here. It is a benchmark, and a
   * benchmark in a correctness suite is a flake generator on a shared runner
   * -- these two tests already timed out on CI at six seconds of audio. The
   * number is measured and recorded where it belongs: in the recipe's own
   * comment, next to the code it justifies. */
})
