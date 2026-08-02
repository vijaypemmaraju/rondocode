/* Render one named example to a 16-bit stereo WAV, headless (no browser).
 *   pnpm tsx packages/server/scripts/render-example.ts <exampleName> <cycles> <out.wav>
 * Used to build the sizzle-reel soundtrack segments. Not part of the build. */
import { writeFileSync } from 'node:fs'
import { stageCode, runPatterns, renderMix } from '../src/render-runner'
import { encodeWav16 } from '../../engine/src/wav'
import { analyze, sampleNamesIn, usesMicIn } from '../../engine/src/index'
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
/* Forward the send buses. Without them a program's shared reverb/delay simply
 * does not exist in the file: `club`'s space bus moved its spectral centroid
 * 265 -> 315 Hz, which is the tail you can hear missing. render-local.ts had
 * this right and this script did not. */
const mix = renderMix(staged.synths, events, durationSec, {
  sampleRate: 48000,
  ...(staged.buses.size > 0 ? { buses: staged.buses, sends: staged.sends } : {}),
  ...(staged.sidechain ? { sidechain: staged.sidechain } : {}),
  ...(staged.masterComp ? { masterComp: staged.masterComp } : {}),
})

/* SAY WHY IT IS SILENT. A headless render has no sample bank and no input
 * device, so sample()/granular()/mic() voices produce digital zero — and the
 * script used to report "wrote out.wav" with every appearance of success. */
const needsSamples = [...new Set([...staged.synths.values()].flatMap((d) => [
  ...sampleNamesIn(d.graph),
  ...(d.post ? sampleNamesIn(d.post) : []),
]))]
const needsMic = [...staged.synths.values()].some((d) => usesMicIn(d.graph) || (d.post !== undefined && usesMicIn(d.post)))
if (needsSamples.length > 0) {
  console.error(`note: this program plays sample(s) ${needsSamples.join(', ')} — a headless render has no sample bank, so those voices are silent here.`)
}
if (needsMic) console.error('note: this program reads the live microphone, which a headless render has no device for — those voices are silent here.')
if (staged.sings.length > 0) console.error('note: this program uses sing(); vocals are baked in the browser, so they are silent here.')
if (analyze(mix).isSilent) {
  console.error('WARNING: the render is SILENT (digital zero). The .wav was still written.')
}
const wav = encodeWav16(mix.left, mix.right, mix.sampleRate)
writeFileSync(out, wav)
console.error(
  `wrote ${out}: "${name}" ${cycles} cyc @ ${cps} cps = ${durationSec.toFixed(2)}s; stems=${Object.keys(mix.perSynth).join(',')}`,
)
// beat grid for the editor: seconds per cycle
console.log(JSON.stringify({ cps, cycles, durationSec, secPerCycle: 1 / cps }))
