import { afterEach, describe, expect, it } from 'vitest'
import { clearCustomWavetables, defineWavetable, getWavetable } from '@rondocode/engine'
import {
  appendPartialEdit,
  barLayout,
  barValue,
  downsampleWave,
  morphWave,
  partialWave,
  previewFrames,
  removePartialEdit,
  scanWavedefs,
  scanWavetableCalls,
} from '../src/editor/rondo/wavetable'

/* Pure parts of the wavetable widgets: scanning, rewrite-range derivation,
 * bar geometry, waveform math. DOM/gesture glue stays thin and untested here
 * (it reuses the shared attachGesture/LiveWriter protocol). */

describe('scanWavedefs', () => {
  it('parses frames, values and per-number source ranges', () => {
    const src = 'wavedef vox 1 .3 / .5 1 .6\n'
    const [wd] = scanWavedefs(src)
    expect(wd).toBeDefined()
    expect(wd!.name).toBe('vox')
    expect(wd!.frames).toEqual([[1, 0.3], [0.5, 1, 0.6]])
    // ranges point at the exact number tokens
    const texts = wd!.ranges.map((fr) => fr.map((r) => src.slice(r.from, r.to)))
    expect(texts).toEqual([['1', '.3'], ['.5', '1', '.6']])
    expect(wd!.at).toBe(src.indexOf('.6') + 2)
  })

  it('offsets are absolute across lines and comments are ignored', () => {
    const src = 'cps .5\n\nwavedef a 1 / .5  # bright\nwavedef b 0 1 / 1 0\n'
    const defs = scanWavedefs(src)
    expect(defs.map((d) => d.name)).toEqual(['a', 'b'])
    const a = defs[0]!
    expect(src.slice(a.ranges[1]![0]!.from, a.ranges[1]![0]!.to)).toBe('.5')
    // the widget anchor stops before the comment
    expect(src.slice(a.at - 2, a.at)).toBe('.5')
  })

  it('skips lines that are not purely numbers and slashes (mid-edit safety)', () => {
    expect(scanWavedefs('wavedef vox 1 x / 1\n')).toEqual([])
    expect(scanWavedefs('wavedef vox 1 / / 1\n')).toEqual([])
    expect(scanWavedefs('wavedef vox\n')).toEqual([])
    // negatives and a single frame are fine (the parser flags <2 frames; the
    // widget still renders while the second frame is being typed)
    expect(scanWavedefs('wavedef vox 1 -.5\n')[0]!.frames).toEqual([[1, -0.5]])
  })
})

describe('scanWavetableCalls', () => {
  const SRC = [
    'synth lead',
    '  wavetable note scan table:vox',
    '  * env',
    '  env = adsr .01 .1 .8 .1',
    '  scan = env -> .1...9',
    '',
    'synth pad',
    '  wavetable note .35 table:harmonic',
    '',
    'synth plain',
    '  wavetable',
    '',
    'play lead',
    '  0 3 5',
    '',
  ].join('\n')

  it('finds calls with their synth, table and literal pos', () => {
    const calls = scanWavetableCalls(SRC)
    expect(calls).toHaveLength(3)
    expect(calls[0]).toMatchObject({ synth: 'lead', table: 'vox' })
    expect(calls[0]!.posLiteral).toBeUndefined() // pos is the `scan` binding
    expect(calls[1]).toMatchObject({ synth: 'pad', table: 'harmonic', posLiteral: 0.35 })
    expect(calls[2]).toMatchObject({ synth: 'plain', table: 'basic', posLiteral: 0 })
  })

  it('binding lines and rich argument shapes: table read, pos left as a signal', () => {
    const calls = scanWavetableCalls('synth s\n  o = wavetable note sine 2 table:pwm\n  o\n')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.table).toBe('pwm')
    expect(calls[0]!.posLiteral).toBeUndefined() // `sine 2` is not a simple atom pair
  })

  it('ignores wavetable outside a synth block and inside comments', () => {
    expect(scanWavetableCalls('play x\n  0 1\n')).toEqual([])
    expect(scanWavetableCalls('synth s\n  saw  # wavetable .5\n')).toEqual([])
  })
})

