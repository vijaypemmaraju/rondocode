/* ------------------------------------------------------------------------- *
 * MIDI CC -> param mapping: the performer's knobs.
 *
 * A hardware control is bound by LEARNING: the user picks a param, arms learn,
 * and the next control-change message that arrives claims it. From then on that
 * (channel, cc) drives that synth param, scaled onto the param's own declared
 * range and curve.
 *
 * This module is PURE: no DOM, no Web MIDI, no storage object of its own. The
 * thin editor layer (editor/midi.ts) feeds it parsed messages and supplies the
 * three seams it needs (hold / release / lookup), so every rule below is
 * testable by simulating messages.
 *
 * DESIGN NOTES
 *
 * - ONE CONTROL, ONE PARAM, BOTH WAYS. Learning (ch, cc) for a param drops any
 *   other mapping of that same (ch, cc) AND any other mapping of that same
 *   param. A knob that silently drove two things, or a param tugged by two
 *   knobs, is a rig you cannot reason about mid-set.
 *
 * - HOLDING IS STICKY. A finger on a widget is a gesture with an end; a knob is
 *   not. So a CC hold is taken on the first message and kept until the mapping
 *   is removed (or MIDI is switched off). That is what makes a mapped knob feel
 *   like the filter knob on a mixer: the pattern's own `.ctrl` sweep for that
 *   param stays out of the way for as long as the knob owns it. Holds are
 *   owner-scoped in the Session, so a finger drag on the same param takes the
 *   value while it lasts and hands it straight back to the knob on release
 *   rather than handing it back to the sequencer.
 *
 * - STALE MAPPINGS SURVIVE. Live-coding renames and deletes synths constantly,
 *   and a rig is persisted across reloads, so a mapping naming a param that is
 *   not in the current document is NORMAL. It is kept, shown as stale, and its
 *   messages are dropped. Rewriting the synth back makes it live again.
 *
 * - RESOLUTION. Control changes are 7-bit (128 steps). Controllers that send
 *   high resolution do it as an MSB on cc n (0..31) immediately followed by an
 *   LSB on cc n+32; that pairing is honoured when, and only when, the LSB's own
 *   controller number is not itself mapped and the MSB landed within
 *   PAIR_WINDOW_MS. Devices that use 32..63 as ordinary independent knobs (most
 *   of them) are therefore never misread.
 * ------------------------------------------------------------------------- */

/** One learned binding. `channel` is 0..15 as it appears on the wire. */
export interface CcMapping {
  channel: number
  cc: number
  synth: string
  param: string
}

/** What a value needs to be scaled: the param's declared range and curve. */
export interface ParamRange {
  min: number
  max: number
  curve?: 'lin' | 'log'
}

/** A parsed control-change message. */
export interface CcMessage {
  channel: number
  cc: number
  value: number
}

/** A mapping decorated for display: `stale` when its param is not in the
 *  current document. */
export interface MappingRow extends CcMapping {
  stale: boolean
}

/** Controller numbers 120..127 are Channel Mode messages (all notes off, local
 *  control, mono/poly), not knobs. They are never learned and never routed. */
export const MIN_MODE_CC = 120

/** How long after an MSB an LSB on cc+32 still counts as its partner. Two
 *  bytes of the same physical turn arrive back to back, so this is generous. */
export const PAIR_WINDOW_MS = 20

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

/** Normalized position (0..1) onto the param's own range and curve. A log
 *  param sweeps by RATIO, so equal turns of the knob are equal musical
 *  intervals; log falls back to linear if the range is not strictly positive
 *  (the engine rejects such a param anyway, but a stored mapping must not
 *  produce NaN). Endpoints are exact: t=0 is min, t=1 is max. */
export const normToValue = (t: number, range: ParamRange): number => {
  const u = clamp(t, 0, 1)
  const { min, max } = range
  if (range.curve === 'log' && min > 0 && max > 0) {
    if (u === 0) return min
    if (u === 1) return max
    return min * (max / min) ** u
  }
  return min + (max - min) * u
}

/** 7-bit control change (0..127) onto a param value. */
export const ccToValue = (cc: number, range: ParamRange): number =>
  normToValue(clamp(cc, 0, 127) / 127, range)

/** 14-bit MSB/LSB pair (0..16383) onto a param value. */
export const cc14ToValue = (v: number, range: ParamRange): number =>
  normToValue(clamp(v, 0, 16383) / 16383, range)

/** Parse a raw MIDI message as a control change, or undefined when it is
 *  anything else (note, clock, channel mode). */
