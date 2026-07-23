/* rondoc — the rondo compiler CLI.
 *
 *   pnpm tsx packages/rondo/scripts/rondoc.ts <file.rondo>            # print JS
 *   pnpm tsx packages/rondo/scripts/rondoc.ts <file.rondo> --render out.wav [--cycles 8]
 *
 * With --render it transpiles, then runs the SAME offline pipeline the MCP
 * render tools use (stageCode → runPatterns → renderMix), proving the rondo
 * source makes real sound through the real engine. */

import { readFileSync, writeFileSync } from 'node:fs'
import { compile } from '../src/compile'
import { stageCode, runPatterns, renderMix } from '../../server/src/render-runner'
import { encodeWav16 } from '../../engine/src/wav'

const args = process.argv.slice(2)
const file = args[0]
if (!file || file.startsWith('--')) {
  console.error('usage: rondoc.ts <file.rondo> [--render out.wav] [--cycles N]')
  process.exit(1)
}
const renderIdx = args.indexOf('--render')
const out = renderIdx >= 0 ? args[renderIdx + 1] : undefined
const cyclesIdx = args.indexOf('--cycles')
const cycles = cyclesIdx >= 0 ? Number(args[cyclesIdx + 1]) : 8

const src = readFileSync(file, 'utf8')
const result = compile(src)
if (!result.ok) {
  console.error('rondo: compile errors:')
  for (const e of result.errors) console.error(`  ${file}:${e.line}:${e.col}  ${e.message}`)
  process.exit(1)
}

console.log('// --- transpiled rondocode ---')
console.log(result.code)

if (out) {
  const staged = stageCode(result.code)
  if (!staged.ok) {
    console.error('rondo: transpiled code failed to stage:', JSON.stringify(staged.diagnostics, null, 2))
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
  writeFileSync(out, encodeWav16(mix.left, mix.right, mix.sampleRate))
  const stems = Object.entries(mix.perSynth).map(([k, v]) => `${k}(rms ${v.rms.toFixed(3)})`).join(', ')
  console.error(`\nrendered ${out}: ${cycles} cyc @ ${cps} cps = ${durationSec.toFixed(2)}s; stems=${stems}`)
}
