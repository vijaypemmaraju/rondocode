import { parseMidi, midiCps, midiNotesToVoices } from '@rondocode/pattern'
import type { MidiTrack, MidiNote } from '@rondocode/pattern'

/* Deterministic MIDI -> editable rondocode source. The parser reads tempo, time
 * signature and note timing exactly; this layer picks a synth per track and
 * emits mini-notation (held notes via `@` weights, chords via voice-split into
 * stacked monophonic lines). The result is ordinary rondocode you can edit —
 * nothing here is guessed beyond the grid resolution (stepsPerBeat). */

/** Canonical instrument type per track -> the synth `sound` name it routes to. */
type SynthType = 'bass' | 'keys' | 'pad' | 'flute' | 'gtr' | 'vox' | 'lead' | 'stab'

/** Reusable synth definitions (kept close to the hand-tuned veldt palette). */
const SYNTHS: Record<SynthType | 'kick' | 'snare' | 'hat' | 'clap', string> = {
  stab: `const stab = synth(({ note, gate, adsr, saw, svf, lfo }) => {
  const env = adsr(gate, { a: 0.002, d: 0.16, s: 0.15, r: 0.09 })
  const f = note.freq
  const osc = saw(f).mix(saw(f.mul(1.004)), 0.5).mix(saw(f.mul(2)), 0.34)
  const cut = env.range(0.5, 1).mul(lfo(0.07).range(6600, 8800))
  return svf(osc, cut, { res: 0.42 }).mul(env).mul(0.2)
}, ({ input, chorus, reverb, compress }) => {
  const w = chorus(input, { rate: 0.5, depth: 0.003, mix: 0.35 })
  const wet = w.mix(reverb(w, { roomSize: 0.86, damp: 0.3 }), 0.32)
  return compress(wet, { threshold: -20, ratio: 3, attack: 8, release: 120, makeup: 3 })
}, { unison: 5, detune: 12, spread: 0.8, voices: 18 })`,
  bass: `const bass = synth(({ note, gate, adsr, saw, sine, svf }) => {
  const env = adsr(gate, { a: 0.006, d: 0.18, s: 0.75, r: 0.1 })
  const f = note.freq
  const osc = saw(f).mix(sine(f.mul(0.5)), 0.5)
  return svf(osc, env.range(0.3, 1).mul(1600), { res: 0.2 }).mul(env).mul(0.5)
}, ({ input }) => input, { voices: 8 })`,
  keys: `const keys = synth(({ note, gate, adsr, tri, sine, svf }) => {
  const env = adsr(gate, { a: 0.004, d: 0.55, s: 0.14, r: 0.35 })
  const f = note.freq
  const osc = tri(f).mix(sine(f.mul(2)), 0.28)
  const tone = svf(osc, env.range(0.3, 1).mul(3800), { res: 0.2 })
  return svf(tone, 160, { mode: 'hp' }).mul(env).mul(0.4)
}, ({ input, reverb }) => input.mix(reverb(input, { roomSize: 0.82, damp: 0.4 }), 0.26), { voices: 16 })`,
  pad: `const pad = synth(({ note, gate, adsr, saw, svf, lfo }) => {
  const env = adsr(gate, { a: 0.5, d: 0.8, s: 0.9, r: 1.6 })
  const f = note.freq
  const osc = saw(f).mix(saw(f.mul(1.004)), 0.5).mix(saw(f.mul(2.002)), 0.16)
  const lo = svf(osc, lfo(0.05).range(700, 2200), { res: 0.14 })
  return svf(lo, 150, { mode: 'hp' }).mul(env).mul(0.13)
}, ({ input, chorus, reverb }) => {
  const w = chorus(input, { rate: 0.35, depth: 0.005, mix: 0.5 })
  return w.mix(reverb(w, { roomSize: 0.92, damp: 0.4 }), 0.42)
}, { unison: 7, detune: 13, spread: 0.9, voices: 24 })`,
  flute: `const flute = synth(({ note, gate, adsr, sine, tri, noise, svf }) => {
  const env = adsr(gate, { a: 0.05, d: 0.18, s: 0.8, r: 0.28 })
  const f = note.freq
  const osc = sine(f).mix(tri(f), 0.14)
  const breath = svf(noise(), f.mul(2), { mode: 'bp', res: 0.4 }).mul(0.05)
  return osc.add(breath).mul(env).mul(0.4)
}, ({ input, reverb }) => input.mix(reverb(input, { roomSize: 0.9, damp: 0.4 }), 0.4), { voices: 6 })`,
  gtr: `const gtr = synth(({ note, gate, adsr, saw, tri, svf }) => {
  const env = adsr(gate, { a: 0.003, d: 0.4, s: 0.1, r: 0.2 })
  const f = note.freq
  const osc = saw(f).mix(tri(f), 0.4)
  return svf(osc, env.range(0.4, 1).mul(3200), { res: 0.25 }).mul(env).mul(0.34)
}, ({ input, chorus, reverb }) => {
  const w = chorus(input, { rate: 0.4, depth: 0.003, mix: 0.3 })
  return w.mix(reverb(w, { roomSize: 0.8, damp: 0.4 }), 0.25)
}, { voices: 12 })`,
  vox: `const vox = synth(({ note, gate, adsr, saw, tri, svf, lfo, noise }) => {
  const env = adsr(gate, { a: 0.05, d: 0.22, s: 0.72, r: 0.32 })
  const vib = lfo(5).mul(note.freq.mul(0.012))
  const f = note.freq.add(vib)
  const osc = saw(f).mix(tri(f), 0.5)
  const formant = svf(osc, 850, { mode: 'bp', res: 0.6 }).add(svf(osc, 2100, { mode: 'bp', res: 0.5 }).mul(0.5))
  const breath = svf(noise(), 2600, { mode: 'bp', res: 0.5 }).mul(0.04)
  return svf(formant.add(breath), 150, { mode: 'hp' }).mul(env).mul(0.5)
}, ({ input, chorus, delay, reverb }) => {
  const w = chorus(input, { rate: 0.5, depth: 0.004, mix: 0.3 })
  const ech = w.add(delay(w, 0.24, 0.28).mul(0.28))
  return ech.mix(reverb(ech, { roomSize: 0.9, damp: 0.35 }), 0.34)
}, { unison: 2, detune: 6, spread: 0.5, voices: 8 })`,
  lead: `const lead = synth(({ note, gate, adsr, saw, svf }) => {
  const env = adsr(gate, { a: 0.003, d: 0.16, s: 0.3, r: 0.1 })
  const f = note.freq
  const osc = saw(f).mix(saw(f.mul(1.005)), 0.5)
  return svf(osc, env.range(0.4, 1).mul(4200), { res: 0.3 }).mul(env).mul(0.4)
}, ({ input, delay, reverb }) => {
  const w = input.add(delay(input, 0.24, 0.3).mul(0.3))
  return w.mix(reverb(w, { roomSize: 0.85, damp: 0.3 }), 0.18)
}, { unison: 2, detune: 8, voices: 8 })`,
  kick: `const kick = synth(({ gate, adsr, sine, noise, svf, compress }) => {
  const pitch = adsr(gate, { a: 0.001, d: 0.09, s: 0, r: 0.05 })
  const amp = adsr(gate, { a: 0.001, d: 0.17, s: 0, r: 0.06 })
  const body = sine(pitch.pow(3).range(46, 190)).mul(amp)
  const click = svf(noise(), 4200, { mode: 'hp' }).mul(adsr(gate, { a: 0.0004, d: 0.012, s: 0, r: 0.004 })).mul(0.4)
  return compress(body.add(click).tanh(), { threshold: -16, ratio: 4, attack: 3, release: 90, makeup: 2 })
})`,
  snare: `const snare = synth(({ gate, adsr, noise, sine, svf }) => {
  const tone = sine(190).mul(adsr(gate, { a: 0.001, d: 0.09, s: 0, r: 0.05 })).mul(0.5)
  const n = svf(noise(), 2400, { mode: 'hp' }).mul(adsr(gate, { a: 0.001, d: 0.14, s: 0, r: 0.08 }))
  return tone.add(n).mul(0.8).tanh()
})`,
  hat: `const hat = synth(({ gate, adsr, noise, svf }) =>
  svf(noise(), 8800, { mode: 'hp' }).mul(adsr(gate, { a: 0.001, d: 0.05, s: 0, r: 0.03 })).mul(0.7))`,
  clap: `const clap = synth(({ gate, adsr, noise, svf }) =>
  svf(noise(), 1700, { mode: 'bp', res: 0.5 }).mul(adsr(gate, { a: 0.003, d: 0.16, s: 0, r: 0.09 })).mul(1.1).tanh())`,
}

