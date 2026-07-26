/* ------------------------------------------------------------------------- *
 * Pure logic for the /diag page (diag.ts): status derivation, UA parsing,
 * worklet-cadence statistics, and plaintext report serialization. No DOM, no
 * Web Audio — everything here is unit-tested in test/diag-report.test.ts.
 * ------------------------------------------------------------------------- */

/** One check row's lifecycle: created `pending`, resolved to one of the rest. */
export type Status = 'pending' | 'pass' | 'warn' | 'fail'

/** A resolved (or pending) check, as rendered on the page and in the report. */
export interface CheckResult {
  section: string
  name: string
  status: Status
  detail: string
}

/** A timestamped event-log line (interruptions, visibility, user actions). */
export interface LogEntry {
  /** milliseconds since page load (performance.now() based) */
  atMs: number
  message: string
}

/** The glyph shown in a row's status column. */
export const statusGlyph = (s: Status): string =>
  s === 'pass' ? '✓' : s === 'warn' ? '!' : s === 'fail' ? '✗' : '·'

/** The bracketed label used in the plaintext report ([pass]/[warn]/[FAIL]/[....]). */
export const statusLabel = (s: Status): string =>
  s === 'fail' ? 'FAIL' : s === 'pending' ? '....' : s

/** What UA parsing could establish about the platform. Fields are null when
 *  the UA gives no signal (e.g. iPadOS masquerading as macOS hides the OS
 *  version; desktop Chrome has no iOS version at all). */
export interface UaInfo {
  /** e.g. 'iOS 17.4' or 'iPadOS (version hidden by desktop UA)' */
  os: string | null
  /** e.g. 'Safari 17.4', 'Chrome 120 (iOS shell)' */
  browser: string | null
  ios: boolean
  /** true only for Safari proper (not Chrome/Firefox/Edge iOS shells) */
  safari: boolean
}

/** Parse OS + browser from a user-agent string. `maxTouchPoints` disambiguates
 *  iPadOS, which reports a Macintosh UA when "Request Desktop Website" (the
 *  iPad default) is on: Macs report 0 touch points, iPads > 1. */
export const parseUserAgent = (ua: string, maxTouchPoints = 0): UaInfo => {
  const iDevice = /iPhone|iPad|iPod/.test(ua)
  const iPadAsMac = !iDevice && /Macintosh/.test(ua) && maxTouchPoints > 1
  const ios = iDevice || iPadAsMac

  let os: string | null = null
  const osMatch = /(?:iPhone )?OS (\d+)[._](\d+)(?:[._](\d+))?/.exec(ua)
  if (iDevice && osMatch) {
    const patch = osMatch[3] !== undefined ? `.${osMatch[3]}` : ''
    os = `iOS ${osMatch[1]}.${osMatch[2]}${patch}`
  } else if (iPadAsMac) {
    os = 'iPadOS (version hidden by desktop UA)'
  }

  let browser: string | null = null
  let safari = false
  const crios = /CriOS\/(\d+)/.exec(ua)
  const fxios = /FxiOS\/(\d+)/.exec(ua)
  const edgios = /EdgiOS\/(\d+)/.exec(ua)
  const version = /Version\/(\d+(?:\.\d+)?)/.exec(ua)
  if (crios) browser = `Chrome ${crios[1]} (iOS shell)`
  else if (fxios) browser = `Firefox ${fxios[1]} (iOS shell)`
  else if (edgios) browser = `Edge ${edgios[1]} (iOS shell)`
  else if (/Safari\//.test(ua) && version && !/Chrome\//.test(ua)) {
    browser = `Safari ${version[1]}`
    safari = true
  } else {
    const chrome = /Chrome\/(\d+)/.exec(ua)
    const firefox = /Firefox\/(\d+)/.exec(ua)
    if (chrome) browser = `Chrome ${chrome[1]}`
    else if (firefox) browser = `Firefox ${firefox[1]}`
  }

  return { os, browser, ios, safari }
}

/** One cadence sample: a meters event's arrival time + its engine frame. */
export interface CadenceSample {
  atMs: number
  frame: number
}

export interface CadenceStats {
  /** events observed */
  count: number
  /** wall-clock span from first to last event, ms */
  elapsedMs: number
  /** mean interval between events, ms */
  meanIntervalMs: number
  /** longest interval between events, ms */
  worstGapMs: number
  /** intervals longer than 3x the expected cadence */
  dropouts: number
  /** audio-frames elapsed vs wall-clock elapsed; ~1.0 = keeping realtime.
   *  Below 1: the audio thread rendered fewer frames than realtime required. */
  realtimeRatio: number
}

