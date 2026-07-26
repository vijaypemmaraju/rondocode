import './diag/diag.css'
import { applyPalette } from './ui/palette'
import workletUrl from './audio/worklet/processor?worker&url'
import { cadenceStats, deriveCadenceStatus, formatLogTime, latencySummary, parseUserAgent, rmsDb, serializeReport, statusGlyph } from './diag/report'
import type { CadenceSample, CheckResult, LogEntry, Status } from './diag/report'

/* ------------------------------------------------------------------------- *
 * The standalone /diag page: one visit from an iPhone tells us everything
 * about audio/touch support. Deliberately tiny and dependency-free: no
 * editor, no engine session — the ONLY heavyweight asset is the real
 * 'rondocode-engine' AudioWorklet module (the same ?worker&url import
 * AudioSession uses), loaded to prove the actual engine worklet runs.
 *
 * Every check is defensive: a throwing API renders as a fail row with the
 * error message, never a broken page. Pure logic (UA parsing, cadence stats,
 * report serialization) lives in ./diag/report.ts and is unit-tested.
 * ------------------------------------------------------------------------- */

applyPalette()

const t0 = performance.now()
const results: CheckResult[] = []
const log: LogEntry[] = []

const errMsg = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e))

// ---- DOM scaffolding --------------------------------------------------------

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (cls !== undefined) node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}

const root = el('div', 'diag')
document.body.appendChild(root)

const head = el('div', 'diag-head')
head.appendChild(el('h1', undefined, 'rondocode diagnostics'))
const backLink = el('a', undefined, 'back to app')
backLink.href = '/'
head.appendChild(backLink)
root.appendChild(head)

const section = (title: string): HTMLElement => {
  const s = el('section', 'diag-section')
  s.appendChild(el('h2', undefined, title))
  root.appendChild(s)
  return s
}

/** Create a check row (pending) and return its setter. The setter updates
 *  both the DOM and the CheckResult the report serializer reads. */
const mkRow = (
  sectionEl: HTMLElement,
  sectionName: string,
  name: string,
  detail = '',
): ((status: Status, detail: string) => void) => {
  const result: CheckResult = { section: sectionName, name, status: 'pending', detail }
  results.push(result)
  const row = el('div', 'diag-row')
  row.dataset['status'] = 'pending'
  const glyph = el('span', 'diag-glyph', statusGlyph('pending'))
  const nameEl = el('span', 'diag-name', name)
  const detailEl = el('span', 'diag-detail', detail)
  row.append(glyph, nameEl, detailEl)
  sectionEl.appendChild(row)
  return (status, d) => {
    result.status = status
    result.detail = d
    row.dataset['status'] = status
    glyph.textContent = statusGlyph(status)
    detailEl.textContent = d
  }
}

type Setter = ReturnType<typeof mkRow>

/** Run a check; a throw resolves the row as fail with the error message. */
const safe = async (set: Setter, fn: () => void | Promise<void>): Promise<void> => {
  try {
    await fn()
  } catch (e) {
    set('fail', errMsg(e))
  }
}

// ---- 1. ENVIRONMENT ---------------------------------------------------------

const envEl = section('environment')
const envRow = (name: string): Setter => mkRow(envEl, 'ENVIRONMENT', name)

{
  const setUa = envRow('user agent')
  void safe(setUa, () => setUa('pass', navigator.userAgent))

  const setPlatform = envRow('platform')
  void safe(setPlatform, () => {
    const info = parseUserAgent(navigator.userAgent, navigator.maxTouchPoints)
    const desc = [info.os ?? 'OS unknown', info.browser ?? 'browser unknown'].join(', ')
    if (info.ios) setPlatform('pass', desc)
    else setPlatform('warn', `${desc} (not iOS - this page is aimed at iPhone/iPad)`)
  })

  const setDpr = envRow('devicePixelRatio')
  void safe(setDpr, () => setDpr('pass', String(window.devicePixelRatio)))

  const setCores = envRow('hardwareConcurrency')
  void safe(setCores, () => {
    const n = navigator.hardwareConcurrency
    if (typeof n === 'number') setCores('pass', `${n} logical cores`)
    else setCores('warn', 'unavailable')
  })

  const setVv = envRow('visualViewport')
  void safe(setVv, () => {
    const vv = window.visualViewport
    if (vv) setVv('pass', `supported (${Math.round(vv.width)}x${Math.round(vv.height)} @ scale ${vv.scale})`)
    else setVv('warn', 'not supported - keyboard/zoom handling degraded')
  })
}

