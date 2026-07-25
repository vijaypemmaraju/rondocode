/* Mic sampling: record a sound on the device microphone and load it into the
 * engine as a named sample — beatbox a kick, sing a note, tap a glass, then
 * play it from a `beat`/`play` block like any other sample.
 *
 * Capture uses MediaRecorder (compressed) and decodes through the
 * AudioContext, the same path file loading takes. The recording is then
 * downmixed to mono, TRIMMED (a phone recording starts with a tap and ends
 * with silence) and NORMALIZED, so what lands in the engine plays like an
 * instrument, not like a voice memo. */

/** Downmix an AudioBuffer to mono. */
export function toMono(buf: { numberOfChannels: number; length: number; getChannelData(c: number): Float32Array }): Float32Array {
  const n = buf.length
  const mono = new Float32Array(n)
  const chans = buf.numberOfChannels
  for (let c = 0; c < chans; c++) {
    const ch = buf.getChannelData(c)
    for (let i = 0; i < n; i++) mono[i]! += ch[i]!
  }
  if (chans > 1) for (let i = 0; i < n; i++) mono[i]! /= chans
  return mono
}

/** Trim leading/trailing silence below `threshold`, keeping `preRollFrames`
 *  before the first crossing so soft attacks survive. Returns the original
 *  buffer when nothing crosses the threshold (an all-quiet take is kept
 *  as-is rather than trimmed to nothing). Pure. */
export function trimSilence(data: Float32Array, threshold = 0.02, preRollFrames = 256): Float32Array {
  let first = -1
  let last = -1
  for (let i = 0; i < data.length; i++) {
    if (Math.abs(data[i]!) >= threshold) {
      if (first < 0) first = i
      last = i
    }
  }
  if (first < 0) return data
  const from = Math.max(0, first - preRollFrames)
  const to = Math.min(data.length, last + preRollFrames)
  return data.slice(from, to)
}

/** Normalize peak to `target` (default 0.9). Quiet phone takes come up to
 *  instrument level; an already-hot take only comes DOWN. Pure, in place. */
export function normalize(data: Float32Array, target = 0.9): Float32Array {
  let peak = 0
  for (let i = 0; i < data.length; i++) {
    const a = Math.abs(data[i]!)
    if (a > peak) peak = a
  }
  if (peak <= 1e-6) return data
  const g = target / peak
  for (let i = 0; i < data.length; i++) data[i]! *= g
  return data
}

/** First free micN name against the existing sample names. Pure. */
export function nextMicName(existing: readonly string[]): string {
  const taken = new Set(existing)
  for (let i = 1; ; i++) {
    const name = `mic${i}`
    if (!taken.has(name)) return name
  }
}

export interface MicRecording {
  /** stop capturing and resolve the processed mono PCM. */
  stop(): Promise<{ data: Float32Array; sampleRate: number }>
  /** abandon the take (permission UI closed, popover dismissed, …). */
  cancel(): void
}

/** Start a mic recording. Throws (rejects) if the user denies the mic or the
 *  browser lacks support; the caller shows the message. */
export async function startMicRecording(decode: (bytes: ArrayBuffer) => Promise<AudioBuffer>): Promise<MicRecording> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      // capture the sound itself: phone "voice call" DSP smears transients
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  })
  const rec = new MediaRecorder(stream)
  const chunks: Blob[] = []
  rec.addEventListener('dataavailable', (e) => {
    if (e.data.size > 0) chunks.push(e.data)
  })
  rec.start()
  const teardown = (): void => {
    for (const t of stream.getTracks()) t.stop()
  }
  return {
    stop: () =>
      new Promise((resolve, reject) => {
        rec.addEventListener('stop', () => {
          teardown()
          void (async () => {
            try {
              const blob = new Blob(chunks, { type: rec.mimeType })
              const buf = await decode(await blob.arrayBuffer())
              const mono = normalize(trimSilence(toMono(buf)))
              resolve({ data: mono, sampleRate: buf.sampleRate })
            } catch (e) {
              reject(e instanceof Error ? e : new Error(String(e)))
            }
          })()
        })
        try {
          rec.stop()
        } catch (e) {
          teardown()
          reject(e instanceof Error ? e : new Error(String(e)))
        }
      }),
    cancel: () => {
      try {
        rec.stop()
      } catch {
        // already stopped
      }
      teardown()
    },
  }
}
