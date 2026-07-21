/* Render vocoder demos to WAV (throwaway showcase for the new `vocoder` node).
 *   pnpm tsx scripts/render-vocoder.ts <out-dir>
 * Uses the same offline pipeline as render-code.ts. The modulator is built from
 * a formant-shaped source, so the carrier "sings" vowels with no voice sample. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stageCode, runPatterns, renderMix } from '../packages/server/src/render-runner'
import { encodeWav16 } from '../packages/engine/src/index'

interface Demo {
  name: string
  cycles: number
  source: string
}

const DEMOS: Demo[] = [
  {
    // Singing choir: supersaw chords vocoded by a slowly morphing vowel source.
    name: 'vocoder-vowels',
    cycles: 4,
    source: `const voice = synth(({ note, gate, adsr, saw, formant, lfo, supersaw, vocoder }) => {
  const mod = formant(saw(115), lfo(0.2).range(0, 1))
  const car = supersaw(note.freq)
  return vocoder(car, mod, { bands: 24, high: 6000 })
    .mul(adsr(gate, { a: 0.12, d: 0.4, s: 0.9, r: 0.7 })).mul(0.7)
})
p('v', chord('<Cmaj7 Fmaj7 Am7 Gsus4>').sound('voice').dur(0.98))
setCps(0.3)`,
  },
  {
    // Talkbox lead: a melody with a faster vowel wobble = a "talking" synth.
    name: 'vocoder-talkbox',
    cycles: 4,
    source: `const lead = synth(({ note, gate, adsr, saw, formant, lfo, vocoder }) => {
  const mod = formant(saw(100), lfo(3).range(0, 1))
  const car = saw(note.freq).add(saw(note.freq.mul(1.008)))
  return vocoder(car, mod, { bands: 20 })
    .mul(adsr(gate, { a: 0.02, d: 0.15, s: 0.7, r: 0.18 })).mul(0.7)
})
p('lead', note('c4 e4 g4 c5 g4 e4 d4 g4').sound('lead'))
setCps(0.5)`,
  },
  {
    // Breathy robot: a NOISE modulator (whispered vowels) instead of a pitched
    // source — the classic airy vocoder texture over a minor progression.
    name: 'vocoder-breath',
    cycles: 4,
    source: `const robo = synth(({ note, gate, adsr, saw, noise, formant, lfo, vocoder }) => {
  const mod = formant(noise(), lfo(0.5).range(0, 1))
  const car = saw(note.freq).add(saw(note.freq.mul(1.006)))
  return vocoder(car, mod, { bands: 24, response: 0.02 })
    .mul(adsr(gate, { a: 0.06, d: 0.25, s: 0.85, r: 0.4 })).mul(0.7)
})
p('r', chord('<Cm7 Abmaj7 Ebmaj7 Bb>').sound('robo').dur(0.98))
setCps(0.35)`,
  },
]

const outDir = process.argv[2] ?? '.'
mkdirSync(outDir, { recursive: true })
for (const demo of DEMOS) {
  const staged = stageCode(demo.source)
  if (!staged.ok) {
    console.error(`SKIP ${demo.name}: ${staged.diagnostics.map((d) => d.message).join(' | ')}`)
    continue
  }
  const cps = staged.cps ?? 0.5
  const durationSec = demo.cycles / cps
  const events = runPatterns(staged.patterns, { cycles: demo.cycles, cps })
  const mix = renderMix(staged.synths, events, durationSec, {
    sampleRate: 48000,
    ...(staged.sidechain ? { sidechain: staged.sidechain } : {}),
    ...(staged.masterComp ? { masterComp: staged.masterComp } : {}),
    ...(staged.buses.size > 0 ? { buses: staged.buses, sends: staged.sends } : {}),
  })
  const wav = encodeWav16(mix.left, mix.right, mix.sampleRate)
  writeFileSync(join(outDir, `${demo.name}.wav`), wav)
  console.log(`✓ ${demo.name}.wav  (${durationSec.toFixed(1)}s)`)
}
