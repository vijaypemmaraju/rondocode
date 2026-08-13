/* ------------------------------------------------------------------------- *
 * MIDI monitor: what actually arrived, from which device.
 *
 * Reported by a user whose two controllers were DETECTED and whose notes never
 * played. There was no way to tell, from inside the app, which of the several
 * things that could have been true was true: whether the port delivered
 * anything at all, whether the messages were on a channel or of a kind the app
 * ignores, or whether they arrived fine and were dropped later for want of a
 * running synth. Every one of those looks identical from the outside -- silence.
 *
 * So this logs EVERY message, before any of the app's own routing, and says
 * which port it came from. A dropped note now reads as a line that arrived and
 * a reason it went nowhere, rather than as nothing happening.
 *
 * Pure: no DOM and no Web MIDI, so the decoding is testable by handing it
 * bytes. The editor layer owns the view.
 *
 * CLOCK IS COUNTED, NOT LISTED. A running clock is 24 messages per beat, which
 * at 120bpm is 48 a second -- enough to push a note-on out of a hundred-row log
 * before anyone can read it. Turning the interesting events into an unreadable
 * flood is how a monitor stops being a lifesaver.
 * ------------------------------------------------------------------------- */

/** One decoded message, ready to render. */
export interface MidiLine {
  /** the port it arrived on */
  device: string
  /** `note on`, `cc`, `pitch bend`, … */
  kind: string
  /** the human-readable body: `C3 (60) vel 100` */
  detail: string
  /** 1-16, or 0 for a system message that carries no channel */
  channel: number
  /** the bytes, as hex */
  raw: string
  /** true for clock/active-sense: counted rather than listed */
  noisy: boolean
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

/** MIDI note number as a name a musician reads: 60 is C3 here, matching the
 *  note numbering the rest of the app uses. */
export const noteLabel = (n: number): string =>
  `${NOTE_NAMES[((n % 12) + 12) % 12]!}${Math.floor(n / 12) - 1}`

const hex = (data: Uint8Array): string =>
  Array.from(data, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ')

/** System messages, by status byte. */
const SYSTEM: Record<number, { kind: string; noisy?: boolean }> = {
  0xf0: { kind: 'sysex' },
  0xf1: { kind: 'time code' },
  0xf2: { kind: 'song position' },
  0xf3: { kind: 'song select' },
  0xf6: { kind: 'tune request' },
  0xf7: { kind: 'sysex end' },
  0xf8: { kind: 'clock', noisy: true },
  0xfa: { kind: 'start' },
  0xfb: { kind: 'continue' },
  0xfc: { kind: 'stop' },
  0xfe: { kind: 'active sensing', noisy: true },
  0xff: { kind: 'reset' },
}

/**
 * Decode one message for display.
 *
 * Total: anything unrecognised still produces a line with its bytes, because a
 * monitor that silently drops what it does not understand is the same problem
 * it was built to solve.
 */
export function describeMidi(device: string, data: Uint8Array): MidiLine {
  const raw = hex(data)
  const status = data[0] ?? 0
  const base = { device, raw, channel: 0, noisy: false }
  if (status >= 0xf0) {
    const sys = SYSTEM[status]
    return sys === undefined
      ? { ...base, kind: 'system', detail: '' }
      : { ...base, kind: sys.kind, detail: '', noisy: sys.noisy === true }
  }
  const channel = (status & 0x0f) + 1
  const a = data[1] ?? 0
  const b = data[2] ?? 0
  switch (status & 0xf0) {
    case 0x80:
      return { ...base, kind: 'note off', detail: `${noteLabel(a)} (${a})`, channel }
    case 0x90:
      // velocity 0 IS a note off, and a controller that sends them this way
      // would otherwise read as a stuck note in the log
      return b === 0
        ? { ...base, kind: 'note off', detail: `${noteLabel(a)} (${a}) vel 0`, channel }
        : { ...base, kind: 'note on', detail: `${noteLabel(a)} (${a}) vel ${b}`, channel }
    case 0xa0:
      return { ...base, kind: 'aftertouch', detail: `${noteLabel(a)} ${b}`, channel }
    case 0xb0:
      return { ...base, kind: 'cc', detail: `#${a} = ${b}`, channel }
    case 0xc0:
      return { ...base, kind: 'program', detail: `#${a}`, channel }
    case 0xd0:
      return { ...base, kind: 'pressure', detail: `${a}`, channel }
    case 0xe0:
      // 14-bit, LSB first, centred at 8192
      return { ...base, kind: 'pitch bend', detail: `${(b << 7 | a) - 8192}`, channel }
    default:
      return { ...base, kind: 'unknown', detail: '', channel }
  }
}

/** How many lines the log keeps. Enough to hold a chord plus the knob move
 *  that preceded it; small enough that the DOM stays cheap while a controller
 *  is being wiggled. */
export const MONITOR_MAX = 100

/**
 * The rolling log, as data.
 *
 * Separate from the view so "what does the monitor show" is a question with an
 * answer that does not need a browser.
 */
export class MidiMonitor {
  private lines: MidiLine[] = []
  private clocks = 0
  /** Ports seen delivering at least one message, which is the real answer to
   *  "is this device connected" -- a port can enumerate and never send. */
  readonly speaking = new Set<string>()

  add(line: MidiLine): void {
    this.speaking.add(line.device)
    if (line.noisy) {
      this.clocks++
      return
    }
    this.lines.push(line)
    if (this.lines.length > MONITOR_MAX) this.lines.splice(0, this.lines.length - MONITOR_MAX)
  }

  /** Newest first: the thing you just did is the thing you want to read. */
  recent(): readonly MidiLine[] {
    return [...this.lines].reverse()
  }

  /** Clock/active-sense messages folded away, for the counter line. */
  noisyCount(): number {
    return this.clocks
  }

  clear(): void {
    this.lines = []
    this.clocks = 0
    this.speaking.clear()
  }
}
