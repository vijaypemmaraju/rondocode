/* Manual listening checkpoint: render the design-doc acid synth playing a
 * two-bar phrase to a 16-bit stereo WAV and print the analyze() JSON.
 *
 *   pnpm tsx packages/engine/scripts/render-wav.ts <out.wav>
 *
 * Not part of the library build — do not re-export from index.ts. */
import { writeFileSync } from 'node:fs'
import { synth } from '../src/builder'
import { renderOffline } from '../src/render'
import type { RenderEvent } from '../src/render'
import { analyze } from '../src/analysis'
import { encodeWav16 } from '../src/wav'

const outPath = process.argv[2]
if (!outPath) {
  console.error('usage: pnpm tsx packages/engine/scripts/render-wav.ts <out.wav>')
  process.exit(1)
}

// The acid synth from the design doc (docs/plans/2026-07-18-rondocode-design.md)
const acid = synth(({ note, gate, param, saw, square, ladder, adsr }) => {
  const cutoff = param('cutoff', 800, { min: 80, max: 8000, curve: 'log' })
  const env = adsr(gate, { a: 0.003, d: 0.2, s: 0.3, r: 0.1 })
  const osc = saw(note.freq).mix(square(note.freq.mul(0.5)), 0.3)
  return ladder(osc, cutoff.mul(env.pow(2)), { res: 0.85 }).mul(env)
})

// Two bars of 16ths at 120 BPM = 32 steps * 0.125 s = 4 s.
// Note pattern [33, 33, 45, 31] (A1 A1 A2 G1) with a slow sine cutoff sweep
// 300..2400 Hz over the 4 s (the design doc's `sine.range(300,2400).slow(4)`).
const DURATION = 4
const STEP = 0.125
const GATE = 0.1 // note length: leaves 25 ms before the next step's noteOn
const pattern = [33, 33, 45, 31]

const events: RenderEvent[] = []
for (let step = 0; step < DURATION / STEP; step++) {
  const t = step * STEP
  const note = pattern[step % pattern.length]!
  const cutoff = 300 + (2400 - 300) * (0.5 + 0.5 * Math.sin((2 * Math.PI * t) / 4))
  events.push({ time: t, type: 'param', name: 'cutoff', value: cutoff })
  events.push({ time: t, type: 'noteOn', note, velocity: 1 })
  events.push({ time: t + GATE, type: 'noteOff', note })
}

const rendered = renderOffline(acid, events, DURATION)

const { left, right, sampleRate } = rendered
const wav = encodeWav16(left, right, sampleRate)
writeFileSync(outPath, wav)
console.error(`wrote ${outPath} (${wav.byteLength / 1024 | 0} KiB, ${left.length / sampleRate}s @ ${sampleRate}Hz)`)

console.log(JSON.stringify(analyze(rendered), null, 2))
