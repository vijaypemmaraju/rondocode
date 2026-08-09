import { describe, expect, it } from 'vitest'
import { compile } from '@rondocode/rondo'
import { RENAMED_LANES, n, TimeSpan, F, hasOnset } from '@rondocode/pattern'
import { stageCode } from '../../server/src/render-runner'
import { RECIPES } from '../src/docs/cookbook'
import { EXAMPLES } from '../src/examples'
import { runnableCodeBlocks } from '../src/docs/content'
import { DSL_DOCS } from '../src/docs/dsl-docs'

/* ------------------------------------------------------------------------- *
 * TWO WORDS CHANGED MEANING, AND EVERY SHIPPED PROGRAM HAD TO MOVE.
 *
 *   `sidechain release:` is MILLISECONDS now. It was seconds here and only
 *     here, while compress, noisegate, deess, limiter, follow and
 *     masterCompress all took ms — the same word, 1000x apart.
 *   `'vel:` and `'len:` are `'gain:` and `'dur:`. A lane is named after the
 *     control it sets; `len` was a pure synonym for `dur`, and `vel` meant a
 *     note said one word for the thing the modifier line below it called
 *     another.
 *
 * An unmigrated program does not fail loudly on its own. A stale `'vel:.8`
 * becomes `param('vel')` — a live control nothing reads — and a stale
 * `release:.2` would have been a 0.2 ms click. So the DSL rejects both, and
 * this asserts that every surface a reader can copy from has actually moved.
 * ------------------------------------------------------------------------- */

interface Prog { label: string; code: string; rondo: boolean }

function surfaces(): Prog[] {
  const out: Prog[] = []
  for (const r of RECIPES) out.push({ label: `recipe:${r.id}`, code: r.code, rondo: true })
  for (const e of EXAMPLES) out.push({ label: `example:${e.name}`, code: e.rondo ?? e.code, rondo: e.rondo !== undefined })
  runnableCodeBlocks().forEach((b, i) => out.push({ label: `guide:${b.id} #${i}`, code: b.text, rondo: b.lang === 'rondo' }))
  for (const d of DSL_DOCS) {
    if (d.example !== undefined && d.example !== '') out.push({ label: `reference:${d.name}`, code: d.example, rondo: false })
  }
  return out
}

const all = surfaces()

describe('every shipped program moved with the breaking changes', () => {
  it('collects a real corpus — an empty one would pass everything', () => {
    expect(all.length).toBeGreaterThan(80)
  })

  describe('no lane still uses its OLD name', () => {
    for (const [old, now] of RENAMED_LANES) {
      it(`'${old}: is gone (it is '${now}: now)`, () => {
        const stale = all.filter((p) => new RegExp(`'${old}\\s*:`).test(p.code)).map((p) => p.label)
        expect(
          stale,
          `these still write '${old}:, which no longer means anything structural — `
            + `it would reach the synth as param('${old}') and do nothing: ${stale.join(', ')}`,
        ).toEqual([])
      })
    }
  })

  it('no sidechain release is still written in SECONDS', () => {
    /* Anything under 5 was a seconds value: a duck that recovers in under
     * 5 ms is a click, not a pump, so there is no legitimate reading of a
     * small number here. */
    const stale: string[] = []
    for (const p of all) {
      for (const line of p.code.split('\n')) {
        if (!line.includes('sidechain')) continue
        const m = /release['"]?:\s*(\d*\.?\d+)/.exec(line)
        if (m !== null && Number(m[1]) > 0 && Number(m[1]) < 5) stale.push(`${p.label} (${m[1]})`)
      }
    }
    expect(stale, `still in seconds: ${stale.join(', ')}`).toEqual([])
  })

  it('and the reference PROSE says milliseconds', () => {
    const sc = DSL_DOCS.find((d) => d.name === 'sidechain')
    expect(sc, 'the sidechain reference entry is gone').toBeDefined()
    expect(sc!.summary.toLowerCase()).toContain('millisecond')
    expect(sc!.summary.toLowerCase(), 'the entry still claims seconds').not.toContain('in seconds')
  })
})

describe('and every shipped program still runs', () => {
  /* The migration is only real if the result works. A regex sweep that turned
   * `release:.15` into `release:150` inside the wrong line would pass every
   * check above and break the program. */
  for (const p of all.filter((x) => x.rondo)) {
    it(`${p.label} compiles and stages`, () => {
      const c = compile(p.code)
      expect(c.ok, `does not compile: ${JSON.stringify(c.errors?.[0])}`).toBe(true)
      if (!c.ok) return
      const st = stageCode(c.code)
      const errs = st.ok ? [] : st.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message)
      expect(errs, errs.join(' | ')).toEqual([])
    })
  }
})

describe('the DSL rejects the old spellings rather than ignoring them', () => {
  it('a seconds-shaped sidechain release names the fix', () => {
    const st = stageCode(`const k = synth(({ gate, adsr, sine }) => sine(50).mul(adsr(gate, {})))
p('k', n('0').sound('k'))
sidechain('k', { release: 0.2 })`)
    expect(st.ok).toBe(false)
    if (st.ok) return
    const msg = st.diagnostics.map((d) => d.message).join(' ')
    expect(msg).toContain('MILLISECONDS')
    expect(msg, 'the error should say what to write instead').toContain('200')
  })

  for (const [old, now] of RENAMED_LANES) {
    it(`'${old}: is refused, and the message says to write '${now}:`, () => {
      /* Silence is the one outcome that would be wrong: an unknown lane is
       * forwarded to the synth as a param, so a stale `'vel:.8` would become
       * a live `param('vel')` that nothing reads. */
      expect(() => n(`0'${old}:.8`).query(new TimeSpan(F(0), F(1))))
        .toThrow(new RegExp(`'${old}'.*'${now}'`))
    })

    it(`'${now}: is accepted and lands on the control`, () => {
      const haps = n(`0'${now}:.8`).query(new TimeSpan(F(0), F(1))).filter(hasOnset)
      expect((haps[0]!.value as Record<string, unknown>)[now], `'${now}: did not set ${now}`).toBe(0.8)
    })
  }

  it('an UNKNOWN lane is still forwarded to the synth as a param', () => {
    // the rename must not have turned the open lane namespace into a closed one
    const haps = n(`0'cut:.7`).query(new TimeSpan(F(0), F(1))).filter(hasOnset)
    expect((haps[0]!.value as Record<string, unknown>)['cut']).toBe(0.7)
  })
})
