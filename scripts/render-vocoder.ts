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

// A bright carrier (dual saw + a little noise) so EVERY band — including the
// highs — has energy for the modulator to shape. This is the biggest lever for
// a convincing vocoder: a plain saw starves the high bands and sounds dull.
const CARRIER = `saw(note.freq).add(saw(note.freq.mul(1.007))).add(noise().mul(0.15))`

const DEMOS: Demo[] = [
  {
    // A/B reference: the bright carrier chord, NO vocoder. Compare to voc-wet.
    name: 'voc-A-dry',
    cycles: 4,
    source: `const dry = synth(({ note, gate, adsr, saw, noise }) =>
  ${CARRIER}.mul(adsr(gate, { a: 0.1, d: 0.3, s: 0.9, r: 0.5 })).mul(0.32))
p('d', chord('<Cmaj7 Fmaj7 Am7 G>').sound('dry').dur(0.98))
setCps(0.3)`,
  },
  {
    // Same chord, vocoded by a voice-like source (buzz + breath) whose vowels
    // move — the chord now "sings ah→ee→oh". A/B this against voc-A-dry.
    name: 'voc-B-wet',
    cycles: 4,
    source: `const wet = synth(({ note, gate, adsr, saw, noise, formant, lfo, vocoder }) => {
  const car = ${CARRIER}
  const mod = formant(saw(110).add(noise().mul(0.4)), lfo(1.5).range(0, 1))
  return vocoder(car, mod, { bands: 24, high: 9000 })
    .mul(adsr(gate, { a: 0.1, d: 0.3, s: 0.9, r: 0.5 })).mul(0.5)
})
p('w', chord('<Cmaj7 Fmaj7 Am7 G>').sound('wet').dur(0.98))
setCps(0.3)`,
  },
  {
    // Unmistakably vocoded: a RHYTHMIC modulator (6 Hz noise bursts + moving
    // vowels) chops and articulates the sustained chord — robotic stabs.
    name: 'voc-C-rhythm',
    cycles: 4,
    source: `const rhy = synth(({ note, gate, adsr, saw, noise, formant, lfo, vocoder }) => {
  const car = ${CARRIER}
  const src = noise().mul(lfo(6).range(0, 1).pow(3))
  const mod = formant(src, lfo(0.7).range(0, 1))
  return vocoder(car, mod, { bands: 22, high: 9000, response: 0.008 })
    .mul(adsr(gate, { a: 0.02, d: 0.3, s: 0.9, r: 0.4 })).mul(0.6)
})
p('r', chord('<Cm7 Fm7>').sound('rhy').dur(0.98))
setCps(0.4)`,
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
  // Peak-normalize to a consistent level so the demos (and the dry/wet A/B) are
  // fairly comparable regardless of each patch's internal gain.
  let peak = 0
  for (let i = 0; i < mix.left.length; i++) {
    peak = Math.max(peak, Math.abs(mix.left[i]!), Math.abs(mix.right[i]!))
  }
  const g = peak > 1e-6 ? 0.8 / peak : 1
  for (let i = 0; i < mix.left.length; i++) {
    mix.left[i]! *= g
    mix.right[i]! *= g
  }
  const wav = encodeWav16(mix.left, mix.right, mix.sampleRate)
  writeFileSync(join(outDir, `${demo.name}.wav`), wav)
  console.log(`✓ ${demo.name}.wav  (${durationSec.toFixed(1)}s, ×${g.toFixed(2)})`)
}
