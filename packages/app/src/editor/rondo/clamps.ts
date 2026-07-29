/* ------------------------------------------------------------------------- *
 * "You wrote 32; the engine is using 9."
 *
 * Voice options are clamped at synth() build — unison to [1, 9], spread and
 * humanize to [0, 1], curve to [0.2, 5], voices to [1, 64]. Silently: the
 * value you typed stays on screen and a different one plays. A real patch in
 * this repo had `unison:32 spread:32 humanize:32 curve:21` in a header, all
 * four of them clamped, and nothing said so — the numbers looked deliberate
 * and read as if they were doing something.
 *
 * The bounds are NOT restated here. The engine's own normalizeVoiceOpts is
 * INJECTED (see Hooks.voiceOptEffective), because a second copy of those
 * numbers in the editor would drift from the real ones the first time either
 * changed — which is exactly the failure this feature exists to surface. It
 * is injected rather than imported for the same reason wavetableBank is: a
 * static import would pull the audio engine into the docs page's bundle.
 * ------------------------------------------------------------------------- */

/** Resolves what the engine will actually use for a written voice option.
 *  Supplied by the app, which already has the engine loaded. */
export type EffectiveOpt = (name: string, written: number) => number


/** One written value the engine will not use as written. */
export interface ClampedOpt {
  /** the option name, e.g. 'unison'. */
  name: string
  /** what the source says. */
  written: number
  /** what synth() will actually use. */
  effective: number
  /** char offset just past the written number — where the chip anchors. */
  at: number
}

const codeText = (raw: string): string => {
  const m = /(^|\s)#/.exec(raw)
  return m === null ? raw : raw.slice(0, m.index + (m[1] ? m[1].length : 0))
}

/** Every voice option in the document whose written value the engine will
 *  change. Options it uses as written produce nothing — a chip on every number
 *  would be noise, and the whole point is that the surprising ones stand out.
 *
 *  Pure, so the rule is testable without an editor. */
export function scanClampedOpts(text: string, effectiveFor: EffectiveOpt): ClampedOpt[] {
  const out: ClampedOpt[] = []
  let off = 0
  for (const raw of text.split('\n')) {
    const line = codeText(raw)
    // only a top-level `synth`/`bus` header carries voice options
    if (/^(synth|bus)\b/.test(line)) {
      const re = /\b([a-zA-Z_]\w*)[ \t]*:[ \t]*(-?\d*\.?\d+)/g
      let m: RegExpExecArray | null
      while ((m = re.exec(line)) !== null) {
        const name = m[1]!
        const written = Number(m[2])
        if (!Number.isFinite(written)) continue
        const effective = effectiveFor(name, written)
        // an option the resolver does not know reports itself unchanged, so
        // an unrelated `name:number` on the header cannot produce a chip
        if (effective === written || !Number.isFinite(effective)) continue
        out.push({ name, written, effective, at: off + m.index + m[0].length })
      }
    }
    off += raw.length + 1
  }
  return out
}
