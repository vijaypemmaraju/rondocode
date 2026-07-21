/* Render rondocode source to WAV through the FULL offline pipeline — the same
 * stageCode -> runPatterns -> renderMix path the in-app "bounce loop" export
 * uses, so sidechain, shared send buses and the master glue compressor all
 * apply exactly as they do live.
 *
 *   pnpm tsx scripts/render-code.ts [out-dir] [copy-dir?]
 *
 * Renders the curated DEMOS below. copy-dir (opt-in) also copies each WAV there
 * (e.g. a synced Dropbox folder).
 */
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
    // The feature we just built: two synths sharing ONE reverb via sends.
    name: 'send-bus-reverb',
    cycles: 8,
    source: `const pluck = synth(({ note, gate, adsr, tri }) =>
  tri(note.freq).mul(adsr(gate, { a: 0.004, d: 0.14, s: 0, r: 0.12 })))
const pad = synth(({ note, gate, adsr, saw, svf }) =>
  svf(saw(note.freq).add(saw(note.freq.mul(1.007))), 1600, { res: 0.2 })
    .mul(adsr(gate, { a: 0.4, d: 0.5, s: 0.8, r: 0.7 })).mul(0.35))

p('lead', note('c5 e5 g5 e5').sound('pluck'))
p('bed', chord('<Cmaj7 Am7 Fmaj7 G>').sound('pad').dur(0.98))

bus('space', ({ input, reverb }) => reverb(input, { roomSize: 0.9, damp: 0.3 }), { pluck: 0.4, pad: 0.6 })
setCps(0.5)`,
  },
  {
    // The pump: kick ducks a pad, glued on the master bus.
    name: 'sidechain-pump',
    cycles: 8,
    source: `const kick = synth(({ gate, adsr, sine }) =>
  sine(adsr(gate, { a: 0.001, d: 0.08, s: 0, r: 0.05 }).pow(2).range(46, 190))
    .mul(adsr(gate, { a: 0.001, d: 0.2, s: 0, r: 0.06 })).tanh())
const pad = synth(({ note, gate, adsr, saw, svf }) =>
  svf(saw(note.freq).add(saw(note.freq.mul(1.005))), 1900, { res: 0.2 })
    .mul(adsr(gate, { a: 0.3, d: 0.4, s: 0.85, r: 0.6 })).mul(0.4))

p('kick', note('c1*4').sound('kick'))
p('pad', chord('<Fmaj7 G Am7 G>').sound('pad').dur(0.98))
sidechain('kick', { depth: 0.8, release: 0.18 })
masterCompress({ threshold: -12, ratio: 3, makeup: 2 })
setCps(0.5)`,
  },
  {
    // FM: an inharmonic bell (ratio 1.4, decaying index) over a chord.
    name: 'fm-bell',
    cycles: 8,
    source: `const bell = synth(({ note, gate, adsr, fm }) => {
  const mod = fm(note.freq.mul(1.4)).mul(adsr(gate, { a: 0.001, d: 1.6, s: 0, r: 0.6 }).mul(6))
  return fm(note.freq, mod).mul(adsr(gate, { a: 0.001, d: 2, s: 0, r: 0.8 })).mul(0.6)
})
p('bells', note('<c5 e5 g5 b5> <e5 g5 b5 d6>').sound('bell'))
setCps(0.5)`,
  },
  {
    // FM: a 3:1 tine electric piano with a touch of feedback grit.
    name: 'fm-epiano',
    cycles: 8,
    source: `const ep = synth(({ note, gate, adsr, fm }) => {
  const tine = fm(note.freq.mul(3)).mul(adsr(gate, { a: 0.001, d: 0.4, s: 0, r: 0.2 }).mul(3))
  const body = fm(note.freq, tine, { feedback: 0.1 })
  return body.mul(adsr(gate, { a: 0.002, d: 1.4, s: 0.15, r: 0.4 })).mul(0.5)
})
p('keys', chord('<Cmaj7 Am7 Dm7 G7>').sound('ep').dur(0.95))
setCps(0.4)`,
  },
  {
    // A 16th-note acid line with a filter sweep — the classic 303 sound.
    name: 'acid-line',
    cycles: 8,
    source: `const acid = synth(({ note, gate, param, saw, square, ladder, adsr }) => {
  const cutoff = param('cutoff', 800, { min: 80, max: 8000 })
  const env = adsr(gate, { a: 0.003, d: 0.2, s: 0.3, r: 0.1 })
  const osc = saw(note.freq).mix(square(note.freq.mul(0.5)), 0.3)
  return ladder(osc, cutoff.mul(env.pow(2)), { res: 0.85 }).mul(env)
}, ({ input }) => input, { glide: 0.06 })

p('line', n('0 0 3 5 0 7 5 3').scale('a minor').sound('acid')
  .ctrl('cutoff', sine.range(300, 2600).slow(2))
  .every(4, (x) => x.rev()))
setCps(0.5)`,
  },
]

const outDir = process.argv[2] ?? 'renders'
const copyDir = process.argv[3]
mkdirSync(outDir, { recursive: true })
if (copyDir !== undefined) mkdirSync(copyDir, { recursive: true })

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
  const file = `${demo.name}.wav`
  writeFileSync(join(outDir, file), wav)
  console.error(
    `wrote ${join(outDir, file)} (${(wav.byteLength / 1024) | 0} KiB, ${((durationSec * 100) | 0) / 100}s, ${mix.normalized ? 'normalized' : 'unnormalized'})`,
  )
  if (copyDir !== undefined) {
    writeFileSync(join(copyDir, file), wav)
    console.error(`  copied to ${join(copyDir, file)}`)
  }
}
