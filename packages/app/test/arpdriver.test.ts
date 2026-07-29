import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ArpDriver } from '../src/midi/arpdriver'

/* The timing half. Every test here is about a rule that has already caused a
 * real bug somewhere else in this app: driving from the transport instead of
 * the wall clock, and releasing what you gated when you stop. */

const rig = (opts = {}) => {
  const log: string[] = []
  let t = 0
  let playing = true
  let cycle = 0
  const d = new ArpDriver(
    {
      now: () => t,
      cycleAt: () => cycle,
      isPlaying: () => playing,
      noteOn: (n, v) => log.push(`on:${n}@${v.toFixed(2)}`),
      noteOff: (n) => log.push(`off:${n}`),
    },
    { steps: [{ degrees: [0] }, { degrees: [1] }, { degrees: [2] }, { degrees: [3] }], stepsPerCycle: 4, ...opts },
  )
  return {
    d, log,
    at: (c: number) => { cycle = c; t += 0.01; d.tick() },
    setPlaying: (p: boolean) => { playing = p },
  }
}
const Am = [57, 60, 64]
const holdAm = (d: ArpDriver) => Am.forEach((n) => d.noteOn(n))

describe('stepping', () => {
  it('advances one step per grid position, releasing the previous', () => {
    const { d, log, at } = rig()
    holdAm(d)
    at(0);      expect(log).toEqual(['on:57@1.00'])
    at(0.25);   expect(log.slice(1)).toEqual(['off:57', 'on:60@1.00'])
    at(0.5);    expect(log.slice(3)).toEqual(['off:60', 'on:64@1.00'])
  })

  it('acts on a step ONCE however often it is polled', () => {
    const { d, log, at } = rig()
    holdAm(d)
    at(0); at(0.1); at(0.2) // all inside step 0
    expect(log).toEqual(['on:57@1.00'])
  })

  it('sounds nothing with no chord held', () => {
    const { log, at } = rig()
    at(0); at(0.25)
    expect(log).toEqual([])
  })
})

describe('the transport, not the wall clock', () => {
  it('restarts at step 0 after a stop, rather than resuming mid-figure', () => {
    // the roll playhead had exactly this bug: free-running on the audio clock
    // meant a restart carried on from wherever the clock had reached
    const { d, log, at, setPlaying } = rig()
    holdAm(d)
    at(0); at(0.25); at(0.5) // through step 2
    log.length = 0
    setPlaying(false); at(0.75)
    setPlaying(true); at(0) // transport restarted at cycle 0
    expect(log.filter((l) => l.startsWith('on:'))).toEqual(['on:57@1.00']) // step 0
  })

  it('a stop releases what the arp gated', () => {
    const { d, log, at, setPlaying } = rig()
    holdAm(d)
    at(0)
    log.length = 0
    setPlaying(false); at(0.1)
    expect(log).toEqual(['off:57']) // not left hanging
    expect(d.active()).toEqual([])
  })

  it('releases only ITS notes, and only once', () => {
    const { d, log, at, setPlaying } = rig()
    holdAm(d)
    at(0)
    setPlaying(false); at(0.1); at(0.2) // stopped twice
    expect(log.filter((l) => l === 'off:57')).toHaveLength(1)
  })
})

describe('keyboard behaviour', () => {
  it('accumulates a chord before the transport is even running', () => {
    const { d, at, log, setPlaying } = rig()
    setPlaying(false)
    holdAm(d)
    setPlaying(true); at(0)
    expect(log).toEqual(['on:57@1.00'])
  })

  it('unlatched, letting go silences the arp immediately', () => {
    const { d, log, at } = rig()
    holdAm(d)
    at(0)
    log.length = 0
    Am.forEach((n) => d.noteOff(n))
    expect(log).toEqual(['off:57']) // no waiting for the next tick
    expect(d.active()).toEqual([])
  })

  it('latched, the figure keeps running after you let go', () => {
    const { d, log, at } = rig({ latch: true })
    holdAm(d)
    at(0)
    Am.forEach((n) => d.noteOff(n))
    log.length = 0
    at(0.25)
    expect(log).toEqual(['off:57', 'on:60@1.00']) // still going
  })

  it('the chord can change under a running figure', () => {
    const { d, log, at } = rig()
    holdAm(d)
    at(0)
    Am.forEach((n) => d.noteOff(n))
    ;[53, 57, 60].forEach((n) => d.noteOn(n)) // F
    log.length = 0
    at(0.25)
    expect(log.filter((l) => l.startsWith('on:'))).toEqual(['on:57@1.00']) // degree 1 of F
  })
})

describe('configure', () => {
  it('changes the grid without restarting the figure', () => {
    const { d, log, at } = rig()
    holdAm(d)
    at(0)
    d.configure({ stepsPerCycle: 8 })
    log.length = 0
    at(0.125) // a step at the NEW grid
    expect(log.filter((l) => l.startsWith('on:'))).toHaveLength(1)
  })
})

describe('the panel actually reaches the driver', () => {
  /* Same standard as the MIDI importer and the desktop bridge: a capability
   * with no way to switch it on is not a capability. */
  const src = readFileSync(join(__dirname, '../src/editor/midi.ts'), 'utf8')

  it('MIDI input routes to the arp when one is on for that synth', () => {
    expect(src).toContain('const arp = arpFor(synth)')
    expect(src).toMatch(/arp\.noteOn\(data\[1\]!\)/)
    // and returns, so the note does NOT also sound directly
    expect(src).toMatch(/arp\.noteOff\(data\[1\]!\)\s*\n\s*return/)
  })

  it('is opt-in: no driver exists until the panel switches one on', () => {
    expect(src).toMatch(/arpFor = \(synth: string\): ArpDriver \| null => arps\.get\(synth\) \?\? null/)
    expect(src).toContain('arpOn.checked')
  })

  it('drives from the transport, never the wall clock', () => {
    expect(src).toContain('cycleAt: (t) => session.cycleAt(t)')
    expect(src).toContain('isPlaying: () => session.getState().playing')
  })

  it('releases every arp when the panel is torn down', () => {
    expect(src).toContain('stopArps()')
  })

  it('stops polling once the last arp is switched off', () => {
    // a timer left running per closed panel is a slow leak
    expect(src).toMatch(/arps\.size === 0 && arpTimer !== undefined/)
  })
})
