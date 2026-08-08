import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/* ------------------------------------------------------------------------- *
 * WHAT A PUBLIC REPO MUST NOT CARRY.
 *
 * This is an open-source repository, and two things got into it that should
 * not have:
 *
 *   COVERAGE REPORTS. `coverage/` was not gitignored, so one `git add -A`
 *     after a --coverage run committed 284 files. Istanbul's HTML embeds the
 *     full SOURCE of everything it covers, which included twelve gitignored
 *     local examples — unreleased music, published to GitHub by accident.
 *   PERSONAL PATHS. The MCP render mirror defaulted to one developer's
 *     Dropbox folder, hardcoded. Not a secret, but a real username in a
 *     public repo, and for everyone else a path that does not exist.
 *
 * Both were found by reading `git diff --name-only`, which is not a habit
 * that scales. These assert it instead.
 * ------------------------------------------------------------------------- */

const ROOT = join(__dirname, '../../..')
const tracked = (): string[] =>
  execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n')
    .filter((l) => l !== '')

describe('the repository carries nothing it should not publish', () => {
  const files = tracked()

  it('finds the file list (an empty one would make this vacuous)', () => {
    expect(files.length).toBeGreaterThan(200)
  })

  it('tracks no build artifacts — coverage/, dist/, logs', () => {
    const junk = files.filter((f) =>
      /(^|\/)(coverage|dist|build|node_modules|target)\//.test(f) || /\.(log|tsbuildinfo)$/.test(f),
    )
    expect(junk, 'build output is tracked').toEqual([])
  })

  it('tracks NO local example, in any form — they are unreleased music', () => {
    // not just src/examples/local/*.ts: a coverage report of one is the same
    // source in a different wrapper, and that is exactly how it leaked
    const leaked = files.filter((f) => f.includes('examples/local/'))
    expect(leaked, 'a local example is published').toEqual([])
  })

  it('tracks no secret-shaped file', () => {
    const secrets = files.filter((f) =>
      /(^|\/)\.env$|\.pem$|\.key$|\.p12$|\.keystore$|id_rsa|\.mobileprovision$/.test(f),
    )
    expect(secrets).toEqual([])
  })

  it('hardcodes nobody home directory in shipped source', () => {
    // a path under /Users/<name> is both a leaked username and, for everyone
    // else, a path that does not exist
    const bad: string[] = []
    for (const f of files) {
      if (!/^packages\/.*\/src\/.*\.ts$|^scripts\/.*\.ts$/.test(f)) continue
      /* scripts/mutations.ts is the mutation CATALOGUE: it contains the bad
       * path on purpose, as the payload of the mutation that re-introduces
       * it. Excluding the one file that must hold the regression is honest;
       * loosening the pattern so it stops matching would not be. */
      if (f === 'scripts/mutations.ts') continue
      const p = join(ROOT, f)
      if (!existsSync(p)) continue
      const text = readFileSync(p, 'utf8')
      for (const m of text.matchAll(/['"`](\/Users\/[^'"`\s]+)['"`]/g)) {
        // /Users/x is the conventional placeholder in tests and docs
        if (!/^\/Users\/(x|you|someone|username)\b/.test(m[1]!)) bad.push(`${f}: ${m[1]}`)
      }
    }
    expect(bad, 'a real home directory is in shipped source').toEqual([])
  })

  it('.gitignore covers the things that caused this', () => {
    const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8')
    for (const pat of ['coverage/', 'node_modules', 'dist', '.env', '*.log']) {
      expect(ignore, `.gitignore is missing ${pat}`).toContain(pat)
    }
  })

  it('every package declares its license, and NOTICE credits the ports', () => {
    const pkgs = files.filter((f) => /^packages\/[^/]+\/package\.json$/.test(f))
    expect(pkgs.length).toBeGreaterThan(3)
    for (const f of pkgs) {
      const pkg = JSON.parse(readFileSync(join(ROOT, f), 'utf8')) as { license?: string }
      expect(pkg.license, `${f} has no license field`).toBe('MIT')
    }
    // the DSP is written from scratch but implements published algorithms;
    // an MIT repo that borrows ideas should name them
    const notice = readFileSync(join(ROOT, 'NOTICE.md'), 'utf8')
    for (const who of ['Freeverb', 'Bristow-Johnson', 'Simper', 'TidalCycles', 'Strudel', 'Bjorklund']) {
      expect(notice, `NOTICE.md does not credit ${who}`).toContain(who)
    }
  })
})
