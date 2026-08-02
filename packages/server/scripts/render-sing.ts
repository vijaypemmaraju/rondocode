/* Render a local example WITH its sing() vocals to a WAV, headless.
 *   pnpm tsx packages/server/scripts/render-sing.ts <example.ts> <cycles> <out.wav>
 * Bakes each vocal in node (models cached under ~/.cache/rondocode-models, or
 * RONDOCODE_MODEL_CACHE), then renders the mix with the clips in place - the
 * same pipeline the browser runs, minus the browser. */
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { stageCode, runPatterns, renderMix } from '../src/render-runner'
import { bakeSings, modelCacheDir } from '../src/sing-headless'
import { encodeWav16 } from '../../engine/src/wav'

const path = process.argv[2]
const cycles = Number(process.argv[3]) || 8
const out = process.argv[4]
if (!path || !out) {
  console.error('usage: render-sing.ts <example.ts> <cycles> <out.wav>')
  process.exit(1)
}
const mod = (await import(resolve(path))) as { default?: { name?: string; code?: string } }
const ex = mod.default
if (ex?.code === undefined) {
  console.error(`${path} must default-export an Example { name, code }`)
  process.exit(1)
}
const staged = stageCode(ex.code)
if (!staged.ok) {
  console.error('stage failed:', JSON.stringify(staged.diagnostics ?? staged, null, 2))
  process.exit(1)
}
const cps = staged.cps ?? 0.5
const sings = staged.sings ?? []
console.error(`models: ${modelCacheDir()}`)
console.error(`baking ${sings.length} vocal(s) at cps ${cps}…`)
const samples = sings.length > 0
  ? await bakeSings(sings, cps, (m) => console.error(`  ${m}`))
  : {}

const durationSec = cycles / cps
const events = runPatterns(staged.patterns, { cycles, cps })
const mix = renderMix(staged.synths, events, durationSec, {
  sampleRate: 48000,
  cps,
  ...(Object.keys(samples).length > 0 ? { samples } : {}),
  ...(staged.buses.size > 0 ? { buses: staged.buses, sends: staged.sends } : {}),
  ...(staged.sidechain !== undefined ? { sidechain: staged.sidechain } : {}),
  ...(staged.masterComp !== undefined ? { masterComp: staged.masterComp } : {}),
})
writeFileSync(out, encodeWav16(mix.left, mix.right, mix.sampleRate))
const stems = Object.entries(mix.perSynth).map(([n, s]) => `${n}=${(s as { rms: number }).rms.toFixed(4)}`)
console.error(`wrote ${out}: ${cycles} cyc @ ${cps} cps`)
console.error(`stems: ${stems.join(' ')}`)