describe('bar geometry', () => {
  it('targets 44px columns and floors at 20px with scroll', () => {
    expect(barLayout(4, 400)).toEqual({ barW: 44, totalW: 176, scroll: false })
    expect(barLayout(10, 300)).toEqual({ barW: 30, totalW: 300, scroll: false })
    expect(barLayout(32, 300)).toEqual({ barW: 20, totalW: 640, scroll: true })
  })

  it('barValue maps pointer y to a 2-decimal amplitude, clamped', () => {
    expect(barValue(100, 100, 100)).toBe(1) // at the top
    expect(barValue(200, 100, 100)).toBe(0) // at the bottom
    expect(barValue(150, 100, 100)).toBe(0.5)
    expect(barValue(-50, 100, 100)).toBe(1) // above: clamp
    expect(barValue(1234, 100, 100)).toBe(0) // below: clamp
    expect(barValue(133.3333, 100, 100)).toBe(0.67) // snapped
  })
})

describe('rewrite range derivation (append / remove partial)', () => {
  const src = 'wavedef vox 1 .3 / .5 1\n'
  const scan = scanWavedefs(src)[0]!

  it('append inserts " 0" after the frame\'s last number', () => {
    const e0 = appendPartialEdit(scan, 0)!
    expect(src.slice(0, e0.from)).toBe('wavedef vox 1 .3')
    expect(e0).toMatchObject({ insert: ' 0' })
    expect(e0.from).toBe(e0.to)
    const e1 = appendPartialEdit(scan, 1)!
    expect(src.slice(0, e1.from)).toBe('wavedef vox 1 .3 / .5 1')
  })

  it('append refuses past the 32-partial cap', () => {
    const big = `wavedef big ${Array.from({ length: 32 }, () => '1').join(' ')} / 1\n`
    const s = scanWavedefs(big)[0]!
    expect(appendPartialEdit(s, 0)).toBeNull()
    expect(appendPartialEdit(s, 1)).not.toBeNull()
  })

  it('remove deletes the last number (with its separating space)', () => {
    const e = removePartialEdit(scan, 0)!
    expect(src.slice(e.from, e.to)).toBe(' .3')
    expect(e.insert).toBe('')
  })

  it('remove refuses to empty a frame', () => {
    const one = scanWavedefs('wavedef x 1 / 1 .5\n')[0]!
    expect(removePartialEdit(one, 0)).toBeNull()
    expect(removePartialEdit(one, 1)).not.toBeNull()
  })
})

describe('waveform math', () => {
  it('partialWave of a lone fundamental is a unit sine', () => {
    const w = partialWave([1], 8)
    expect(w[0]).toBeCloseTo(0, 6)
    expect(w[2]).toBeCloseTo(1, 6) // sin(pi/2)
    expect(w[6]).toBeCloseTo(-1, 6)
  })

  it('partialWave normalizes the peak to 1 whatever the amplitudes', () => {
    const w = partialWave([0.2, 0.05, 0.01], 128)
    const peak = Math.max(...Array.from(w).map(Math.abs))
    expect(peak).toBeCloseTo(1, 6)
  })

  it('morphWave interpolates sample-wise between adjacent frames', () => {
    const a = new Float32Array([0, 0, 0])
    const b = new Float32Array([1, 1, 1])
    expect(Array.from(morphWave([a, b], 0.5))).toEqual([0.5, 0.5, 0.5])
    expect(Array.from(morphWave([a, b], 0))).toEqual([0, 0, 0])
    expect(Array.from(morphWave([a, b], 1))).toEqual([1, 1, 1])
    // clamped out-of-range t
    expect(Array.from(morphWave([a, b], 2))).toEqual([1, 1, 1])
  })

  it('downsampleWave keeps length and range', () => {
    const src = new Float32Array(2048).map((_, i) => Math.sin((2 * Math.PI * i) / 2048))
    const d = downsampleWave(src, 96)
    expect(d.length).toBe(96)
    expect(Math.max(...Array.from(d))).toBeGreaterThan(0.9)
  })
})

describe('previewFrames source resolution', () => {
  afterEach(() => clearCustomWavetables())

  it('doc wavedefs win (fresh while typing), then the engine bank, then null', () => {
    const doc = scanWavedefs('wavedef fresh 1 / 0 1\n')
    const fromDoc = previewFrames('fresh', doc)
    expect(fromDoc).not.toBeNull()
    expect(fromDoc!).toHaveLength(2)
    // built-in bank
    const basic = previewFrames('basic', [])
    expect(basic!.length).toBe(getWavetable('basic').length)
    // registry custom (last successful eval)
    defineWavetable('evaled', [[1], [0, 1], [0, 0, 1]])
    expect(previewFrames('evaled', [])!).toHaveLength(3)
    // nowhere
    expect(previewFrames('ghost', [])).toBeNull()
  })
})
