import { describe, expect, it } from 'vitest'
import { collectSnippet, insertableSnippet, referencedSynths, synthBlocks } from '../src/editor/snippets'

/* A drum line is four words, and those words are synth NAMES:
 *
 *   beat
 *     kick ~ snare ~
 *
 * Saved on its own it pastes into a document that has never heard of `kick`
 * and makes no sound — the same as not having saved it. So a snippet carries
 * what it needs, and inserting one does not redefine what the target already
 * has.
 *
 * Both failures are silent and both change the music: a dropped dependency is
 * a part that does not play, and a duplicate `synth kick` is a redefinition
 * that alters the drums somewhere else in the file. */

const DOC = [
  'synth kick', // 0
  '  sine 60',
  '  * env',
  '  env = adsr .001 .2 0 .01',
  '',
  'synth snare', // 5
  '  noise',
  '  * env',
  '  env = adsr .001 .1 0 .05',
  '',
  'synth lead', // 10
  '  saw note',
  '',
  'beat drums', // 13
  '  kick ~ snare ~',
  '',
  'play lead', // 16
  '  c3 e3',
].join('\n')

describe('referencedSynths', () => {
  it("reads a beat body's bare words as the synth names they are", () => {
    expect(referencedSynths('beat drums\n  kick ~ snare ~\n', 'rondo').sort()).toEqual(['kick', 'snare'])
  })

  it('reads a play block\'s header, and its synth: override', () => {
    expect(referencedSynths('play lead\n  c3\n', 'rondo')).toEqual(['lead'])
    expect(referencedSynths('play pad synth:keys\n  c3\n', 'rondo')).toEqual(['keys'])
  })

  it('does not mistake a keyword or a modifier for a synth', () => {
    const code = 'beat drums\n  kick ~ snare ~\n  gain: .8\n  every 4: rev\n'
    expect(referencedSynths(code, 'rondo').sort()).toEqual(['kick', 'snare'])
  })

  it('does not take a NOTE for a synth in a play block', () => {
    // a play body is notation, not synth names — only a beat body is names
    expect(referencedSynths('play lead\n  c3 e3 g3\n', 'rondo')).toEqual(['lead'])
  })

  it('reads .sound() and s() in the JS DSL', () => {
    const code = "p('a', note('c3').sound('kick'))\np('b', s('snare*4'))"
    expect(referencedSynths(code, 'rondocode').sort()).toEqual(['kick', 'snare'])
  })

  it("takes the WORDS out of an s() pattern, not the string", () => {
    // s('bd sn hh') plays three synths; s('snare*4') plays one four times.
    // Taking the argument whole would look for a synth called "snare*4".
    expect(referencedSynths("p('x', s('bd sn hh'))", 'rondocode').sort()).toEqual(['bd', 'hh', 'sn'])
  })
})

describe('synthBlocks', () => {
  it('spans each synth from its header to the end of its body', () => {
    const blocks = synthBlocks(DOC, 'rondo')
    expect([...blocks.keys()]).toEqual(['kick', 'snare', 'lead'])
    expect(DOC.slice(blocks.get('kick')!.from, blocks.get('kick')!.to)).toBe(
      'synth kick\n  sine 60\n  * env\n  env = adsr .001 .2 0 .01',
    )
  })

  it('finds a top-level JS synth and not an indented one', () => {
    const js = "const kick = synth(({ sine }) => sine(60))\n  const inner = synth(() => 0)\n"
    expect([...synthBlocks(js, 'rondocode').keys()]).toEqual(['kick'])
  })
})

describe('collectSnippet — a snippet carries its synths', () => {
  it('brings the drum line AND the two synths it plays', () => {
    const sel = 'beat drums\n  kick ~ snare ~'
    const out = collectSnippet(DOC, sel, 'rondo')
    expect(out).toContain('synth kick')
    expect(out).toContain('synth snare')
    expect(out).toContain('kick ~ snare ~')
    expect(out, 'a synth it does not play must NOT come along').not.toContain('synth lead')
  })

  it('puts the definitions first, in document order', () => {
    const out = collectSnippet(DOC, 'beat drums\n  kick ~ snare ~', 'rondo')
    expect(out.indexOf('synth kick')).toBeLessThan(out.indexOf('synth snare'))
    expect(out.indexOf('synth snare')).toBeLessThan(out.indexOf('beat drums'))
  })

  it('brings nothing extra when the selection needs nothing', () => {
    expect(collectSnippet(DOC, 'synth lead\n  saw note', 'rondo')).toBe('synth lead\n  saw note')
  })

  it('does not duplicate a synth the selection already contains', () => {
    const sel = 'synth kick\n  sine 60\n  * env\n  env = adsr .001 .2 0 .01\n\nbeat\n  kick ~'
    const out = collectSnippet(DOC, sel, 'rondo')
    expect(out.match(/synth kick/g)).toHaveLength(1)
  })
})

