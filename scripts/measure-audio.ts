/* Render every shipped example and MEASURE it: does it make sound, does it
 * clip, is its level in the range the house style asks for.
 *
 *   pnpm tsx scripts/measure-audio.ts                 # sweep them all
 *   pnpm tsx scripts/measure-audio.ts --examples=acid,edm --cycles=8
 *   pnpm tsx scripts/measure-audio.ts --strict         # exit non-zero on a flag
 *
 * WHY THIS EXISTS. test/examples.test.ts proves every example EVALUATES and
 * schedules notes. Nothing rendered them, so an example could clip, collapse
 * to near-silence, or lose a voice entirely and the suite stayed green. That
 * is not hypothetical: `granular` renders digital zero headless, and only a
 * comment three files away explains why.
 *
 * WHY IT IS A SCRIPT AND NOT A TEST. Rendering 29 examples is minutes of DSP,
 * which does not belong in a suite people run on every save. It is the audio
 * twin of scripts/measure-frames.ts: run it after touching the engine, the
 * mix stage or the examples, and keep the baseline in docs/audio-health.md.
 *
 * SAMPLES. The BUILT-IN bank (vox / riser / pad / break) is loaded here, the
 * same procedurally-generated PCM the browser builds at startup, so a
 * sample()/granular() example renders for real. Only a sample a USER would
 * load, a sing() vocal (baked in the browser) or the live mic is unavailable;
 * those are reported as `needs …` rather than counted as failures, because
 * calling a working example broken trains you to ignore the output.
 */
import { writeFileSync } from 'node:fs'
import { analyze, sampleNamesIn, usesMicIn } from '../packages/engine/src/index'
import { measureLoudness } from '../packages/engine/src/loudness'
import { SHIPPED_EXAMPLES } from '../packages/app/src/examples/index'
import { builtInSamples } from '../packages/app/src/audio/demo-samples'
import { renderMix, runPatterns, stageCode } from '../packages/server/src/render-runner'

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (hit === undefined) return undefined
  const eq = hit.indexOf('=')
  return eq === -1 ? '' : hit.slice(eq + 1)
}
const CYCLES = Number(flag('cycles') ?? 8)
const STRICT = flag('strict') !== undefined
const ONLY = flag('examples')
const JSON_OUT = flag('json')

/** The house style, from the example-authoring standard. */
const WANT = {
  /** Below this and the example is inaudible next to the others. */
  minPeakDb: -20,
  /** Above this a bounce distorts on playback (the engine clamps at 0.89). */
  maxPeakDb: -0.5,
  /** Under 4 dB reads as over-compressed; over ~18 as unmixed/sparse. */
  minCrestDb: 4,
  maxCrestDb: 18,
}

interface Row {
  name: string
  needsSamples: string[]
  needsMic: boolean
  silent: boolean
  peakDb: number
  lufs: number
  crestDb: number
  clipped: boolean
  hasNaN: boolean
  centroidHz: number
  flags: string[]
}

const db = (x: number): number => (x <= 0 ? -Infinity : Math.round(20 * Math.log10(x) * 10) / 10)

const wanted = SHIPPED_EXAMPLES.filter(
  (e) => ONLY === undefined || ONLY === '' || ONLY.split(',').some((f) => e.name.includes(f.trim())),
)
if (wanted.length === 0) throw new Error(`no example matched --examples=${ONLY ?? ''}`)

/** The browser's startup bank, available offline because it is generated. */
const BANK = builtInSamples(48000)

