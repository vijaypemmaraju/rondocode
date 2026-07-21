/* Phase 2 exit demo: a SCHEDULED pattern rendered offline to WAV.
 *
 *   pnpm tsx scripts/demo-render.ts [out.wav] [copy-dir?]
 *
 * copy-dir is optional and opt-in: when given, the WAV is also copied
 * there (handy for a synced renders folder).
 *
 * Pipeline: Pattern<ControlMap> → Scheduler (driven by a virtual clock, the
 * exact code path the app will use) → SchedulerEvents → RenderEvents →
 * renderOffline → encodeWav16 → WAV + analyze() JSON on stdout.
 *
 * Lives at the repo root because it deliberately imports BOTH packages —
 * @rondocode/pattern stays engine-free (relative source imports keep the
 * root package.json dependency-free; tsx resolves TS directly).
 *
 * Continuous params (the cutoff sweep) are sampled at each event's onset:
 * appLeft samples the signal over the note's whole (midpoint), and each
 * value becomes one param event at the note's start — v1's block-free
 * approximation of a continuous sweep (audibly stepped per note, which for
 * 16th-note acid IS the classic sound).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { n, sine, Scheduler } from '../packages/pattern/src/index'
import type { Pattern, ControlMap } from '../packages/pattern/src/index'
import { synth, renderOffline, analyze, encodeWav16 } from '../packages/engine/src/index'
import type { RenderEvent } from '../packages/engine/src/index'

const outPath = process.argv[2] ?? 'out.wav'
/** Optional second arg: also copy the WAV there (e.g. a Dropbox renders
 *  dir). Opt-in only — no default side effect outside the repo. */
const copyDir = process.argv[3]

// The design-doc acid synth (same patch as packages/engine/scripts/render-wav.ts)
const acid = synth(({ note, gate, param, saw, square, ladder, adsr }) => {
  const cutoff = param('cutoff', 800, { min: 80, max: 8000, curve: 'log' })
  const env = adsr(gate, { a: 0.003, d: 0.2, s: 0.3, r: 0.1 })
  const osc = saw(note.freq).mix(square(note.freq.mul(0.5)), 0.3)
  return ladder(osc, cutoff.mul(env.pow(2)), { res: 0.85 }).mul(env)
})

// Four bars of the acid line: degrees through a minor (root a3 = 57),
// a two-cycle sine sweep on the cutoff, every 4th cycle reversed.
const pattern: Pattern<ControlMap> = n('0 0 3 5')
  .scale('a minor')
  .sound('acid')
  .ctrl('cutoff', sine.range(300, 2400).slow(2))
  .every(4, (p) => p.rev())

const CPS = 0.6
const BARS = 4
const DURATION = BARS / CPS

// Drive the real Scheduler with a virtual clock and translate its events
// into the offline renderer's vocabulary. Keys that aren't note/transport
// controls are synth params (cutoff here) sampled at the event's onset.
const NON_PARAM_KEYS = new Set(['n', 'note', 'sound', 'gain', 'pan', 'dur', 'loc'])
const events: RenderEvent[] = []
const clock = { now: 0 }
const sched = new Scheduler({
  getTime: () => clock.now,
  onEvents: (evs) => {
    for (const ev of evs) {
      if (ev.cycle >= BARS) continue
      const midi = ev.controls.note
      if (typeof midi !== 'number') continue
      for (const [key, value] of Object.entries(ev.controls)) {
        if (NON_PARAM_KEYS.has(key) || typeof value !== 'number') continue
        events.push({ time: ev.timeSec, type: 'param', name: key, value })
      }
      events.push({ time: ev.timeSec, type: 'noteOn', note: midi, velocity: ev.controls.gain ?? 1 })
      events.push({ time: ev.timeSec + ev.durSec, type: 'noteOff', note: midi })
    }
  },
  lookahead: 0.1,
})
sched.setCps(CPS)
sched.setPattern('demo', pattern)
sched.play()
const TICK = 0.025
while (clock.now < DURATION + 0.1) {
  sched.tick()
  clock.now += TICK
}
sched.stop()

const rendered = renderOffline(acid, events, DURATION)
const wav = encodeWav16(rendered.left, rendered.right, rendered.sampleRate)
writeFileSync(outPath, wav)
console.error(
  `wrote ${outPath} (${(wav.byteLength / 1024) | 0} KiB, ${(DURATION * 100 | 0) / 100}s @ ${rendered.sampleRate}Hz, ${events.length} events)`,
)
if (copyDir !== undefined) {
  try {
    mkdirSync(copyDir, { recursive: true })
    const copyPath = join(copyDir, basename(outPath))
    writeFileSync(copyPath, wav)
    console.error(`copied to ${copyPath}`)
  } catch (e) {
    console.error(`copy to ${copyDir} skipped: ${e instanceof Error ? e.message : e}`)
  }
}

console.log(JSON.stringify(analyze(rendered), null, 2))