export const parseCc = (data: ArrayLike<number> | null | undefined): CcMessage | undefined => {
  if (!data || data.length < 3) return undefined
  const status = data[0]!
  if ((status & 0xf0) !== 0xb0) return undefined
  const cc = data[1]!
  if (cc >= MIN_MODE_CC) return undefined
  return { channel: status & 0x0f, cc, value: data[2]! }
}

/* ---- persistence ---------------------------------------------------------- *
 * Mappings describe the HARDWARE IN FRONT OF YOU, not the tune: they are
 * per-project but device-local, exactly like the active-project pointer and
 * the language preference, so they live in localStorage rather than in the
 * IndexedDB project record (which syncs out through export/share links, where
 * one person's controller layout is noise). The read is tolerant by design: a
 * corrupt or half-written entry drops out rather than taking the rig down. */

/** The minimal storage surface, so tests can pass a plain object. */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export const MAPPINGS_KEY_PREFIX = 'rondocode-midi-cc:'

export const mappingsKey = (projectId: string): string => `${MAPPINGS_KEY_PREFIX}${projectId}`

const isMapping = (v: unknown): v is CcMapping => {
  if (typeof v !== 'object' || v === null) return false
  const m = v as Record<string, unknown>
  return (
    typeof m.channel === 'number' && Number.isInteger(m.channel) && m.channel >= 0 && m.channel <= 15 &&
    typeof m.cc === 'number' && Number.isInteger(m.cc) && m.cc >= 0 && m.cc < MIN_MODE_CC &&
    typeof m.synth === 'string' && m.synth.length > 0 &&
    typeof m.param === 'string' && m.param.length > 0
  )
}

/** Decode a stored rig. Never throws: bad JSON reads as an empty rig, and
 *  individual malformed entries are dropped. */
export const parseMappings = (raw: string | null | undefined): CcMapping[] => {
  if (raw === null || raw === undefined || raw === '') return []
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(data)) return []
  return data.filter(isMapping).map((m) => ({ channel: m.channel, cc: m.cc, synth: m.synth, param: m.param }))
}

export const serializeMappings = (mappings: readonly CcMapping[]): string =>
  JSON.stringify(mappings.map((m) => ({ channel: m.channel, cc: m.cc, synth: m.synth, param: m.param })))

export const loadMappings = (storage: StorageLike, projectId: string): CcMapping[] => {
  try {
    return parseMappings(storage.getItem(mappingsKey(projectId)))
  } catch {
    return [] // storage blocked (private mode): the rig just does not persist
  }
}

export const saveMappings = (storage: StorageLike, projectId: string, mappings: readonly CcMapping[]): void => {
  try {
    if (mappings.length === 0) storage.removeItem(mappingsKey(projectId))
    else storage.setItem(mappingsKey(projectId), serializeMappings(mappings))
  } catch {
    // storage blocked: the live rig still works, it just will not survive a reload
  }
}

/* ---- the router ----------------------------------------------------------- */

/** What handle() did, so callers (and tests) can see the decision. */
export type CcOutcome =
  /** the armed learn state claimed this control */
  | 'learned'
  /** a mapped control drove its param */
  | 'applied'
  /** a mapped control whose param is not in the current document */
  | 'stale'
  /** an LSB that refined the previous MSB rather than acting on its own */
  | 'refined'
  /** nothing is mapped to this control */
  | 'ignored'

export interface CcRouterOpts {
  /** Take/keep the param at `value` (Session.holdParam with the midi owner). */
  hold(synth: string, param: string, value: number): void
  /** Give the param back (unmap, or MIDI switched off). */
  release(synth: string, param: string): void
  /** The param's declared range, or undefined when it is not in the current
   *  document (the mapping is then stale). */
  lookup(synth: string, param: string): ParamRange | undefined
  /** Fired whenever the mapping list or the learn state changed, so the UI can
   *  redraw and the caller can persist. */
  onChange?(): void
  /** Injectable clock for the MSB/LSB pairing window (default Date.now). */
  now?(): number
}

const sameControl = (a: CcMapping, channel: number, cc: number): boolean =>
  a.channel === channel && a.cc === cc

export class CcRouter {
  private list: CcMapping[] = []
  private armed: { synth: string; param: string } | undefined
  /** Last MSB seen per `channel:cc`, for the 14-bit pairing window. */
  private readonly lastMsb = new Map<string, { value: number; at: number }>()
  /** Params this router currently holds, so releasing is exact. */
  private readonly held = new Set<string>()
  private readonly now: () => number

