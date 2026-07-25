import { describe, expect, it } from 'vitest'
import {
  cadenceStats,
  deriveCadenceStatus,
  formatLogTime,
  parseUserAgent,
  rmsDb,
  serializeReport,
  statusGlyph,
  statusLabel,
} from '../src/diag/report'
import type { CadenceSample, CheckResult } from '../src/diag/report'

const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'
const IPHONE_CHROME =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/123.0.6312.52 Mobile/15E148 Safari/604.1'
const IPAD_DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15'
const MAC_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

describe('parseUserAgent', () => {
  it('detects iPhone Safari with iOS + Safari versions', () => {
    const ua = parseUserAgent(IPHONE_SAFARI, 5)
    expect(ua.ios).toBe(true)
    expect(ua.safari).toBe(true)
    expect(ua.os).toBe('iOS 17.4.1')
    expect(ua.browser).toBe('Safari 17.4')
  })

  it('detects Chrome on iOS as a shell, not Safari', () => {
    const ua = parseUserAgent(IPHONE_CHROME, 5)
    expect(ua.ios).toBe(true)
    expect(ua.safari).toBe(false)
    expect(ua.os).toBe('iOS 17.4')
    expect(ua.browser).toBe('Chrome 123 (iOS shell)')
  })

  it('unmasks iPadOS behind a desktop Macintosh UA via touch points', () => {
    const ua = parseUserAgent(IPAD_DESKTOP_UA, 5)
    expect(ua.ios).toBe(true)
    expect(ua.safari).toBe(true)
    expect(ua.os).toBe('iPadOS (version hidden by desktop UA)')
    expect(ua.browser).toBe('Safari 17.4')
  })

  it('a real Mac (0 touch points) with the same UA is NOT iOS', () => {
    const ua = parseUserAgent(IPAD_DESKTOP_UA, 0)
    expect(ua.ios).toBe(false)
    expect(ua.safari).toBe(true)
  })

  it('desktop Chrome: not iOS, not Safari, Chrome version found', () => {
    const ua = parseUserAgent(MAC_CHROME, 0)
    expect(ua.ios).toBe(false)
    expect(ua.safari).toBe(false)
    expect(ua.os).toBeNull()
    expect(ua.browser).toBe('Chrome 126')
  })
})

describe('cadenceStats', () => {
  // 48 kHz, 1280 frames/event => expected interval ~26.67 ms
  const SR = 48000
  const steady = (n: number, intervalMs: number): CadenceSample[] =>
    Array.from({ length: n }, (_, i) => ({ atMs: 1000 + i * intervalMs, frame: 10_000 + i * 1280 }))

  it('steady realtime delivery: no dropouts, ratio ~1, passes', () => {
    const stats = cadenceStats(steady(75, 1280 / 48), SR)
    expect(stats.count).toBe(75)
    expect(stats.dropouts).toBe(0)
    expect(stats.realtimeRatio).toBeCloseTo(1, 5)
    expect(stats.meanIntervalMs).toBeCloseTo(1280 / 48, 5)
    expect(deriveCadenceStatus(stats)).toBe('pass')
  })

  it('one long gap counts as a dropout and downgrades to warn', () => {
    const samples = steady(75, 1280 / 48)
    // open a 200 ms hole after sample 30 (shift the rest later in time only;
    // frames stay contiguous, as they do when the OS stalls message delivery)
    for (let i = 31; i < samples.length; i++) samples[i] = { ...samples[i]!, atMs: samples[i]!.atMs + 200 }
    const stats = cadenceStats(samples, SR)
    expect(stats.dropouts).toBe(1)
    expect(stats.worstGapMs).toBeGreaterThan(200)
    expect(deriveCadenceStatus(stats)).toBe('warn')
  })

  it('audio thread falling far behind realtime fails', () => {
    // events arrive but frames advance at half speed vs wall clock
    const samples = Array.from({ length: 40 }, (_, i) => ({ atMs: i * 53.4, frame: i * 1280 }))
    const stats = cadenceStats(samples, SR)
    expect(stats.realtimeRatio).toBeLessThan(0.9)
    expect(deriveCadenceStatus(stats)).toBe('fail')
  })

  it('fewer than 2 samples is a fail with zeroed stats', () => {
    const stats = cadenceStats([{ atMs: 0, frame: 0 }], SR)
    expect(stats.count).toBe(1)
    expect(stats.elapsedMs).toBe(0)
    expect(deriveCadenceStatus(stats)).toBe('fail')
  })
})

describe('formatting helpers', () => {
  it('statusGlyph and statusLabel cover every status', () => {
    expect(statusGlyph('pass')).toBe('✓')
    expect(statusGlyph('warn')).toBe('!')
    expect(statusGlyph('fail')).toBe('✗')
    expect(statusGlyph('pending')).toBe('·')
    expect(statusLabel('pass')).toBe('pass')
    expect(statusLabel('warn')).toBe('warn')
    expect(statusLabel('fail')).toBe('FAIL')
    expect(statusLabel('pending')).toBe('....')
  })

  it('rmsDb converts amplitude to dB and clamps silence', () => {
    expect(rmsDb(1)).toBe('0.0 dB')
    expect(rmsDb(0.1)).toBe('-20.0 dB')
    expect(rmsDb(0)).toBe('-inf dB')
    expect(rmsDb(-1)).toBe('-inf dB')
    expect(rmsDb(Number.NaN)).toBe('-inf dB')
  })

  it('formatLogTime renders relative seconds', () => {
    expect(formatLogTime(0)).toBe('+0.000s')
    expect(formatLogTime(12345)).toBe('+12.345s')
  })
})

describe('serializeReport', () => {
  const results: CheckResult[] = [
    { section: 'ENVIRONMENT', name: 'user agent', status: 'pass', detail: 'test-ua' },
    { section: 'AUDIO', name: 'context state', status: 'pending', detail: 'tap start audio' },
    { section: 'ENVIRONMENT', name: 'visualViewport', status: 'warn', detail: 'missing' },
    { section: 'AUDIO', name: 'worklet module', status: 'fail', detail: 'boom' },
  ]

  it('groups by section in first-seen order and labels statuses', () => {
    const text = serializeReport(results, [{ atMs: 1500, message: 'visibility -> hidden' }], {
      generatedAt: '2026-07-25T00:00:00.000Z',
      url: 'https://rondocode.com/diag',
    })
    expect(text).toBe(
      [
        'rondocode iOS diagnostic report',
        'generated: 2026-07-25T00:00:00.000Z',
        'url: https://rondocode.com/diag',
        '',
        '[ENVIRONMENT]',
        '  [pass] user agent: test-ua',
        '  [warn] visualViewport: missing',
        '',
        '[AUDIO]',
        '  [....] context state: tap start audio',
        '  [FAIL] worklet module: boom',
        '',
        '[EVENT LOG]',
        '  +1.500s  visibility -> hidden',
      ].join('\n'),
    )
  })

  it('renders an empty log placeholder and omits the url line when absent', () => {
    const text = serializeReport([], [], { generatedAt: 'now' })
    expect(text).toContain('[EVENT LOG]\n  (empty)')
    expect(text).not.toContain('url:')
  })
})
