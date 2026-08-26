/* The ONE rule for a live transport marker.
 *
 * Both clock-riding widgets (the LFO's playhead, the curve lane's) used to
 * read hooks.now()/cycleAt() directly on every animation frame. Neither clock
 * stops when the transport does: AudioContext time keeps advancing after a
 * stop, and scheduler.cycleAt is pure anchor arithmetic with no idea the
 * transport halted — so every marker kept sweeping in a stopped editor,
 * which reads as "this is still playing" exactly when it is not.
 *
 * The rule lives HERE, once, rather than re-stated per widget: a marker may
 * move only while the transport is actually running. A host that cannot say
 * (no isPlaying hook) keeps its markers rather than losing them.
 */

/** The slice of the widget Hooks a live marker needs (structural: the full
 *  editor Hooks and the docs page's rondoExtras both satisfy it). */
export interface TransportHooks {
  now?: () => number
  cycleAt?: (sec: number) => number
  isPlaying?: () => boolean
}

/** Where the transport is NOW for a live marker, or null when the marker must
 *  hide: no clock, or the transport is known to be stopped. `cycle` is absent
 *  when the host has no usable cycleAt — a free-running (Hz) marker only
 *  needs `sec`, a transport-synced one hides without `cycle`. */
export function liveTransport(hooks: TransportHooks): { sec: number; cycle?: number } | null {
  if (hooks.isPlaying?.() === false) return null
  const sec = hooks.now?.()
  if (sec === undefined || !Number.isFinite(sec)) return null
  const cycle = hooks.cycleAt?.(sec)
  return cycle !== undefined && Number.isFinite(cycle) ? { sec, cycle } : { sec }
}
