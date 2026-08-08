/* ------------------------------------------------------------------------- *
 * AUDIO DEVICE CHOICE — one resolution, one precedence, one place.
 *
 * A device can be asked for from two directions: an app SETTING (persisted,
 * "this is my rig") and the CODE (`mic device:"Scarlett"`, "this project
 * needs that input"). Two sources of truth for one decision is the bug shape
 * this repo has been bitten by more than any other, so the precedence is
 * stated once, here, and every caller goes through `resolveDevice`:
 *
 *     code override  →  saved setting  →  OS default
 *
 * AND IT NEVER FAILS SILENTLY. A project pinned to hardware that is not in
 * the room is the obvious way this hurts someone on stage: it would quietly
 * open the laptop mic and sound wrong with nothing on screen to explain it.
 * So the result carries `reason` and `fellBackFrom` — the UI is expected to
 * say "asked for Scarlett, using MacBook Pro Microphone".
 *
 * MATCHING IS BY LABEL AS WELL AS ID, deliberately. A `deviceId` is a hash
 * scoped to the origin and rotates when permissions are cleared, so a device
 * id written into a document is worthless a week later. A human writes
 * `device:"Scarlett"` and means the thing with that on the box.
 * ------------------------------------------------------------------------- */

/** The subset of MediaDeviceInfo this module needs — a plain shape, so the
 *  resolution logic is testable without a browser. */
export interface DeviceInfo {
  deviceId: string
  label: string
  kind: 'audioinput' | 'audiooutput'
}

export type DeviceReason =
  /** the code asked for it by name and it is here */
  | 'code'
  /** the saved setting picked it */
  | 'setting'
  /** nothing asked, or nothing asked for was here — the OS decides */
  | 'default'

export interface DeviceChoice {
  /** the id to hand to getUserMedia / setSinkId; undefined = let the OS pick. */
  deviceId?: string
  /** label of the chosen device, when one was actually matched. */
  label?: string
  reason: DeviceReason
  /** set when something WAS asked for and could not be found — the string the
   *  caller asked for, so the UI can say what it did instead of what it was
   *  told. Never let this be silent. */
  fellBackFrom?: string
}

/** Case/space-insensitive contains, so `device:"scarlett"` matches
 *  "Scarlett 2i2 USB (1234:5678)" — a label is a human thing, not an id. */
const matches = (d: DeviceInfo, want: string): boolean => {
  if (d.deviceId === want) return true
  const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim()
  const w = norm(want)
  return w !== '' && norm(d.label).includes(w)
}

/**
 * Pick a device, given what the code asked for and what the setting says.
 *
 * `available` is the enumerated list already filtered to one kind. Both
 * `requested` and `saved` may be an id or a label fragment.
 */
export function resolveDevice(
  requested: string | undefined,
  saved: string | undefined,
  available: readonly DeviceInfo[],
): DeviceChoice {
  // the code wins when it asked for something that is actually here
  if (requested !== undefined && requested !== '') {
    const hit = available.find((d) => matches(d, requested))
    if (hit !== undefined) return { deviceId: hit.deviceId, label: hit.label, reason: 'code' }
    // asked for and absent: fall through, but REMEMBER, so the UI can say so
    const viaSetting = saved === undefined ? undefined : available.find((d) => matches(d, saved))
    return viaSetting !== undefined
      ? { deviceId: viaSetting.deviceId, label: viaSetting.label, reason: 'setting', fellBackFrom: requested }
      : { reason: 'default', fellBackFrom: requested }
  }
  if (saved !== undefined && saved !== '') {
    const hit = available.find((d) => matches(d, saved))
    if (hit !== undefined) return { deviceId: hit.deviceId, label: hit.label, reason: 'setting' }
    // a saved device that has been unplugged is the COMMON case, not an error
    return { reason: 'default', fellBackFrom: saved }
  }
  return { reason: 'default' }
}

/** A one-line explanation of a choice, or null when there is nothing worth
 *  saying (it simply used what you asked for). The UI shows this; a fallback
 *  that nobody is told about is the failure this module exists to prevent. */
export function explainChoice(c: DeviceChoice, kind: 'input' | 'output'): string | null {
  if (c.fellBackFrom === undefined) return null
  const to = c.label ?? 'the system default'
  return `${kind}: “${c.fellBackFrom}” is not connected — using ${to}.`
}

/* ---- the latency budget, reported rather than guessed ---------------------- */

export interface LatencyReport {
  /** Web Audio's own output buffer, ms. */
  baseMs: number
  /** what the OS/device adds on the way out, ms (0 when unreported). */
  outputMs: number
  /** the capture side, ms (0 when the track does not report it). */
  inputMs: number
  /** one render quantum at this rate, ms — the engine's own contribution. */
  quantumMs: number
  /** everything above: what a performer actually feels. */
  roundTripMs: number
}

/** BLOCK is 128 frames and equals the Web Audio render quantum, so the engine
 *  adds exactly one quantum and no buffering of its own. */
export const RENDER_QUANTUM = 128

export function latencyReport(
  sampleRate: number,
  baseLatencySec: number,
  outputLatencySec: number,
  inputLatencySec: number,
): LatencyReport {
  const ms = (s: number): number => (Number.isFinite(s) && s > 0 ? s * 1000 : 0)
  const quantumMs = (RENDER_QUANTUM / sampleRate) * 1000
  const baseMs = ms(baseLatencySec)
  const outputMs = ms(outputLatencySec)
  const inputMs = ms(inputLatencySec)
  return {
    baseMs,
    outputMs,
    inputMs,
    quantumMs,
    roundTripMs: baseMs + outputMs + inputMs + quantumMs,
  }
}

/** How a round trip FEELS to someone monitoring themselves. Vocalists are the
 *  strictest case — they also hear themselves by bone conduction, so the
 *  delayed copy is compared against an instant one. */
export function latencyVerdict(roundTripMs: number): 'tight' | 'usable' | 'distracting' {
  if (roundTripMs <= 12) return 'tight'
  if (roundTripMs <= 25) return 'usable'
  return 'distracting'
}