describe('insertableSnippet — do not redefine what is already there', () => {
  const SNIP = 'synth kick\n  sine 60\n\nsynth snare\n  noise\n\nbeat drums\n  kick ~ snare ~'

  it('drops a synth the target already defines, and says which', () => {
    const target = 'synth kick\n  sine 40\n\nplay x\n  c3\n'
    const { text, skipped } = insertableSnippet(target, SNIP, 'rondo')
    expect(skipped).toEqual(['kick'])
    expect(text, "the target's own kick must survive untouched").not.toContain('sine 60')
    expect(text).toContain('synth snare')
    expect(text).toContain('beat drums')
  })

  it('drops several, keeping the part that is the point', () => {
    const target = 'synth kick\n  sine 40\n\nsynth snare\n  noise\n'
    const { text, skipped } = insertableSnippet(target, SNIP, 'rondo')
    expect(skipped).toEqual(['kick', 'snare'])
    expect(text.trim()).toBe('beat drums\n  kick ~ snare ~')
  })

  it('inserts the whole thing into an empty document', () => {
    expect(insertableSnippet('', SNIP, 'rondo')).toEqual({ text: SNIP, skipped: [] })
  })

  it('leaves no run of blank lines behind what it removed', () => {
    const { text } = insertableSnippet('synth kick\n  sine 40\n', SNIP, 'rondo')
    expect(text).not.toMatch(/\n{3}/)
  })
})

/* THE POINT, END TO END. A drum line saved from one document and inserted
 * into an empty one has to actually PLAY there — which is the whole claim,
 * and the one a text-level test could otherwise agree with while the music
 * stayed silent. */
describe('a saved drum line plays in a document that never heard of it', async () => {
  const { compile } = await import('@rondocode/rondo')
  const { stageCode, runPatterns, renderMix } = await import('../../server/src/render-runner')

  const SOURCE = [
    'synth kick',
    '  sine 60',
    '  * env',
    '  env = adsr .001 .2 0 .01',
    '',
    'synth snare',
    '  noise',
    '  * env',
    '  env = adsr .001 .1 0 .05',
    '',
    'beat drums',
    '  kick ~ snare ~',
    '',
    'bpm 120',
  ].join('\n')

  /** Onsets scheduled AND the audio that came out. Both, because they
   *  disagree in exactly the case this feature exists for. */
  const play = (rondo: string): { onsets: number; rms: number } => {
    const c = compile(rondo)
    if (!c.ok) throw new Error(JSON.stringify(c.errors))
    const st = stageCode(c.code)
    if (!st.ok) throw new Error(st.diagnostics[0]!.message)
    const evs = runPatterns(st.patterns, { cycles: 2, cps: 0.5 })
    const onsets = [...evs.values()].flat().filter((e) => e.type === 'noteOn').length
    const mix = renderMix(st.synths, evs, 4, { cps: 0.5 })
    let sum = 0
    for (const v of mix.left) sum += v * v
    return { onsets, rms: Math.sqrt(sum / mix.left.length) }
  }

  it('carries its synths, and MAKES SOUND in the new document', () => {
    const saved = collectSnippet(SOURCE, 'beat drums\n  kick ~ snare ~', 'rondo')
    const { text } = insertableSnippet('', saved, 'rondo')
    const got = play(`${text}\n\nbpm 120\n`)
    expect(got.rms, 'the drum line must actually sound').toBeGreaterThan(0.01)
    expect(got.onsets).toBe(play(SOURCE).onsets)
  })

  it('WITHOUT them it schedules the same notes and renders DIGITAL SILENCE', () => {
    // the failure this exists to prevent, and it is silent twice over: the
    // notes are scheduled, nothing errors, and no sound comes out
    const bare = play('beat drums\n  kick ~ snare ~\n\nbpm 120\n')
    expect(bare.onsets, 'the notes are still scheduled').toBeGreaterThan(0)
    expect(bare.rms, 'and none of them make a sound').toBe(0)
  })

  it('keeps the target\'s own synth when it already has one, and still plays', () => {
    const target = 'synth kick\n  sine 40\n\nbpm 120\n'
    const saved = collectSnippet(SOURCE, 'beat drums\n  kick ~ snare ~', 'rondo')
    const { text, skipped } = insertableSnippet(target, saved, 'rondo')
    expect(skipped).toEqual(['kick'])
    const merged = `synth kick\n  sine 40\n\n${text}\n\nbpm 120\n`
    expect(merged).toContain('sine 40')
    expect(merged, "the snippet's kick must not have replaced it").not.toContain('sine 60')
    expect(play(merged).rms).toBeGreaterThan(0.01)
  })
})
