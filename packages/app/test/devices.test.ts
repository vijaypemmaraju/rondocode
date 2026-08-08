import { describe, expect, it } from 'vitest'
import {
  RENDER_QUANTUM,
  explainChoice,
  latencyReport,
  latencyVerdict,
  resolveDevice,
} from '../src/audio/devices'
import type { DeviceInfo } from '../src/audio/devices'

/* Device choice comes from two directions — a persisted setting and an
 * in-code override — which is two sources of truth for one decision. The
 * precedence therefore lives in ONE function and is pinned here:
 *
 *     code override  →  saved setting  →  OS default
 *
 * The case that matters on stage is the one where the answer is "no": a
 * project pinned to an interface that is not in the room must fall back AND
 * say so, because silently opening the laptop mic sounds wrong with nothing
 * on screen to explain it. */

const dev = (deviceId: string, label: string): DeviceInfo => ({ deviceId, label, kind: 'audioinput' })

const RIG: DeviceInfo[] = [
  dev('default', 'MacBook Pro Microphone'),
  dev('abc123', 'Scarlett 2i2 USB (1235:8210)'),
  dev('def456', 'MOTU M4'),
]

describe('resolveDevice precedence', () => {
  it('prefers the code override over the setting', () => {
    const c = resolveDevice('MOTU', 'Scarlett', RIG)
    expect(c.deviceId).toBe('def456')
    expect(c.reason).toBe('code')
  })

  it('uses the setting when the code asks for nothing', () => {
    const c = resolveDevice(undefined, 'Scarlett', RIG)
    expect(c.deviceId).toBe('abc123')
    expect(c.reason).toBe('setting')
  })

  it('leaves it to the OS when neither asks', () => {
    const c = resolveDevice(undefined, undefined, RIG)
    expect(c.deviceId).toBeUndefined()
    expect(c.reason).toBe('default')
    expect(c.fellBackFrom, 'nothing was asked for, so nothing fell back').toBeUndefined()
  })

  it('treats an empty string as "not asked", not as a device named ""', () => {
    expect(resolveDevice('', '', RIG).reason).toBe('default')
    expect(resolveDevice('', 'MOTU', RIG).reason).toBe('setting')
  })
})

describe('resolveDevice matching', () => {
  it('matches an exact deviceId', () => {
    expect(resolveDevice('abc123', undefined, RIG).label).toBe('Scarlett 2i2 USB (1235:8210)')
  })

  it('matches a LABEL fragment, because an id is worthless in a document', () => {
    // deviceIds are origin-scoped hashes that rotate when permissions are
    // cleared; a human writes the name on the box
    expect(resolveDevice('scarlett', undefined, RIG).deviceId).toBe('abc123')
    expect(resolveDevice('2i2', undefined, RIG).deviceId).toBe('abc123')
  })

  it('ignores case and collapses whitespace', () => {
    expect(resolveDevice('  MOTU   m4 ', undefined, RIG).deviceId).toBe('def456')
  })
})

describe('resolveDevice when the device is NOT in the room', () => {
  it('falls back to the setting, and records what it could not find', () => {
    const c = resolveDevice('Prism Titan', 'MOTU', RIG)
    expect(c.deviceId).toBe('def456')
    expect(c.reason).toBe('setting')
    expect(c.fellBackFrom, 'the UI has to be able to say what was missing').toBe('Prism Titan')
  })

  it('falls back to the OS when the setting is gone too', () => {
    const c = resolveDevice('Prism Titan', 'Apogee', RIG)
    expect(c.deviceId).toBeUndefined()
    expect(c.reason).toBe('default')
    expect(c.fellBackFrom).toBe('Prism Titan')
  })

  it('an unplugged SAVED device is the common case, and still reports', () => {
    const c = resolveDevice(undefined, 'MOTU', [dev('default', 'MacBook Pro Microphone')])
    expect(c.reason).toBe('default')
    expect(c.fellBackFrom).toBe('MOTU')
  })

  it('an empty device list resolves to the default rather than throwing', () => {
    expect(resolveDevice('anything', 'anything', []).reason).toBe('default')
  })
})

describe('explainChoice', () => {
  it('says nothing when you got what you asked for', () => {
    expect(explainChoice(resolveDevice('MOTU', undefined, RIG), 'input')).toBeNull()
    expect(explainChoice(resolveDevice(undefined, undefined, RIG), 'input')).toBeNull()
  })

  it('names BOTH the missing device and the one actually in use', () => {
    const msg = explainChoice(resolveDevice('Prism Titan', 'MOTU', RIG), 'input')
    expect(msg).toContain('Prism Titan')
    expect(msg).toContain('MOTU M4')
  })

  it('still explains when it fell all the way back to the system default', () => {
    const msg = explainChoice(resolveDevice('Prism Titan', undefined, RIG), 'output')
    expect(msg).toContain('Prism Titan')
    expect(msg).toContain('system default')
  })
})

describe('latencyReport', () => {
  it('sums the whole path a performer actually feels', () => {
    // the numbers measured in a real Chrome on a laptop
    const r = latencyReport(48000, 0.00533, 0, 0.01)
    expect(r.quantumMs).toBeCloseTo(2.667, 2)
    expect(r.baseMs).toBeCloseTo(5.33, 2)
    expect(r.roundTripMs).toBeCloseTo(5.33 + 10 + 2.667, 2)
  })

  it('the engine contributes exactly one render quantum and nothing more', () => {
    // BLOCK === the Web Audio render quantum, which is the whole reason this
    // is viable at all — an engine that buffered would add its own on top
    expect(RENDER_QUANTUM).toBe(128)
    expect(latencyReport(48000, 0, 0, 0).roundTripMs).toBeCloseTo((128 / 48000) * 1000, 6)
  })

  it('treats an unreported latency as 0 rather than NaN', () => {
    // outputLatency is 0/undefined in plenty of real contexts; a NaN here
    // would poison the readout instead of just under-reporting
    const r = latencyReport(48000, NaN, -1, 0)
    expect(Number.isFinite(r.roundTripMs)).toBe(true)
    expect(r.baseMs).toBe(0)
    expect(r.outputMs).toBe(0)
  })

  it('scales with the sample rate', () => {
    expect(latencyReport(44100, 0, 0, 0).quantumMs).toBeGreaterThan(
      latencyReport(48000, 0, 0, 0).quantumMs,
    )
  })
})

describe('latencyVerdict', () => {
  it('grades the round trip the way a monitoring vocalist would', () => {
    expect(latencyVerdict(8)).toBe('tight')
    expect(latencyVerdict(18)).toBe('usable')
    expect(latencyVerdict(40)).toBe('distracting')
  })

  it('is monotonic — more latency is never a better verdict', () => {
    const rank = { tight: 0, usable: 1, distracting: 2 }
    let prev = -1
    for (let ms = 0; ms <= 60; ms += 2) {
      const r = rank[latencyVerdict(ms)]
      expect(r).toBeGreaterThanOrEqual(prev)
      prev = r
    }
  })
})
