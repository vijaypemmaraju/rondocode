import { describe, expect, it } from 'vitest'
import { liveTransport } from '../src/editor/rondo/transport'

/* The clock a live marker rides never stops: AudioContext time keeps
 * advancing after a transport stop, and scheduler.cycleAt is pure anchor
 * arithmetic that never freezes. liveTransport is the one rule that turns
 * "the clock says" into "the transport is actually playing" — the LFO
 * playhead and the curve lane playhead both hide through it. */
describe('liveTransport', () => {
  it('a STOPPED transport hides the marker, however alive the clocks are', () => {
    // the bug this pins: both clocks return happily while stopped
    expect(liveTransport({ isPlaying: () => false, now: () => 12.3, cycleAt: (s) => s * 2 })).toBeNull()
  })

  it('playing: hands back the clock and the transport cycle', () => {
    expect(liveTransport({ isPlaying: () => true, now: () => 2, cycleAt: (s) => s * 2 })).toEqual({ sec: 2, cycle: 4 })
  })

  it('a host with no isPlaying hook keeps its markers (degrade to the old behavior, not a blackout)', () => {
    expect(liveTransport({ now: () => 2, cycleAt: (s) => s })).toEqual({ sec: 2, cycle: 2 })
  })

  it('no usable clock → no marker', () => {
    expect(liveTransport({})).toBeNull()
    expect(liveTransport({ isPlaying: () => true })).toBeNull()
    expect(liveTransport({ now: () => Number.NaN })).toBeNull()
  })

  it('a cycleAt that cannot answer leaves only the seconds — free-running (Hz) markers still move, synced ones hide', () => {
    expect(liveTransport({ now: () => 2, cycleAt: () => Number.NaN })).toEqual({ sec: 2 })
    expect(liveTransport({ now: () => 2 })).toEqual({ sec: 2 })
  })
})
