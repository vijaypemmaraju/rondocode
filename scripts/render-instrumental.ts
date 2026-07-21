/* Render a backing track for the sung vocal (drums + bass + pad, C→F) to WAV.
 *   pnpm tsx scripts/render-instrumental.ts <out.wav> [cycles]  */
import { writeFileSync } from 'node:fs'
import { stageCode, runPatterns, renderMix } from '../packages/server/src/render-runner'
import { encodeWav16 } from '../packages/engine/src/index'

const out = process.argv[2]!
const cycles = Number(process.argv[3] ?? 2)

const SRC = `const kick = synth(({ gate, adsr, sine, noise, svf }) => {
  const body = sine(adsr(gate, { a: 0.001, d: 0.09, s: 0, r: 0.05 }).pow(2).range(48, 155))
    .mul(adsr(gate, { a: 0.001, d: 0.2, s: 0, r: 0.06 }))
  const click = svf(noise(), 4000, { mode: 'hp' }).mul(adsr(gate, { a: 0.001, d: 0.01, s: 0, r: 0.004 })).mul(0.4)
  return body.add(click).tanh()
})
const snare = synth(({ gate, adsr, noise, svf, sine }) => {
  const n = svf(noise(), 2000, { mode: 'bp', res: 0.4 }).mul(adsr(gate, { a: 0.001, d: 0.12, s: 0, r: 0.05 }))
  const tone = sine(190).mul(adsr(gate, { a: 0.001, d: 0.08, s: 0, r: 0.03 })).mul(0.4)
  return n.add(tone).mul(0.5).tanh()
})
const hat = synth(({ gate, adsr, noise, svf }) =>
  svf(noise(), 9000, { mode: 'hp' }).mul(adsr(gate, { a: 0.001, d: 0.035, s: 0, r: 0.02 })).mul(0.3))
const bass = synth(({ note, gate, adsr, saw, svf }) =>
  svf(saw(note.freq), 650, { res: 0.35 }).mul(adsr(gate, { a: 0.005, d: 0.18, s: 0.55, r: 0.1 })).mul(0.5))
const pad = synth(({ note, gate, adsr, saw, svf }) =>
  svf(saw(note.freq).add(saw(note.freq.mul(1.007))), 1800, { res: 0.2 })
    .mul(adsr(gate, { a: 0.25, d: 0.5, s: 0.85, r: 0.8 })).mul(0.22))
const arp = synth(({ note, gate, adsr, tri, svf }) =>
  svf(tri(note.freq), 3200, { res: 0.2 }).mul(adsr(gate, { a: 0.002, d: 0.12, s: 0, r: 0.08 })).mul(0.22))

p('kick', note('c1*4').sound('kick'))
p('snare', note('~ c2 ~ c2').sound('snare'))
p('hat', note('c5*8').sound('hat').gain(0.5))
p('bass', note('<c2 a1 f1 g1>').sound('bass').fast(2).gain(0.9))
p('pad', chord('<Cmaj7 Am7 Fmaj7 G>').sound('pad').dur(0.98))
p('arp', n('0 2 4 7 4 2 4 7').scale('c major').sound('arp').fast(2).gain(0.7))
setCps(0.5)`

const staged = stageCode(SRC)
if (!staged.ok) throw new Error(staged.diagnostics.map((d) => d.message).join(' | '))
const cps = staged.cps ?? 0.5
const events = runPatterns(staged.patterns, { cycles, cps })
const mix = renderMix(staged.synths, events, cycles / cps, { sampleRate: 48000 })
writeFileSync(out, encodeWav16(mix.left, mix.right, mix.sampleRate))
console.log(`✓ ${out}  (${(cycles / cps).toFixed(1)}s @ 48k)`)
