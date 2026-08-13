/* ------------------------------------------------------------------------- *
 * Which synths the MIDI panel offers, and what it says about them.
 *
 * Reported by a user loading preset after preset: the picker kept showing the
 * first one's four FM instruments. The list came from the RUNNING program, and
 * loading a preset deliberately does not run it -- so the panel described a
 * tune that was no longer on screen, and the only way to refresh it was the Run
 * they had not realised was needed. ("Wait, I had to hit run and it began
 * getting midi.")
 *
 * Both halves of that are one rule: offer what is in the BUFFER, and say which
 * of it is not staged. Notes go to the engine by NAME, so a name it has never
 * been given is silence -- and silence is exactly what the panel had no way to
 * explain.
 *
 * Pure, because "what does the picker show after I load this" is a question
 * that should have an answer without a browser.
 * ------------------------------------------------------------------------- */

/** One entry in the picker: the value is always the bare synth name. */
export interface SynthOption {
  value: string
  label: string
  /** true when the engine has this synth staged, so notes will reach it */
  running: boolean
}

export interface SynthListView {
  options: SynthOption[]
  /** Empty when everything offered is playable. */
  notice: string
}

/**
 * The picker's contents for a buffer and a staged program.
 *
 * `inBuffer` wins because it is the code on screen. It falls back to `staged`
 * only when the buffer yields nothing at all -- a language the outline cannot
 * read, or a parse that failed mid-edit -- since showing the running program is
 * better than showing an empty list.
 */
export function synthListView(
  inBuffer: readonly string[],
  staged: readonly string[],
): SynthListView {
  const names = inBuffer.length > 0 ? [...inBuffer] : [...staged]
  const options = names.map((value) => {
    const running = staged.includes(value)
    return { value, label: running ? value : `${value} (not running)`, running }
  })
  const unstaged = options.filter((o) => !o.running).map((o) => o.value)
  const notice = unstaged.length === 0
    ? ''
    // nothing staged at all is the FIRST-RUN case, and naming the synths there
    // would be a list of everything, which says less than the reason does
    : staged.length === 0
      ? 'nothing is running yet: press Run to stage this program, then play it.'
      : `not running yet: ${unstaged.join(', ')}. Press Run to stage the current code.`
  return { options, notice }
}
