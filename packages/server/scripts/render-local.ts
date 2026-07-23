/* Render a LOCAL (gitignored) example FILE to a 16-bit stereo WAV, headless.
 *   pnpm tsx packages/server/scripts/render-local.ts <example.ts> <cycles> <out.wav>
 * The app auto-loads packages/app/src/examples/local/*.ts via import.meta.glob,
 * but the tsx render tools can't (glob is a Vite transform), so render local
 * examples by file path here. Forwards buses/sends/masterComp like the live path. */
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { stageCode, runPatterns, renderMix } from '../src/render-runner'
import { encodeWav16 } from '../../engine/src/wav'

const path = process.argv[2]
const cycles = Number(process.argv[3]) || 8
const out = process.argv[4]
if (!path || !out) {
  console.error('usage: render-local.ts <example.ts> <cycles> <out.wav>')
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
const durationSec = cycles / cps
const events = runPatterns(staged.patterns, { cycles, cps })
const mix = renderMix(staged.synths, events, durationSec, {
  sampleRate: 48000,
  ...(staged.buses.size > 0 ? { buses: staged.buses, sends: staged.sends } : {}),
  ...(staged.sidechain !== undefined ? { sidechain: staged.sidechain } : {}),
  ...(staged.masterComp !== undefined ? { masterComp: staged.masterComp } : {}),
})
writeFileSync(out, encodeWav16(mix.left, mix.right, mix.sampleRate))
console.error(`wrote ${out}: "${ex.name ?? 'local'}" ${cycles} cyc @ ${cps} cps; stems=${Object.keys(mix.perSynth).join(',')}`)
