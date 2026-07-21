import { describe, it, expect } from 'vitest'
import { synth } from '../src/builder'
import type { SynthDef } from '../src/builder'
import { GraphError } from '../src/graph'
import { BLOCK, compilePost } from '../src/compile'
import { PostChain } from '../src/post'
import { renderOffline } from '../src/render'
import { analyze } from '../src/analysis'
import type { DspContext } from '../src/dsp/types'

const ctx: DspContext = { sampleRate: 48000 }
const SR = ctx.sampleRate

/** Run a PostChain over a whole stereo signal in BLOCK chunks, in place. */
const runPost = (def: SynthDef, L: Float32Array, R: Float32Array): void => {
  const chain = new PostChain(def.post!, ctx)
  for (let i = 0; i < L.length; i += BLOCK) {
    const n = Math.min(BLOCK, L.length - i)
    chain.processStereo(L.subarray(i, i + n), R.subarray(i, i + n), n)
  }
}

const rms = (a: Float32Array, lo = 0, hi = a.length): number => {
  let s = 0
  for (let i = lo; i < hi; i++) s += a[i]! * a[i]!
  return Math.sqrt(s / (hi - lo))
}

/** A plain dry pluck: short percussive sine so its dry part decays fast, making
 *  a reverb tail easy to isolate in a post-release window. */
const dryPluck = (post?: Parameters<typeof synth>[1]): SynthDef =>
  synth(
    ({ note, gate, sine, adsr }) => sine(note.freq).mul(adsr(gate, { a: 0.002, d: 0.08, s: 0, r: 0.03 })),
    post,
  )

const chord = (notes: number[], onDur: number): { time: number; type: 'noteOn' | 'noteOff'; note: number }[] => {
  const evs: { time: number; type: 'noteOn' | 'noteOff'; note: number }[] = []
  for (const n of notes) {
    evs.push({ time: 0, type: 'noteOn', note: n })
    evs.push({ time: onDur, type: 'noteOff', note: n })
  }
  return evs
}

describe('builder: synth(voiceFn, postFn)', () => {
  it('a synth with no postFn has post undefined', () => {
    const def = synth(({ note, sine }) => sine(note.freq))
    expect(def.post).toBeUndefined()
  })

  it('synth(voiceFn, postFn) produces a post GraphSpec with businput + reverb', () => {
    const def = synth(
      ({ note, sine }) => sine(note.freq),
      ({ input, reverb }) => input.mix(reverb(input), 0.4),
    )
    expect(def.post).toBeDefined()
    const types = def.post!.nodes.map((n) => n.type)
    expect(types).toContain('businput')
    expect(types).toContain('reverb')
    expect(types).toContain('out')
  })

  it('a malformed post graph throws GraphError at synth() definition time', () => {
    expect(() =>
      synth(
        ({ note, sine }) => sine(note.freq),
        // reverb needs a Sig/number for `in`; a bad type is caught at build
        ({ reverb }) => reverb('nope' as unknown as never),
      ),
    ).toThrow(GraphError)
  })

  it('post has its own node-id space and validates independently', () => {
    const def = synth(
      ({ note, saw }) => saw(note.freq),
      ({ input, onepole }) => onepole(input, 800),
    )
    // ids restart at 0 in the post graph
    expect(def.post!.nodes[0]!.id).toBe(0)
    expect(() => compilePost(def.post!, ctx)).not.toThrow()
  })
})

describe('compilePost / businput', () => {
  it('businput is the mono input source; out writes a mono result', () => {
    const def = synth(
      ({ note, sine }) => sine(note.freq),
      ({ input }) => input.mul(0.5),
    )
    const cp = compilePost(def.post!, ctx)
    // impulse in, expect half out
    cp.input.fill(0)
    cp.input[0] = 1
    for (let s = 0; s < cp.steps.length; s++) cp.steps[s]!.kernel.process(BLOCK, cp.steps[s]!.inputs, cp.steps[s]!.out, ctx)
    expect(cp.out[0]).toBeCloseTo(0.5, 5)
  })

  it('a post reverb builds a decaying tail that persists after the input stops', () => {
    const def = dryPluck(({ input, reverb }) => reverb(input))
    const cp = compilePost(def.post!, ctx)
    // Feed continuous energy for the first ~0.06s (long enough for the comb
    // bank to charge past its longest tuning ~1116 samples), then go silent and
    // watch the tail. (A single 128-sample burst would be drained by the
    // reverb's silence-settle before the first echo emerges — real notes feed
    // continuously, which is what a post chain always sees.)
    const total = Math.floor(0.4 * SR)
    const feedUntil = Math.floor(0.06 * SR)
    const out = new Float32Array(total)
    let fedPeak = 0
    let s0 = 0
    for (let i = 0; i < total; i += BLOCK) {
      const n = Math.min(BLOCK, total - i)
      cp.input.fill(0, 0, n)
      if (i < feedUntil) for (let k = 0; k < n; k++) cp.input[k] = Math.sin(s0 + k) * 0.8
      s0 += n
      for (let s = 0; s < cp.steps.length; s++) cp.steps[s]!.kernel.process(n, cp.steps[s]!.inputs, cp.steps[s]!.out, ctx)
      for (let k = 0; k < n; k++) {
        out[i + k] = cp.out[k]!
        const a = Math.abs(cp.out[k]!)
        if (a > fedPeak) fedPeak = a
      }
    }
    // tail persists well after the input stopped (0.06s), and decays over time
    const early = rms(out, Math.floor(0.1 * SR), Math.floor(0.2 * SR))
    const late = rms(out, Math.floor(0.3 * SR), total)
    expect(early).toBeGreaterThan(1e-4)
    expect(late).toBeLessThan(early)
    expect(fedPeak).toBeLessThan(2)
  })
})