/** Summarize a run of worklet meters events. The engine posts one every
 *  `blockFrames` frames (10 blocks of 128), so both the arrival cadence and
 *  the frame counter are checked: late arrivals = main-thread jank or message
 *  delay, a low realtimeRatio = the audio thread itself fell behind. */
export const cadenceStats = (
  samples: readonly CadenceSample[],
  sampleRate: number,
  blockFrames = 1280,
): CadenceStats => {
  if (samples.length < 2) {
    return { count: samples.length, elapsedMs: 0, meanIntervalMs: 0, worstGapMs: 0, dropouts: 0, realtimeRatio: 0 }
  }
  const first = samples[0]!
  const last = samples[samples.length - 1]!
  const elapsedMs = last.atMs - first.atMs
  const expectedIntervalMs = (blockFrames / sampleRate) * 1000
  let worstGapMs = 0
  let dropouts = 0
  for (let i = 1; i < samples.length; i++) {
    const gap = samples[i]!.atMs - samples[i - 1]!.atMs
    if (gap > worstGapMs) worstGapMs = gap
    if (gap > expectedIntervalMs * 3) dropouts++
  }
  const framesMs = ((last.frame - first.frame) / sampleRate) * 1000
  return {
    count: samples.length,
    elapsedMs,
    meanIntervalMs: elapsedMs / (samples.length - 1),
    worstGapMs,
    dropouts,
    realtimeRatio: elapsedMs > 0 ? framesMs / elapsedMs : 0,
  }
}

/** pass = steady delivery at realtime; warn = occasional gaps or slightly
 *  behind; fail = no usable signal or clearly not keeping up. */
export const deriveCadenceStatus = (stats: CadenceStats): Status => {
  if (stats.count < 2) return 'fail'
  if (stats.realtimeRatio < 0.9) return 'fail'
  if (stats.dropouts > 0 || stats.realtimeRatio < 0.97) return 'warn'
  return 'pass'
}

/** RMS (0..1) as a dB string for the mic level row. */
export const rmsDb = (rms: number): string => {
  if (!(rms > 0)) return '-inf dB'
  return `${(20 * Math.log10(rms)).toFixed(1)} dB`
}

/** '+12.345s' — the event log's relative timestamp format. */
export const formatLogTime = (atMs: number): string => `+${(atMs / 1000).toFixed(3)}s`

/** Serialize every check + the event log to the plaintext block the
 *  "copy report" button puts on the clipboard. Sections keep the insertion
 *  order of `results`; rows keep their order within a section. */
export const serializeReport = (
  results: readonly CheckResult[],
  log: readonly LogEntry[],
  meta: { generatedAt: string; url?: string },
): string => {
  const lines: string[] = ['rondocode iOS diagnostic report', `generated: ${meta.generatedAt}`]
  if (meta.url !== undefined) lines.push(`url: ${meta.url}`)
  const sections: string[] = []
  for (const r of results) if (!sections.includes(r.section)) sections.push(r.section)
  for (const section of sections) {
    lines.push('', `[${section}]`)
    for (const r of results) {
      if (r.section !== section) continue
      lines.push(`  [${statusLabel(r.status)}] ${r.name}: ${r.detail}`)
    }
  }
  lines.push('', '[EVENT LOG]')
  if (log.length === 0) lines.push('  (empty)')
  for (const e of log) lines.push(`  ${formatLogTime(e.atMs)}  ${e.message}`)
  return lines.join('\n')
}

/** Render base/output latency with a plausibility guard: iOS WebKit has been
 *  seen reporting outputLatency as garbage (tens of MILLIONS of ms). Any
 *  latency outside (0, 2] seconds is a browser reporting bug, not a real
 *  latency - surface it as a warn instead of blessing it. Pure. */
export function latencySummary(baseSec: number | undefined, outSec: number | undefined): { status: 'pass' | 'warn'; detail: string } {
  const plausible = (v: number): boolean => v > 0 && v <= 2
  const fmt = (v: number): string => `${(v * 1000).toFixed(1)} ms`
  const parts: string[] = []
  let status: 'pass' | 'warn' = typeof baseSec === 'number' ? 'pass' : 'warn'
  if (typeof baseSec !== 'number') parts.push('base unavailable')
  else if (plausible(baseSec)) parts.push(`base ${fmt(baseSec)}`)
  else {
    parts.push(`base IMPLAUSIBLE (browser reported ${baseSec})`)
    status = 'warn'
  }
  if (typeof outSec !== 'number' || outSec === 0) parts.push('outputLatency unavailable')
  else if (plausible(outSec)) parts.push(`output ${fmt(outSec)}`)
  else {
    parts.push(`output IMPLAUSIBLE (browser reported ${outSec}; a WebKit reporting bug, not real latency)`)
    status = 'warn'
  }
  return { status, detail: parts.join(', ') }
}