const rows: Row[] = []
for (const ex of wanted) {
  const staged = stageCode(ex.code)
  if (!staged.ok) {
    process.stderr.write(`${ex.name}: STAGE FAILED — ${staged.diagnostics[0]?.message ?? '?'}\n`)
    rows.push({
      name: ex.name, needsSamples: [], needsMic: false, silent: true, peakDb: -Infinity, lufs: -Infinity,
      crestDb: 0, clipped: false, hasNaN: false, centroidHz: 0, flags: ['stage failed'],
    })
    continue
  }
  // What this program would need from a sample bank we do not have.
  // Only what the bank CANNOT supply is missing.
  const needsSamples = [
    ...new Set([
      ...[...staged.synths.values()].flatMap((d) => [
        ...sampleNamesIn(d.graph),
        ...(d.post ? sampleNamesIn(d.post) : []),
      ]),
    ]),
  ].filter((n) => BANK[n] === undefined)
  const needsMic = [...staged.synths.values()].some(
    (d) => usesMicIn(d.graph) || (d.post !== undefined && usesMicIn(d.post)),
  )
  const cps = staged.cps ?? 0.5
  const events = runPatterns(staged.patterns, { cycles: CYCLES, cps })
  const mix = renderMix(staged.synths, events, CYCLES / cps, {
    sampleRate: 48000,
    samples: BANK,
    ...(staged.buses.size > 0 ? { buses: staged.buses, sends: staged.sends } : {}),
    ...(staged.sidechain !== undefined ? { sidechain: staged.sidechain } : {}),
    ...(staged.masterComp !== undefined ? { masterComp: staged.masterComp } : {}),
  })
  const a = analyze(mix)
  const loud = measureLoudness(mix.left, mix.right, mix.sampleRate)
  const peakDb = db(a.peak)
  const crestDb = a.rms > 0 ? Math.round((db(a.peak) - db(a.rms)) * 10) / 10 : 0

  const flags: string[] = []
  // A sample-dependent example CANNOT make sound here; that is the renderer's
  // limit, not the example's, so it is stated rather than flagged.
  // …and a mic voice has no input device offline, for the same reason.
  const excusedSilence = needsSamples.length > 0 || staged.sings.length > 0 || needsMic
  if (a.hasNaN) flags.push('NaN')
  if (a.clipped) flags.push('CLIPPED')
  if (a.isSilent && !excusedSilence) flags.push('SILENT')
  if (!a.isSilent) {
    if (peakDb < WANT.minPeakDb) flags.push(`quiet ${peakDb}dB`)
    if (peakDb > WANT.maxPeakDb) flags.push(`hot ${peakDb}dB`)
    if (crestDb < WANT.minCrestDb) flags.push(`squashed ${crestDb}dB`)
    if (crestDb > WANT.maxCrestDb) flags.push(`sparse ${crestDb}dB`)
  }
  rows.push({
    name: ex.name, needsSamples, needsMic, silent: a.isSilent, peakDb, lufs: Math.round(loud.integratedLufs * 10) / 10,
    crestDb, clipped: a.clipped, hasNaN: a.hasNaN, centroidHz: Math.round(a.spectralCentroidHz), flags,
  })
  process.stderr.write(`  measured ${ex.name}\n`)
}

const pad = (s: string, n: number): string => s.padEnd(n)
process.stdout.write(`\n${pad('example', 16)} ${'peak'.padStart(7)} ${'LUFS'.padStart(7)} ${'crest'.padStart(6)} ${'centroid'.padStart(9)}  notes\n`)
for (const r of rows) {
  const note = r.needsSamples.length > 0
    ? `needs samples: ${r.needsSamples.join(', ')}`
    : r.needsMic ? 'needs the live mic' : r.flags.join(', ')
  process.stdout.write(
    `${pad(r.name, 16)} ${`${r.peakDb}`.padStart(7)} ${`${r.lufs}`.padStart(7)} ` +
    `${`${r.crestDb}`.padStart(6)} ${`${r.centroidHz}Hz`.padStart(9)}  ${note}\n`,
  )
}

const bad = rows.filter((r) => r.flags.length > 0)
process.stdout.write(
  bad.length === 0
    ? `\nall ${rows.length} examples healthy\n`
    : `\n${bad.length} of ${rows.length} flagged: ${bad.map((r) => `${r.name} (${r.flags.join(', ')})`).join('; ')}\n`,
)
if (JSON_OUT !== undefined && JSON_OUT !== '') {
  writeFileSync(JSON_OUT, JSON.stringify(rows, null, 2))
  process.stderr.write(`wrote ${JSON_OUT}\n`)
}
if (STRICT && bad.length > 0) process.exit(1)
