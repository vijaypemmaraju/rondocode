/* MUTATION AUDIT — break a contract, run its tests, see what stays green.
 *
 *   pnpm mutate              # every mutation
 *   pnpm mutate duck comp    # only labels/files matching a term
 *   pnpm mutate --list       # what would run, without running it
 *
 * A test suite that passes tells you the code does something. It does not
 * tell you the tests would NOTICE if it stopped. This does: each mutation is
 * a plausible bug, and a mutation that SURVIVES names a contract nothing is
 * asserting. That is the finding — not the mutation, the survival.
 *
 * Why not Stryker: it mutates exhaustively and automatically, which on this
 * repo means a very long run and a pile of equivalent mutants to triage. The
 * list in mutations.ts is hand-written and each entry names only the test
 * files meant to catch it, so a full pass is seconds and every survivor is
 * worth reading.
 *
 * SAFETY. Source files are edited in place and restored in a `finally`, and
 * again on SIGINT — but a hard kill (SIGKILL, a closed laptop) can still
 * leave a file mutated. So this refuses to start on a dirty tree: if it dies,
 * `git status` shows you exactly what to `git checkout --`.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MUTATIONS } from './mutations'
import type { Mutation } from './mutations'

const ROOT = join(__dirname, '..')

const args = process.argv.slice(2)
const listOnly = args.includes('--list')
const terms = args.filter((a) => !a.startsWith('--')).map((t) => t.toLowerCase())

const selected = terms.length === 0
  ? MUTATIONS
  : MUTATIONS.filter((m) => terms.some((t) => `${m.label} ${m.file}`.toLowerCase().includes(t)))

if (selected.length === 0) {
  console.error(`no mutation matches ${terms.join(' ')}`)
  process.exit(2)
}

if (listOnly) {
  for (const m of selected) console.log(`${m.file}\n  ${m.label}\n  -> ${m.tests}\n`)
  process.exit(0)
}

/* A dirty tree makes a crash unrecoverable: you cannot tell a mutation left
 * behind from your own edit. Cheap to check, and the failure it prevents is
 * losing work. */
const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim()
if (dirty !== '') {
  console.error('working tree is dirty — commit or stash first.\n')
  console.error('  this edits source files in place; on a hard kill you could not')
  console.error('  tell a leftover mutation from your own change.\n')
  console.error(dirty)
  process.exit(2)
}

/** Restore every file we have touched. Registered for SIGINT too, because
 *  Ctrl-C during a vitest run is the likely way this gets interrupted. */
const originals = new Map<string, string>()
const restoreAll = (): void => {
  for (const [path, src] of originals) writeFileSync(path, src)
  originals.clear()
}
process.on('SIGINT', () => { restoreAll(); process.exit(130) })
process.on('SIGTERM', () => { restoreAll(); process.exit(143) })

/** Run vitest on just this mutation's test files. Green means SURVIVED. */
const suitePasses = (tests: string): boolean => {
  const r = spawnSync('npx', ['vitest', 'run', ...tests.split(/\s+/)], { cwd: ROOT, encoding: 'utf8' })
  return r.status === 0
}

interface Result { m: Mutation; survived: boolean }

const results: Result[] = []
const skipped: Mutation[] = []

for (const m of selected) {
  const path = join(ROOT, m.file)
  const src = readFileSync(path, 'utf8')
  const hits = src.split(m.find).length - 1
  if (hits === 0) {
    // the anchor moved: the mutation is stale, which is a finding of its own
    skipped.push(m)
    console.log(`SKIP      ${m.label}\n          anchor not found in ${m.file}`)
    continue
  }
  originals.set(path, src)
  writeFileSync(path, src.replace(m.find, m.replace))
  let survived: boolean
  try {
    survived = suitePasses(m.tests)
  } finally {
    writeFileSync(path, src)
    originals.delete(path)
  }
  results.push({ m, survived })
  console.log(`${survived ? 'SURVIVED  ' : 'killed    '}${m.label}`)
}

const survivors = results.filter((r) => r.survived)
const killed = results.length - survivors.length

console.log(`\n${killed} killed · ${survivors.length} survived · ${skipped.length} stale`)

if (survivors.length > 0) {
  console.log('\nSURVIVORS — the contract in these tests is not being asserted:\n')
  for (const { m } of survivors) console.log(`  ${m.label}\n    ${m.file}  (tests: ${m.tests})\n`)
}
if (skipped.length > 0) {
  console.log('STALE — the code moved out from under these mutations:\n')
  for (const m of skipped) console.log(`  ${m.label}\n    ${m.file}\n`)
}

// survivors and stale anchors both mean the audit did not do its job
process.exit(survivors.length > 0 || skipped.length > 0 ? 1 : 0)
