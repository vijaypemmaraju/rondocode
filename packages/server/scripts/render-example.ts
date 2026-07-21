/* Render one named example to a 16-bit stereo WAV, headless (no browser).
 *   pnpm tsx packages/server/scripts/render-example.ts <exampleName> <cycles> <out.wav>
 * Used to build the sizzle-reel soundtrack segments. Not part of the build. */
import { writeFileSync } from 'node:fs'
import { stageCode, runPatterns, renderMix } from '../src/render-runner'
import { encodeWav16 } from '../../engine/src/wav'
import { EXAMPLES } from '../../app/src/examples/index'

const name = process.argv[2]
const cycles = Number(process.argv[3]) || 8
const out = process.argv[4]
if (!name || !out) {
  console.error('usage: render-example.ts <exampleName> <cycles> <out.wav>')
  console.error('examples:', EXAMPLES.map((e) => e.name).join(', '))
  process.exit(1)
}
const ex = EXAMPLES.find((e) => e.name === name)
if (!ex) {
  console.error(`no example "${name}". have: ${EXAMPLES.map((e) => e.name).join(', ')}`)
  process.exit(1)
}
const staged = stageCode(ex.code)
if (!staged.ok) {
  console.error('stage failed:', JSON.stringify(staged, null, 2))
  process.exit(1)
}
const cps = staged.cps ?? 0.5
const durationSec = cycles / cps
const events = runPatterns(staged.patterns, { cycles, cps })
const mix = renderMix(staged.synths, events, durationSec, {
  sampleRate: 48000,
  ...(staged.sidechain ? { sidechain: staged.sidechain } : {}),
  ...(staged.masterComp ? { masterComp: staged.masterComp } : {}),
})
const wav = encodeWav16(mix.left, mix.right, mix.sampleRate)
writeFileSync(out, wav)
console.error(
  `wrote ${out}: "${name}" ${cycles} cyc @ ${cps} cps = ${durationSec.toFixed(2)}s; stems=${Object.keys(mix.perSynth).join(',')}`,
)
// beat grid for the editor: seconds per cycle
console.log(JSON.stringify({ cps, cycles, durationSec, secPerCycle: 1 / cps }))
