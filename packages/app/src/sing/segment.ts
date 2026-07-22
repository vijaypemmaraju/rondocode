/* ------------------------------------------------------------------------- *
 * Forced-alignment syllable segmentation. Replaces the audio-only vowel-peak
 * guesser: G2P the lyrics (g2p.ts) → CTC forced-align the KNOWN phoneme sequence
 * to the sung phrase (forcedalign.ts) → group phonemes into the KNOWN number of
 * syllables per word → cut onset/vowel/coda per syllable for the guide assembler.
 * Because the phoneme sequence is known and the alignment is constrained to it,
 * no syllable can be dropped or duplicated.
 * ------------------------------------------------------------------------- */
import { emissions, ipaToTokens } from './phonemes'
import { phonemizeWords } from './g2p'
import { forcedAlign } from './forcedalign'
import type { Seg } from './warp'

/** A lyric word + how many melody notes (syllables) it must fill. */
export interface WordReq {
  text: string
  syllableCount: number
}

interface Nucleus {
  vs: number
  ve: number
}

/** Segment a spoken phrase into one Seg per syllable, in order, using forced
 *  alignment of the lyrics' phonemes. `words` are the phrase's lyric words with
 *  their syllable (note) counts; the total must equal the phrase's note count. */
export async function alignedSegments(spoken: Float32Array, sr: number, words: WordReq[]): Promise<Seg[]> {
  const em = await emissions(spoken, sr)
  return segmentWithEmissions(spoken, sr, words, em)
}

/** The pure part of alignedSegments — takes a pre-computed emission matrix so it
 *  can be unit-tested without the ONNX session. */
export async function segmentWithEmissions(
  spoken: Float32Array,
  sr: number,
  words: WordReq[],
  em: { logits: Float32Array; T: number; V: number; fps: number },
): Promise<Seg[]> {
  // 1. phoneme tokens per word (single lyric word → one IPA string)
  const perWord: { req: WordReq; toks: { id: number; vowel: boolean }[]; from: number }[] = []
  const ids: number[] = []
  for (const req of words) {
    const ipa = (await phonemizeWords(req.text)).join(' ')
    const toks = ipaToTokens(ipa)
    perWord.push({ req, toks, from: ids.length })
    for (const t of toks) ids.push(t.id)
  }

  // 2. forced alignment (frame spans per token, in order of `ids`)
  const { logits, T, V, fps } = em
  const spans = forcedAlign(logits, T, V, ids)
  const totalDur = spoken.length / sr

  // 3. per word, collect vowel spans (seconds) and reconcile to syllableCount
  const nuclei: Nucleus[] = []
  for (const pw of perWord) {
    let groups: Nucleus[] = []
    for (let i = 0; i < pw.toks.length; i++) {
      if (pw.toks[i]!.vowel) {
        const sp = spans[pw.from + i]!
        groups.push({ vs: sp.start / fps, ve: sp.end / fps })
      }
    }
    if (groups.length === 0) {
      // no vowel detected — fall back to the word's whole token span
      const a = spans[pw.from]!.start / fps
      const b = spans[pw.from + pw.toks.length - 1]!.end / fps
      groups = [{ vs: a, ve: Math.max(a + 1e-3, b) }]
    }
    // too many vowels for the syllable count (diphthong split, e.g. "diamond"):
    // merge the closest-in-time adjacent pair until counts match.
    while (groups.length > pw.req.syllableCount && groups.length > 1) {
      let bi = 0
      let bg = Infinity
      for (let i = 0; i + 1 < groups.length; i++) {
        const gap = groups[i + 1]!.vs - groups[i]!.ve
        if (gap < bg) { bg = gap; bi = i }
      }
      groups[bi] = { vs: groups[bi]!.vs, ve: groups[bi + 1]!.ve }
      groups.splice(bi + 1, 1)
    }
    // too few (syllabic consonant the model didn't voice): split the widest.
    while (groups.length < pw.req.syllableCount) {
      let bi = 0
      let bw = -1
      for (let i = 0; i < groups.length; i++) {
        const w = groups[i]!.ve - groups[i]!.vs
        if (w > bw) { bw = w; bi = i }
      }
      const g = groups[bi]!
      const mid = (g.vs + g.ve) / 2
      groups.splice(bi, 1, { vs: g.vs, ve: mid }, { vs: mid, ve: g.ve })
    }
    for (const g of groups) nuclei.push(g)
  }

  // 4. syllable regions: consonants split at the temporal midpoint between
  //    consecutive vowels; onset=[s,vs], vowel=[vs,ve], coda=[ve,e].
  const N = nuclei.length
  const bound = new Array<number>(N + 1)
  bound[0] = 0
  bound[N] = totalDur
  for (let j = 1; j < N; j++) bound[j] = (nuclei[j - 1]!.ve + nuclei[j]!.vs) / 2
  const clampSamp = (t: number): number => Math.max(0, Math.min(spoken.length, Math.floor(t * sr)))
  const segs: Seg[] = []
  for (let j = 0; j < N; j++) {
    const s = clampSamp(bound[j]!)
    const e = Math.max(s, clampSamp(bound[j + 1]!))
    const vs = Math.max(s, Math.min(e, clampSamp(nuclei[j]!.vs)))
    const ve = Math.max(vs, Math.min(e, clampSamp(nuclei[j]!.ve)))
    segs.push({
      onset: spoken.subarray(s, vs),
      vowel: new Float32Array(spoken.subarray(vs, ve)),
      coda: spoken.subarray(ve, e),
    })
  }
  return segs
}