// ---- 2. AUDIO ---------------------------------------------------------------

const audioEl = section('audio')
const audioActions = el('div', 'diag-actions')
audioEl.appendChild(audioActions)
const startBtn = el('button', 'primary', 'start audio')
audioActions.appendChild(startBtn)

const setCtxState = mkRow(audioEl, 'AUDIO', 'context state', 'tap start audio')
const setRate = mkRow(audioEl, 'AUDIO', 'sample rate', 'tap start audio')
const setLatency = mkRow(audioEl, 'AUDIO', 'output latency', 'tap start audio')
const setWorklet = mkRow(audioEl, 'AUDIO', 'engine worklet module', 'tap start audio')
const setPing = mkRow(audioEl, 'AUDIO', 'port round-trip', 'tap start audio')
const setCadence = mkRow(audioEl, 'AUDIO', 'callback cadence (2s)', 'tap start audio')

let ctx: AudioContext | null = null
let node: AudioWorkletNode | null = null
const portListeners = new Set<(msg: Record<string, unknown>) => void>()

const addLog = (message: string): void => {
  const entry: LogEntry = { atMs: performance.now() - t0, message }
  log.push(entry)
  logEl.textContent += `${formatLogTime(entry.atMs)}  ${message}\n`
  logEl.scrollTop = logEl.scrollHeight
}