/** GM percussion note -> a drum synth role. */
function drumRole(pitch: number): 'kick' | 'snare' | 'hat' | 'clap' {
  if (pitch === 35 || pitch === 36) return 'kick'
  if (pitch === 38 || pitch === 40) return 'snare'
  if (pitch === 37 || pitch === 39) return 'clap'
  return 'hat'
}

/** Pick a synth type for a (non-drum) track from its name, then GM program. */
function trackType(t: MidiTrack): SynthType {
  const n = (t.name ?? '').toLowerCase()
  if (/bass/.test(n)) return 'bass'
  if (/piano|keys|key|rhodes|clav|organ/.test(n)) return 'keys'
  if (/pad|string|warm|ambient/.test(n)) return 'pad'
  if (/flute|pipe|whistle|recorder/.test(n)) return 'flute'
  if (/guitar|gtr/.test(n)) return 'gtr'
  if (/voice|vocal|choir|vox|aah|ooh/.test(n)) return 'vox'
  if (/lead|arp|pluck/.test(n)) return 'lead'
  if (/synth|stab|saw|chord/.test(n)) return 'stab'
  const p = t.program ?? 0
  if (p >= 32 && p <= 39) return 'bass'
  if (p >= 24 && p <= 31) return 'gtr'
  if (p >= 72 && p <= 79) return 'flute'
  if (p >= 88 && p <= 95) return 'pad'
  if (p >= 40 && p <= 51) return 'pad'
  if (p >= 52 && p <= 54) return 'vox'
  if (p >= 80 && p <= 87) return 'lead'
  return 'keys'
}

