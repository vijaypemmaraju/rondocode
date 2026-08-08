/* ------------------------------------------------------------------------- *
 * User settings — small, typed, localStorage-backed preferences surfaced in
 * the Options panel (ui/options.ts). One source of truth: features read a
 * setting with getSetting() and react to changes via onSettingsChange(), and
 * the panel writes them with setSetting(). Unknown/missing keys fall back to
 * DEFAULTS, so adding a setting never breaks an existing stored blob.
 * ------------------------------------------------------------------------- */

export interface Settings {
  /** Inline live-value ⟨readouts⟩ on modulation expressions (editor/probes.ts).
   *  Off by default — opt-in, since it registers engine probes and adds chrome
   *  to the code. */
  liveValues: boolean
  /** LIVE TYPING: while the transport plays, a clean edit applies itself once
   *  typing settles (~0.7s) — no Run needed. Off by default: sound changing
   *  mid-thought should be a choice. */
  liveType: boolean
  /** FORMAT ON NEWLINE: pressing Enter tidies the line the cursor just left
   *  (rondo's line-local rules). Off by default; rondo mode only — prettier
   *  has no reliable single-line mode, so JS newline formatting would mean
   *  reflowing the whole doc on every Enter, which is not acceptable. */
  formatOnNewline: boolean
  /** Preferred CAPTURE device, as a deviceId or a label fragment ('' = let the
   *  OS choose). A label is stored rather than only an id because a deviceId
   *  is an origin-scoped hash that rotates when permissions are cleared —
   *  the name on the box survives that. */
  inputDevice: string
  /** Preferred PLAYBACK device, same form. Applied with setSinkId where the
   *  browser has it; where it does not, the OS default stands. */
  outputDevice: string
}

export const DEFAULTS: Settings = {
  liveValues: false,
  liveType: false,
  formatOnNewline: false,
  inputDevice: '',
  outputDevice: '',
}

/** Human-facing metadata for the Options panel — label + one-line help. */
export const SETTING_META: { [K in keyof Settings]: { label: string; help: string } } = {
  liveValues: {
    label: 'Live value readouts',
    help: 'Show a live ⟨value⟩ after modulation expressions (LFO ranges, envelopes) while playing.',
  },
  liveType: {
    label: 'Live typing',
    help: 'While playing, apply edits automatically shortly after you stop typing — no Run needed. Broken edits change nothing.',
  },
  formatOnNewline: {
    label: 'Format on new line',
    help: 'When you press Enter, tidy the line you just left: indentation, spacing, modifier colons. Rondo only; use the format button or Cmd/Ctrl+Shift+F anytime in either language.',
  },
  inputDevice: {
    label: 'Input device',
    help: 'Which microphone or interface mic() listens to. Blank uses the system default. Device names only appear once you have granted microphone permission at least once.',
  },
  outputDevice: {
    label: 'Output device',
    help: 'Where audio plays. Blank uses the system default. Not every browser can route output; where it cannot, the system default is used.',
  },
}

const KEY = 'rondocode-settings'

let current: Settings = load()
const listeners = new Set<(s: Settings) => void>()

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw === null) return { ...DEFAULTS }
    const parsed = JSON.parse(raw) as Partial<Settings>
    // merge over defaults: only known keys, right types
    const out = { ...DEFAULTS }
    for (const k of Object.keys(DEFAULTS) as (keyof Settings)[]) {
      if (typeof parsed[k] === typeof DEFAULTS[k]) (out[k] as unknown) = parsed[k]
    }
    return out
  } catch {
    return { ...DEFAULTS }
  }
}

/** The current settings snapshot (do not mutate — use setSetting). */
export const getSettings = (): Readonly<Settings> => current

export const getSetting = <K extends keyof Settings>(k: K): Settings[K] => current[k]

/** Update one setting, persist, and notify subscribers (no-op if unchanged). */
export function setSetting<K extends keyof Settings>(k: K, value: Settings[K]): void {
  if (current[k] === value) return
  current = { ...current, [k]: value }
  try {
    localStorage.setItem(KEY, JSON.stringify(current))
  } catch {
    /* private mode / quota — settings just won't persist */
  }
  for (const fn of listeners) {
    try {
      fn(current)
    } catch (e) {
      console.warn('[settings] listener failed', e)
    }
  }
}

/** Subscribe to any settings change; fires with the full snapshot. Returns an
 *  unsubscribe. Does NOT replay — call getSettings() for the initial state. */
export function onSettingsChange(fn: (s: Settings) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