const runAudioChecks = async (): Promise<void> => {
  startBtn.disabled = true
  await safe(setCtxState, async () => {
    // The app's exact context options (see AudioSession.start): the engine
    // asks for 48 kHz; iOS may hand back 44.1 kHz on some routes.
    try {
      ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' })
    } catch (e) {
      addLog(`AudioContext(48k) threw: ${errMsg(e)}; retrying with defaults`)
      ctx = new AudioContext()
    }
    const c = ctx
    c.addEventListener('statechange', () => {
      addLog(`audiocontext state -> ${c.state as string}`)
      setCtxState(c.state === 'running' ? 'pass' : 'warn', `${c.state as string}`)
    })
    await c.resume() // inside the tap gesture - the iOS unlock
    setCtxState(c.state === 'running' ? 'pass' : 'fail', `${c.state as string} after resume()`)
    addLog(`audio started (state ${c.state as string})`)
  })
  const c = ctx
  if (!c) {
    const detail = 'no AudioContext'
    setRate('fail', detail)
    setLatency('fail', detail)
    setWorklet('fail', detail)
    setPing('fail', detail)
    setCadence('fail', detail)
    return
  }

  await safe(setRate, () => {
    const sr = c.sampleRate
    if (sr === 48000) setRate('pass', '48000 Hz (matches the engine request)')
    else if (sr === 44100) setRate('warn', '44100 Hz (engine asked for 48000; device resamples)')
    else setRate('warn', `${sr} Hz (engine asked for 48000)`)
  })

  await safe(setLatency, () => {
    const out = (c as AudioContext & { outputLatency?: number }).outputLatency
    const sum = latencySummary(c.baseLatency, out)
    setLatency(sum.status, sum.detail)
  })

  await safe(setWorklet, async () => {
    const before = performance.now()
    await c.audioWorklet.addModule(workletUrl)
    const loadMs = performance.now() - before
    // The real engine worklet, with the app's node options.
    node = new AudioWorkletNode(c, 'rondocode-engine', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    })
    node.port.onmessage = (e: MessageEvent) => {
      const msg = e.data as Record<string, unknown>
      for (const fn of portListeners) fn(msg)
    }
    node.connect(c.destination) // engine renders silence (no synths defined)
    setWorklet('pass', `loaded + node created in ${loadMs.toFixed(0)} ms`)
  })
  const n = node
  if (!n) {
    setPing('fail', 'worklet unavailable')
    setCadence('fail', 'worklet unavailable')
    return
  }

  await safe(setPing, async () => {
    // Round-trip: removeSynth on a name that never exists makes the engine
    // reply immediately with an error event echoing our message id.
    const pingOnce = (i: number): Promise<number> =>
      new Promise((resolve, reject) => {
        const id = `diag-ping-${i}`
        const before = performance.now()
        const timer = setTimeout(() => {
          portListeners.delete(onMsg)
          reject(new Error('no reply within 1s'))
        }, 1000)
        const onMsg = (msg: Record<string, unknown>): void => {
          if (msg['kind'] !== 'error' || msg['id'] !== id) return
          clearTimeout(timer)
          portListeners.delete(onMsg)
          resolve(performance.now() - before)
        }
        portListeners.add(onMsg)
        n.port.postMessage({ kind: 'removeSynth', name: '__diag_ping__', id })
      })
    const rtts: number[] = []
    for (let i = 0; i < 5; i++) rtts.push(await pingOnce(i))
    rtts.sort((a, b) => a - b)
    const median = rtts[Math.floor(rtts.length / 2)]!
    setPing('pass', `median ${median.toFixed(1)} ms over 5 pings (min ${rtts[0]!.toFixed(1)}, max ${rtts[4]!.toFixed(1)})`)
  })

  await safe(setCadence, async () => {
    setCadence('pending', 'measuring for 2s...')
    // The engine posts a meters event every 10 blocks (1280 frames); collect
    // arrivals + frame counters for 2 seconds and check delivery stayed
    // steady and the audio thread kept realtime.
    const samples: CadenceSample[] = []
    const onMsg = (msg: Record<string, unknown>): void => {
      if (msg['kind'] !== 'meters') return
      samples.push({ atMs: performance.now(), frame: Number(msg['frame']) })
    }
    portListeners.add(onMsg)
    await new Promise((resolve) => setTimeout(resolve, 2000))
    portListeners.delete(onMsg)
    const stats = cadenceStats(samples, c.sampleRate)
    const status = deriveCadenceStatus(stats)
    if (stats.count < 2) {
      setCadence('fail', `only ${stats.count} meters events in 2s - is audio running?`)
      return
    }
    setCadence(
      status,
      `${stats.count} events, mean ${stats.meanIntervalMs.toFixed(1)} ms, worst gap ${stats.worstGapMs.toFixed(0)} ms, ` +
        `${stats.dropouts} dropouts, realtime ratio ${stats.realtimeRatio.toFixed(3)}`,
    )
  })
  addLog('audio checks complete')
}

startBtn.addEventListener('click', () => void runAudioChecks())

// ---- 3. INTERRUPTIONS -------------------------------------------------------

const intEl = section('interruptions')
const intActions = el('div', 'diag-actions')
intEl.appendChild(intActions)
const resumeBtn = el('button', undefined, 'resume audio')
intActions.appendChild(resumeBtn)

const setListeners = mkRow(intEl, 'INTERRUPTIONS', 'listeners')
const setResume = mkRow(intEl, 'INTERRUPTIONS', 'manual resume', 'tap resume audio (after start audio)')
const logEl = el('pre', 'diag-log')
intEl.appendChild(logEl)

void safe(setListeners, () => {
  document.addEventListener('visibilitychange', () => {
    addLog(`visibility -> ${document.visibilityState}`)
  })
  setListeners('pass', 'watching statechange + visibilitychange; lock the screen or switch apps, then come back')
})