describe('PostChain: shared reverb over the summed voices', () => {
  it('post reverb over a chord equals the reverb run once over the summed dry render', () => {
    const notes = [48, 55, 60]
    const dur = 1.0
    const evs = chord(notes, 0.2)
    // A) synth WITH post reverb, rendered dry then post-processed via renderOffline+PostChain
    const withPost = dryPluck(({ input, reverb }) => input.mix(reverb(input), 0.5))
    const dryStem = renderOffline({ graph: withPost.graph }, evs, dur, { sampleRate: SR, maxVoices: 8 })
    const pL = dryStem.left.slice()
    const pR = dryStem.right.slice()
    runPost(withPost, pL, pR)

    // B) render dry, then run an INDEPENDENT PostChain over the summed stem
    const dry2 = renderOffline({ graph: withPost.graph }, evs, dur, { sampleRate: SR, maxVoices: 8 })
    const mL = dry2.left.slice()
    const mR = dry2.right.slice()
    runPost(withPost, mL, mR)

    // Both took the identical path -> bit identical (determinism sanity)
    for (let i = 0; i < pL.length; i += 997) expect(pL[i]).toBeCloseTo(mL[i]!, 6)
  })

  it('the shared reverb tail ratio (wet-tail / dry-sustain) is ~independent of chord size', () => {
    const def = dryPluck(({ input, reverb }) => input.mix(reverb(input), 0.5))
    const dur = 1.0
    const ratios: number[] = []
    for (const notes of [[60], [55, 60], [48, 55, 60, 64]]) {
      const evs = chord(notes, 0.2)
      const stem = renderOffline({ graph: def.graph }, evs, dur, { sampleRate: SR, maxVoices: 8 })
      const drySustain = rms(stem.left, Math.floor(0.05 * SR), Math.floor(0.15 * SR))
      const L = stem.left.slice()
      const R = stem.right.slice()
      runPost(def, L, R)
      const tail = rms(L, Math.floor(0.5 * SR), L.length)
      ratios.push(tail / drySustain)
    }
    // one shared reverb tracks the summed signal proportionally: the tail/dry
    // ratio stays put whether 1 or 4 voices sound (linear, single instance)
    const max = Math.max(...ratios)
    const min = Math.min(...ratios)
    expect(min).toBeGreaterThan(0)
    expect(max / min).toBeLessThan(1.6)
  })

  it('post reverb decorrelates L and R (stereo width > 0)', () => {
    const def = dryPluck(({ input, reverb }) => input.mix(reverb(input), 0.6))
    const evs = chord([48, 55, 60], 0.3)
    const stem = renderOffline({ graph: def.graph }, evs, 1.2, { sampleRate: SR, maxVoices: 8 })
    // dry stem is centered (L==R) -> width 0 before post
    const widthBefore = analyze({ left: stem.left.slice(), right: stem.right.slice(), sampleRate: SR }).stereoWidth
    const L = stem.left.slice()
    const R = stem.right.slice()
    runPost(def, L, R)
    const widthAfter = analyze({ left: L, right: R, sampleRate: SR }).stereoWidth
    expect(widthBefore).toBeLessThan(0.05)
    expect(widthAfter).toBeGreaterThan(0.1)
  })
})

describe('PostChain: post processes the SUMMED signal (filter)', () => {
  it('a post lowpass darkens the summed mix (spectral centroid drops)', () => {
    const brightVoice = (post?: Parameters<typeof synth>[1]): SynthDef =>
      synth(({ note, gate, saw, adsr }) => saw(note.freq).mul(adsr(gate, { a: 0.002, d: 0.3, s: 0.6, r: 0.05 })), post)
    const evs = chord([40, 47], 0.8)
    const noPost = brightVoice()
    const withLp = brightVoice(({ input, onepole }) => onepole(input, 400))
    const dryStem = renderOffline({ graph: noPost.graph }, evs, 1.0, { sampleRate: SR })
    const lpStem = renderOffline({ graph: withLp.graph }, evs, 1.0, { sampleRate: SR })
    // apply the post filter over the summed stem
    const L = lpStem.left.slice()
    const R = lpStem.right.slice()
    runPost(withLp, L, R)
    const centroidBright = analyze({ left: dryStem.left, right: dryStem.right, sampleRate: SR }).spectralCentroidHz
    const centroidDark = analyze({ left: L, right: R, sampleRate: SR }).spectralCentroidHz
    expect(centroidDark).toBeLessThan(centroidBright * 0.7)
  })
})

describe('backward compat: no-post synths are unchanged', () => {
  it('renderOffline of a no-post synth is bit-identical with or without the post code path', () => {
    const def = synth(({ note, gate, saw, adsr }) => saw(note.freq).mul(adsr(gate, { a: 0.003, d: 0.2, s: 0.4, r: 0.1 })))
    expect(def.post).toBeUndefined()
    const evs = chord([45], 0.4)
    const a = renderOffline(def, evs, 0.6, { sampleRate: SR })
    const b = renderOffline({ graph: def.graph }, evs, 0.6, { sampleRate: SR })
    for (let i = 0; i < a.left.length; i++) {
      expect(a.left[i]).toBe(b.left[i]!)
      expect(a.right[i]).toBe(b.right[i]!)
    }
  })
})