  constructor(private readonly opts: CcRouterOpts) {
    this.now = opts.now ?? (() => Date.now())
  }

  mappings(): readonly CcMapping[] {
    return this.list
  }

  /** The mapping list decorated with liveness, for rendering. */
  rows(): MappingRow[] {
    return this.list.map((m) => ({ ...m, stale: this.opts.lookup(m.synth, m.param) === undefined }))
  }

  /** Replace the whole rig (loading a project). Releases everything the old
   *  rig held: those params belong to the previous document. */
  setMappings(mappings: readonly CcMapping[]): void {
    this.releaseHeld()
    this.list = mappings.map((m) => ({ ...m }))
    this.lastMsb.clear()
    this.opts.onChange?.()
  }

  /** The param waiting for a control, or undefined when learn is not armed. */
  learning(): { synth: string; param: string } | undefined {
    return this.armed
  }

  /** Arm learn for a param: the next control change claims it. Arming while
   *  already armed just retargets. */
  arm(synth: string, param: string): void {
    this.armed = { synth, param }
    this.opts.onChange?.()
  }

  cancelLearn(): void {
    if (this.armed === undefined) return
    this.armed = undefined
    this.opts.onChange?.()
  }

  /** Drop the mapping on this control and hand its param back. */
  unmap(channel: number, cc: number): void {
    const i = this.list.findIndex((m) => sameControl(m, channel, cc))
    if (i < 0) return
    const [gone] = this.list.splice(i, 1)
    this.releaseOne(gone!)
    this.opts.onChange?.()
  }

  /** Hand every held param back (MIDI disabled, or the router is torn down).
   *  The mappings themselves are kept: turning MIDI back on resumes the rig. */
  releaseHeld(): void {
    for (const key of this.held) {
      const dot = key.indexOf('\u0000')
      this.opts.release(key.slice(0, dot), key.slice(dot + 1))
    }
    this.held.clear()
  }

  /**
   * Route one control change. Returns what happened (see CcOutcome).
   *
   * Order matters: an ARMED learn claims the control before any existing
   * mapping gets to act on it, so learning onto a knob that is already bound
   * elsewhere rebinds it instead of moving the old param on the way past.
   */
  handle(msg: CcMessage): CcOutcome {
    const { channel, cc, value } = msg
    if (cc >= MIN_MODE_CC) return 'ignored'
    if (this.armed !== undefined) {
      this.bind(channel, cc, this.armed.synth, this.armed.param)
      this.armed = undefined
      this.opts.onChange?.()
      return 'learned'
    }

    const own = this.list.find((m) => sameControl(m, channel, cc))

    // 14-bit refinement: an LSB (32..63) with no mapping of its own, arriving
    // inside the pairing window after its MSB partner, is the low half of that
    // MSB's value rather than a control in its own right.
    if (own === undefined && cc >= 32 && cc <= 63) {
      const msbCc = cc - 32
      const msb = this.lastMsb.get(`${channel}:${msbCc}`)
      const partner = this.list.find((m) => sameControl(m, channel, msbCc))
      if (msb !== undefined && partner !== undefined && this.now() - msb.at <= PAIR_WINDOW_MS) {
        const range = this.opts.lookup(partner.synth, partner.param)
        if (range === undefined) return 'stale'
        this.apply(partner, cc14ToValue(msb.value * 128 + value, range))
        return 'refined'
      }
    }

    if (cc <= 31) this.lastMsb.set(`${channel}:${cc}`, { value, at: this.now() })
    if (own === undefined) return 'ignored'
    const range = this.opts.lookup(own.synth, own.param)
    if (range === undefined) return 'stale'
    this.apply(own, ccToValue(value, range))
    return 'applied'
  }

  /** Bind a control to a param, evicting both sides of the one-to-one rule. */
  private bind(channel: number, cc: number, synth: string, param: string): void {
    for (const m of this.list) {
      if (sameControl(m, channel, cc) || (m.synth === synth && m.param === param)) this.releaseOne(m)
    }
    this.list = this.list.filter(
      (m) => !sameControl(m, channel, cc) && !(m.synth === synth && m.param === param),
    )
    this.list.push({ channel, cc, synth, param })
  }

  private apply(m: CcMapping, value: number): void {
    this.held.add(`${m.synth}\u0000${m.param}`)
    this.opts.hold(m.synth, m.param, value)
  }

  private releaseOne(m: CcMapping): void {
    const key = `${m.synth}\u0000${m.param}`
    if (!this.held.delete(key)) return
    this.opts.release(m.synth, m.param)
  }
}