resumeBtn.addEventListener('click', () => {
  void safe(setResume, async () => {
    const c = ctx
    if (!c) {
      setResume('warn', 'tap start audio first')
      return
    }
    const before = c.state as string
    await c.resume()
    addLog(`manual resume: ${before} -> ${c.state as string}`)
    setResume(c.state === 'running' ? 'pass' : 'fail', `resume(): ${before} -> ${c.state as string}`)
  })
})

// ---- 4. MIC -----------------------------------------------------------------

const micEl = section('mic')
const micActions = el('div', 'diag-actions')
micEl.appendChild(micActions)
const micBtn = el('button', undefined, 'test mic')
micActions.appendChild(micBtn)

const setPerm = mkRow(micEl, 'MIC', 'permission state')
const setGum = mkRow(micEl, 'MIC', 'getUserMedia (raw constraints)', 'tap test mic')
const setTrack = mkRow(micEl, 'MIC', 'track settings', 'tap test mic')
const setLevel = mkRow(micEl, 'MIC', 'input level (1s)', 'tap test mic')
const meterEl = el('div', 'diag-meter')
const meterFill = el('div')
meterEl.appendChild(meterFill)
micEl.appendChild(meterEl)

// Permission query WITHOUT prompting (unsupported on older Safari).
void safe(setPerm, async () => {
  if (!('permissions' in navigator)) {
    setPerm('warn', 'navigator.permissions unsupported')
    return
  }
  try {
    const st = await navigator.permissions.query({ name: 'microphone' as PermissionName })
    setPerm('pass', st.state)
    st.addEventListener('change', () => setPerm('pass', st.state))
  } catch (e) {
    setPerm('warn', `microphone query unsupported (${errMsg(e)})`)
  }
})

const runMicTest = async (): Promise<void> => {
  micBtn.disabled = true
  let s: MediaStream | null = null
  try {
    // The app's exact raw-capture constraints (see AudioSession.setMicEnabled).
    s = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    })
    setGum('pass', 'granted')
    addLog('mic granted')
  } catch (e) {
    setGum('fail', errMsg(e))
  }
  if (!s) {
    setTrack('fail', 'no stream')
    setLevel('fail', 'no stream')
    micBtn.disabled = false
    addLog('mic test failed (denied or unavailable)')
    return
  }
  const stream = s
  try {
    await safe(setTrack, () => {
      const track = stream.getAudioTracks()[0]
      if (!track) throw new Error('stream has no audio track')
      const st = track.getSettings()
      const parts = [
        st.sampleRate !== undefined ? `${st.sampleRate} Hz` : 'rate unknown',
        `EC ${st.echoCancellation === undefined ? '?' : String(st.echoCancellation)}`,
        `NS ${st.noiseSuppression === undefined ? '?' : String(st.noiseSuppression)}`,
        `AGC ${st.autoGainControl === undefined ? '?' : String(st.autoGainControl)}`,
      ]
      const detail = `${parts.join(', ')} (${track.label || 'unnamed device'})`
      // The app asks for the true signal; warn when voice-call DSP stuck anyway.
      if (st.echoCancellation === true || st.noiseSuppression === true || st.autoGainControl === true)
        setTrack('warn', `${detail} - raw capture NOT honored`)
      else setTrack('pass', detail)
    })
    await safe(setLevel, async () => {
      const own = ctx === null || ctx.state !== 'running'
      const c = own ? new AudioContext() : ctx!
      try {
        if (own) await c.resume()
        const src = c.createMediaStreamSource(stream)
        const analyser = c.createAnalyser()
        analyser.fftSize = 2048
        src.connect(analyser) // analyser only - mic is never routed to output
        const buf = new Float32Array(analyser.fftSize)
        let peak = 0
        const until = performance.now() + 1000
        while (performance.now() < until) {
          analyser.getFloatTimeDomainData(buf)
          let sum = 0
          for (let i = 0; i < buf.length; i++) sum += buf[i]! * buf[i]!
          const rms = Math.sqrt(sum / buf.length)
          if (rms > peak) peak = rms
          meterFill.style.width = `${Math.min(100, rms * 300)}%`
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        src.disconnect()
        if (peak > 1e-4) setLevel('pass', `peak RMS ${rmsDb(peak)} - samples are flowing`)
        else setLevel('warn', `peak RMS ${rmsDb(peak)} - no signal detected (muted input?)`)
      } finally {
        meterFill.style.width = '0%'
        if (own) c.close().catch(() => {})
      }
    })
  } finally {
    for (const t of stream.getTracks()) t.stop()
    addLog('mic test done, track stopped')
    micBtn.disabled = false
  }
}

