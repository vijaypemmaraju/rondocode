/**
 * Bjorklund's algorithm: distribute `pulses` onsets as evenly as possible
 * across `steps` slots (Toussaint, "The Euclidean Algorithm Generates
 * Traditional Musical Rhythms").
 *
 * The recursion pairs the shorter group list under the longer one — exactly
 * the subtraction steps of Euclid's gcd — and terminates as soon as the
 * remainder is a single group, BEFORE any pairing when steps - pulses <= 1.
 * This matches Strudel's and Tidal's _bjorklund output exactly (the project
 * parity bar: ported patterns must hear the same rhythm). Note the E(n-1, n)
 * family therefore differs from Toussaint's canonical rotations: E(2,3) is
 * [x x .] here (Toussaint lists [x . x]). All other (pulses, steps) <= 16
 * agree with the paper. Pinned in euclid.test.ts.
 *
 * Pure function: no state, no randomness.
 *
 * @param pulses onset count; <= 0 yields all rests, >= steps all onsets
 * @param steps  slot count; must be a positive integer
 * @returns `steps` booleans, true = onset (always starting with an onset
 *          when pulses > 0)
 */
export function bjorklund(pulses: number, steps: number): boolean[] {
  if (!Number.isInteger(pulses) || !Number.isInteger(steps)) {
    throw new TypeError(`bjorklund requires integers, got E(${pulses},${steps})`)
  }
  if (steps < 1) {
    throw new RangeError(`bjorklund requires steps >= 1, got ${steps}`)
  }
  if (pulses <= 0) return new Array<boolean>(steps).fill(false)
  if (pulses >= steps) return new Array<boolean>(steps).fill(true)

  let a: boolean[][] = Array.from({ length: pulses }, () => [true])
  let b: boolean[][] = Array.from({ length: steps - pulses }, () => [false])
  while (b.length > 1) {
    const n = Math.min(a.length, b.length)
    const paired: boolean[][] = []
    for (let i = 0; i < n; i++) paired.push([...a[i]!, ...b[i]!])
    const rest = a.length > b.length ? a.slice(n) : b.slice(n)
    a = paired
    b = rest
  }
  return [...a, ...b].flat()
}