export interface ImportOptions {
  /** pattern/example name for the generated p('...') and header. default 'imported' */ name?: string
  /** grid resolution (steps per beat); 4 = 1/16. default 4 */ stepsPerBeat?: number
  /** add a kick sidechain pump + master glue when drums are present. default true */ mix?: boolean
  /** How to assign notes to synths.
   *  - 'perTrack' (default): one synth per MIDI track, chosen by name/program.
   *    Faithful to clean MIDI, but noisy TRANSCRIPTIONS mislabel instruments so
   *    parts pop in and out.
   *  - 'byRegister': ignore track labels; pool all pitched notes and split by
   *    pitch into bass / keys / lead. Robust to flaky instrument labels — parts
   *    play continuously wherever notes exist. Drums still route by channel. */
  voicing?: 'perTrack' | 'byRegister'
}

/** Register split points (midi note) for voicing:'byRegister'. */
const REG_BASS_MAX = 48 // < C3 -> bass
const REG_LEAD_MIN = 72 // >= C5 -> lead; between -> keys

export interface ImportResult {
  code: string
  bpm: number
  bars: number
  /** per-instrument note counts + quantization error, for reporting */ summary: string[]
}

/** Convert SMF bytes into an editable rondocode example (source string). */
export function midiToRondocode(input: Uint8Array | ArrayBuffer, opts: ImportOptions = {}): ImportResult {
  const name = opts.name ?? 'imported'
  const stepsPerBeat = opts.stepsPerBeat ?? 4
  const wantMix = opts.mix ?? true
  const f = parseMidi(input)
  const cps = midiCps(f.tempoBpm, f.timeSig)
  const tracks = f.tracks.filter((t) => t.notes.length > 0)

  const usedSynths = new Set<string>()
  const stackParts: string[] = [] // top-level p(...) stack members
  const blocks: string[] = [] // per-track const definitions
  const summary: string[] = []
  let maxBars = 0
  let hasDrums = false

  const voiceStack = (voices: string[], sound: string): string =>
    voices.length === 1
      ? `note('${voices[0]}').sound('${sound}')`
      : 'stack(\n' + voices.map((v) => `  note('${v}').sound('${sound}')`).join(',\n') + ',\n)'

  // emit one melodic group (a set of notes -> a synth), appending its block,
  // stack member and summary line
  const emitMelodic = (notes: readonly MidiNote[], type: SynthType, label: string, varName: string) => {
    if (notes.length === 0) return
    usedSynths.add(type)
    const res = midiNotesToVoices(notes, f.ppq, f.timeSig, { stepsPerBeat, maxVoices: 8 })
    maxBars = Math.max(maxBars, res.bars)
    blocks.push(`// ---- ${label} (${res.voices.length} ${res.voices.length === 1 ? 'voice' : 'voices'}) ----\nconst ${varName} = ${voiceStack(res.voices, type)}`)
    stackParts.push(varName)
    summary.push(`${label} -> ${type}: ${notes.length} notes, ${res.voices.length} voices, qErr=${res.quantErr.toFixed(2)}${res.dropped ? `, dropped ${res.dropped}` : ''}`)
  }

  const emitDrums = (notes: readonly MidiNote[], varName: string) => {
    hasDrums = true
    const roles = new Map<'kick' | 'snare' | 'hat' | 'clap', MidiNote[]>()
    for (const nt of notes) {
      const r = drumRole(nt.pitch)
      if (!roles.has(r)) roles.set(r, [])
      roles.get(r)!.push(nt)
    }
    const parts: string[] = []
    for (const [role, roleNotes] of roles) {
      usedSynths.add(role)
      const res = midiNotesToVoices(roleNotes, f.ppq, f.timeSig, { stepsPerBeat, maxVoices: 1 })
      maxBars = Math.max(maxBars, res.bars)
      // percussion ignores pitch; the voice string's note names just trigger the synth
      for (const v of res.voices) parts.push(`  note('${v}').sound('${role}')`)
      summary.push(`drums/${role}: ${roleNotes.length} hits`)
    }
    blocks.push(`// ---- drums ----\nconst ${varName} = stack(\n${parts.join(',\n')},\n)`)
    stackParts.push(varName)
  }

  if ((opts.voicing ?? 'perTrack') === 'byRegister') {
    // ignore (flaky) track labels: pool all pitched notes and split by pitch
    // register into bass / keys / lead so parts play continuously. Drums, which
    // are identified by channel not label, still route per drum track.
    emitDrums(tracks.filter((t) => t.isDrum).flatMap((t) => t.notes), 'drums')
    const pitched = tracks.filter((t) => !t.isDrum).flatMap((t) => t.notes)
    emitMelodic(pitched.filter((n) => n.pitch < REG_BASS_MAX), 'bass', 'bass register', 'bassReg')
    emitMelodic(pitched.filter((n) => n.pitch >= REG_BASS_MAX && n.pitch < REG_LEAD_MIN), 'keys', 'mid register', 'keysReg')
    emitMelodic(pitched.filter((n) => n.pitch >= REG_LEAD_MIN), 'lead', 'high register', 'leadReg')
  } else {
    // one synth per MIDI track (default), chosen from the track name / program
    tracks.forEach((t, i) => {
      if (t.isDrum) emitDrums(t.notes, `drums${i}`)
      else emitMelodic(t.notes, trackType(t), t.name ?? trackType(t), `${trackType(t)}${i}`)
    })
  }

  // assemble
  const synthDefs = [...usedSynths].map((s) => SYNTHS[s as keyof typeof SYNTHS]).join('\n')
  const lines: string[] = []
  lines.push(`// Imported from MIDI by midiToRondocode. ${f.tempoBpm.toFixed(0)} BPM, ${f.timeSig.num}/${f.timeSig.den}, ${tracks.length} tracks, ${maxBars} bars.`)
  lines.push(`// Tempo & note timing are exact from the file; notes are on a 1/${stepsPerBeat * (f.timeSig.den / 4) * 4}-ish grid (${stepsPerBeat} steps/beat).`)
  lines.push('')
  lines.push(synthDefs)
  lines.push('')
  lines.push(blocks.join('\n\n'))
  lines.push('')
  lines.push(`p('${name}', stack(\n${stackParts.map((p) => `  ${p},`).join('\n')}\n))`)
  if (wantMix && hasDrums) {
    lines.push(`sidechain('kick', { depth: 0.55, release: 0.16, duck: { bass: 0.7, pad: 0.5, keys: 0.4, vox: 0.35, flute: 0.3, gtr: 0.4, lead: 0.4 } })`)
  }
  if (wantMix) {
    lines.push(`masterCompress({ threshold: -14, ratio: 2.5, attack: 15, release: 150, makeup: 1.5 })`)
  }
  lines.push(`setCps(${cps.toFixed(4)})`)

  return { code: lines.join('\n') + '\n', bpm: f.tempoBpm, bars: maxBars, summary }
}
