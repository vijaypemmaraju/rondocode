/* Deterministic MIDI -> editable rondocode source.
 *   pnpm tsx packages/server/scripts/midi-to-rondocode.ts <file.mid> [name] [out.txt] [--by-register] [--steps=N]
 * Prints the generated example to stdout (or writes to out.txt). Not part of the build.
 *   --by-register  ignore track labels; split notes by pitch (robust to noisy transcriptions)
 *   --steps=N      grid resolution in steps per beat (default 4 = 1/16) */
import { readFileSync, writeFileSync } from 'node:fs'
import { midiToRondocode } from '../../app/src/midi/import'

const args = process.argv.slice(2)
const flags = args.filter((a) => a.startsWith('--'))
const pos = args.filter((a) => !a.startsWith('--'))
const midPath = pos[0]
const name = pos[1] || 'imported'
const out = pos[2]
if (!midPath) {
  console.error('usage: midi-to-rondocode.ts <file.mid> [name] [out.txt] [--by-register] [--steps=N]')
  process.exit(1)
}
const stepsArg = flags.find((f) => f.startsWith('--steps='))
const res = midiToRondocode(readFileSync(midPath), {
  name,
  voicing: flags.includes('--by-register') ? 'byRegister' : 'perTrack',
  ...(stepsArg ? { stepsPerBeat: Number(stepsArg.split('=')[1]) } : {}),
})
if (out) writeFileSync(out, res.code)
else process.stdout.write(res.code)
console.error(`\n// ${res.bpm.toFixed(0)} BPM, ${res.bars} bars`)
for (const s of res.summary) console.error('//   ' + s)
