import { hap } from './types'
import { Pattern, reify } from './pattern'
import { saw, isaw } from './signal'

/**
 * The song-arrangement layer: sequence whole sections (intro / build / drop)
 * over cycle ranges, and named ramp signals for the transitions between them.
 *
 * `arrange` is slowcat's structural cousin — where {@link Pattern.cat} gives
 * one cycle to each argument, arrange gives each section a fixed RANGE of
 * cycles, then loops the whole song. `rise`/`fall` are discoverable,
 * self-documenting wrappers over saw/isaw for build-ups and downlifters.
 */

/**
 * Sequence sections over cycle ranges, looping the whole song.
 *
 * Each argument is `[cycleCount, pattern]`: section 0 plays for its
 * `cycleCount` cycles, then section 1, and so on. After the last section the
 * arrangement LOOPS, repeating every `total = Σ cycleCounts` cycles.
 *
 * Within a section's window the section plays its OWN cycles starting from 0,
 * and it restarts at cycle 0 every time the loop returns to it — so a
 * section's local cycle is `(globalCycle mod total) − sectionOffset`. A
 * multi-cycle section (e.g. a `cat`) therefore advances one inner cycle per
 * cycle of its window and resets on the next loop. A section's within-cycle
 * structure (a `fastcat`, a signal) is preserved untouched.
 *
 * Bare values auto-reify: `arrange([1, 'a'], [1, 'b'])` means
 * `arrange([1, pure('a')], [1, pure('b')])`.
 *
 * @example
 * // 4 cycles of intro, 8 of build, 16 of drop, then loop (28-cycle song)
 * arrange([4, intro], [8, build], [16, drop])
 *
 * @throws Error if given no sections, or if any `cycleCount` is not a
 * positive integer.
 */
export function arrange<T>(...sections: [number, Pattern<T> | T][]): Pattern<T> {
  if (sections.length === 0) {
    throw new Error('arrange requires at least one section')
  }
  const parts = sections.map(([count, pat], i) => {
    if (!Number.isInteger(count) || count < 1) {
      throw new Error(
        `arrange section ${i}: cycleCount must be a positive integer, got ${count}`,
      )
    }
    return { count, pat: reify(pat) }
  })
  const total = parts.reduce((sum, p) => sum + p.count, 0)

  return new Pattern<T>((span) => {
    // splitQueries guarantees the span sits within one cycle, so the whole
    // query maps to a single section.
    const cycle = span.begin.sam()
    // Euclidean mod keeps pre-zero cycles on the grid (see Fraction.mod).
    const loopPos = cycle.mod(total)
    const lp = loopPos.valueOf() // integer in [0, total)
    let offset = 0
    let chosen = parts[0]!
    for (const p of parts) {
      if (lp < offset + p.count) {
        chosen = p
        break
      }
      offset += p.count
    }
    // Shift the section's timeline so its local cycle
    //   (loopPos − offset) lands on the global cycle we are querying —
    // exactly cat's per-cycle shift, generalized to fixed-width windows.
    const localCycle = loopPos.sub(offset)
    const shift = cycle.sub(localCycle)
    const shifted = span.withTime((t) => t.sub(shift))
    return chosen.pat
      .query(shifted)
      .map((h) =>
        hap(
          h.whole?.withTime((t) => t.add(shift)),
          h.part.withTime((t) => t.add(shift)),
          h.value,
        ),
      )
  }).splitQueries()
}

/**
 * A rising 0→1 ramp spread over `cycles` cycles (`saw.slow(cycles)`) — a
 * build-up. Aim it at real units with `.range()`: sweep a filter open, swell
 * a volume, over the run of a build section.
 *
 * @example
 * // open the filter from 200 Hz to 8 kHz across a 16-bar build
 * build.ctrl('cutoff', rise(16).range(200, 8000))
 */
export const rise = (cycles = 8): Pattern<number> => saw.slow(cycles)

/**
 * A falling 1→0 ramp spread over `cycles` cycles (`isaw.slow(cycles)`) — a
 * downlifter: the mirror of {@link rise}, for filters closing or levels
 * draining out into a breakdown.
 *
 * @example
 * // close the filter from 8 kHz to 200 Hz across an 8-bar fall
 * outro.ctrl('cutoff', fall(8).range(200, 8000))
 */
export const fall = (cycles = 8): Pattern<number> => isaw.slow(cycles)
