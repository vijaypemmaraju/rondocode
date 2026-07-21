/** Power of `signal` at `freqHz` via the Goertzel algorithm, divided by
 *  signal length. Note: per-N normalization makes broadband (noise) power
 *  comparable across window lengths, but NOT pure-tone power (a coherent tone
 *  accumulates as N^2, so a tone's normalized value still grows with N). All
 *  current tests compare equal-length windows, where either reading is fine. */
export const goertzel = (signal: Float32Array, freqHz: number, sampleRate: number): number => {
  const w = (2 * Math.PI * freqHz) / sampleRate
  const coeff = 2 * Math.cos(w)
  let s1 = 0
  let s2 = 0
  for (let i = 0; i < signal.length; i++) {
    const s0 = signal[i]! + coeff * s1 - s2
    s2 = s1
    s1 = s0
  }
  return (s1 * s1 + s2 * s2 - coeff * s1 * s2) / signal.length
}
