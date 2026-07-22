/* ------------------------------------------------------------------------- *
 * CTC forced alignment. Given a frame×vocab emission matrix (log-probs from the
 * wav2vec2 phoneme model) and a KNOWN target token sequence (the lyrics' eSpeak
 * phonemes, from g2p.ts), find the most likely monotonic alignment via Viterbi
 * over the standard blank-interleaved CTC trellis. Because the path is CONSTRAINED
 * to the target sequence, it can never drop or duplicate a phoneme the way greedy
 * decoding / energy peak-picking does — every target phoneme gets a frame span.
 * ------------------------------------------------------------------------- */

/** Frame span [start,end) for each target token, in frames. */
export interface TokenSpan {
  /** index into the target token array */
  tok: number
  start: number
  end: number
}

/** Viterbi-align `tokens` to `logProbs` (row-major [T,V]); `blank` is the CTC
 *  blank id (0 here). Returns one [start,end) frame span per target token. */
export function forcedAlign(logProbs: Float32Array, T: number, V: number, tokens: number[], blank = 0): TokenSpan[] {
  const N = tokens.length
  if (N === 0 || T === 0) return []
  const S = 2 * N + 1
  // extended sequence: blank, t0, blank, t1, ... , blank
  const ext = new Int32Array(S)
  for (let s = 0; s < S; s++) ext[s] = s % 2 === 0 ? blank : tokens[(s - 1) >> 1]!
  const NEG = -1e30
  const emit = (t: number, v: number): number => logProbs[t * V + v]!

  let prev = new Float64Array(S).fill(NEG)
  prev[0] = emit(0, ext[0]!)
  if (S > 1) prev[1] = emit(0, ext[1]!)
  // backpointer per frame per state: how far back we stepped (0,1,2)
  const bp = new Uint8Array(T * S)
  for (let t = 1; t < T; t++) {
    const cur = new Float64Array(S).fill(NEG)
    for (let s = 0; s < S; s++) {
      let best = prev[s]!
      let arg = 0
      if (s >= 1 && prev[s - 1]! > best) { best = prev[s - 1]!; arg = 1 }
      // skip the intervening blank only when the two tokens differ
      if (s >= 2 && ext[s] !== blank && ext[s] !== ext[s - 2] && prev[s - 2]! > best) { best = prev[s - 2]!; arg = 2 }
      if (best <= NEG) continue
      cur[s] = best + emit(t, ext[s]!)
      bp[t * S + s] = arg
    }
    prev = cur
  }
  // terminate in the last real token or the trailing blank, whichever is better
  let s = prev[S - 1]! >= prev[S - 2]! ? S - 1 : S - 2
  const path = new Int32Array(T)
  for (let t = T - 1; t >= 0; t--) {
    path[t] = s
    if (t > 0) s -= bp[t * S + s]!
  }
  const spans: TokenSpan[] = []
  for (let n = 0; n < N; n++) {
    const sp = 2 * n + 1
    let start = -1
    let end = -1
    for (let t = 0; t < T; t++) {
      if (path[t] === sp) { if (start < 0) start = t; end = t }
    }
    spans.push({ tok: n, start, end: end + 1 })
  }
  // any token that never won a frame (only if T≈N): give it a zero-width slot at
  // the previous token's end so downstream stays monotonic.
  for (let n = 0; n < N; n++) {
    if (spans[n]!.start < 0) {
      const at = n > 0 ? spans[n - 1]!.end : 0
      spans[n] = { tok: n, start: at, end: at }
    }
  }
  return spans
}
