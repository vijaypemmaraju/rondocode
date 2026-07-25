/* Long-run decompiler fuzzing, for unattended sweeps beyond the CI range:
 *
 *   pnpm tsx packages/rondo/scripts/fuzz.ts 100000          # seeds 1..100000
 *   pnpm tsx packages/rondo/scripts/fuzz.ts 50000 100001    # a later window
 *
 * Prints a shrunk repro and exits 1 on the first violation. */

import { checkFixedPoint, genProgram, shrink, stillFailing } from '../test/fuzzgen'

const n = Number(process.argv[2] ?? 10000)
const from = Number(process.argv[3] ?? 1)

let checked = 0
const started = Date.now()
for (let seed = from; seed < from + n; seed++) {
  const src = genProgram(seed)
  const fail = checkFixedPoint(src)
  if (fail !== null) {
    const small = fail.kind === 'gen-compile' ? src : shrink(src, stillFailing)
    console.error(`FAIL seed ${seed}: ${fail.kind}`)
    console.error(`--- ${fail.kind === 'gen-compile' ? 'generated (does not compile)' : 'shrunk repro'} ---`)
    console.error(small)
    console.error('--- detail ---')
    console.error(JSON.stringify(fail.kind === 'gen-compile' ? fail : checkFixedPoint(small), null, 2))
    process.exit(1)
  }
  checked++
  if (checked % 5000 === 0) {
    const rate = Math.round(checked / ((Date.now() - started) / 1000))
    console.log(`${checked}/${n} ok (${rate}/s)`)
  }
}
console.log(`fixed point held for ${checked} programs (seeds ${from}..${from + n - 1})`)
