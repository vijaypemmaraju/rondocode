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
}

export const DEFAULTS: Settings = {
  liveValues: false,
}

/** Human-facing metadata for the Options panel — label + one-line help. */
export const SETTING_META: { [K in keyof Settings]: { label: string; help: string } } = {
  liveValues: {
    label: 'Live value readouts',
    help: 'Show a live ⟨value⟩ after modulation expressions (LFO ranges, envelopes) while playing.',
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