micBtn.addEventListener('click', () => void runMicTest())

// ---- 5. TOUCH & PLATFORM ----------------------------------------------------

const touchEl = section('touch and platform')
const touchRow = (name: string): Setter => mkRow(touchEl, 'TOUCH & PLATFORM', name)

{
  const setPointer = touchRow('PointerEvent')
  void safe(setPointer, () => {
    if ('PointerEvent' in window) setPointer('pass', `supported, maxTouchPoints ${navigator.maxTouchPoints}`)
    else setPointer('fail', 'not supported')
  })

  const setTouchAction = touchRow('touch-action CSS')
  void safe(setTouchAction, () => {
    const ok = typeof CSS !== 'undefined' && CSS.supports('touch-action', 'manipulation')
    setTouchAction(ok ? 'pass' : 'warn', ok ? 'supported' : 'not supported - double-tap zoom may fight the UI')
  })

  const setVibrate = touchRow('navigator.vibrate')
  void safe(setVibrate, () => {
    if ('vibrate' in navigator) setVibrate('pass', 'present')
    else setVibrate('warn', 'absent (expected on iOS - app haptics no-op)')
  })

  const setWake = touchRow('screen wake lock')
  void safe(setWake, () => {
    if ('wakeLock' in navigator) setWake('pass', 'API present')
    else setWake('warn', 'absent - screen may sleep during performance')
  })

  const setIdb = touchRow('IndexedDB')
  void safe(setIdb, () => {
    if ('indexedDB' in window && window.indexedDB) setIdb('pass', 'available')
    else setIdb('fail', 'unavailable - project storage broken')
  })

  const setLs = touchRow('localStorage')
  void safe(setLs, () => {
    const key = '__diag_probe__'
    window.localStorage.setItem(key, '1')
    window.localStorage.removeItem(key)
    setLs('pass', 'read/write ok')
  })

  const setMidi = touchRow('Web MIDI')
  void safe(setMidi, () => {
    if ('requestMIDIAccess' in navigator) setMidi('pass', 'API present')
    else setMidi('warn', 'absent (iOS Safari has no Web MIDI)')
  })
}

// ---- copy report ------------------------------------------------------------

const copySection = section('report')
const copyActions = el('div', 'diag-actions')
copySection.appendChild(copyActions)
const copyBtn = el('button', 'primary', 'copy report')
copyActions.appendChild(copyBtn)

copyBtn.addEventListener('click', () => {
  const run = async (): Promise<void> => {
    const text = serializeReport(results, log, {
      generatedAt: new Date().toISOString(),
      url: window.location.href,
    })
    try {
      await navigator.clipboard.writeText(text)
      copyBtn.textContent = 'copied'
      setTimeout(() => (copyBtn.textContent = 'copy report'), 1500)
    } catch {
      // Clipboard blocked (permissions, insecure context): show the text for
      // manual copying instead.
      let ta = copySection.querySelector<HTMLTextAreaElement>('.diag-fallback')
      if (!ta) {
        ta = el('textarea', 'diag-fallback')
        ta.readOnly = true
        copySection.appendChild(ta)
      }
      ta.value = text
      ta.focus()
      ta.select()
    }
  }
  void run()
})

addLog('page loaded')
