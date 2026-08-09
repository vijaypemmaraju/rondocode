/* Moved to packages/engine. The generators are pure functions of the sample
 * rate with no dependencies, and the OFFLINE renderer needs them as much as
 * the app does: `sample`, `granular` and `convolve` all resolve names against
 * a bank, and every headless render had an EMPTY one. Ten doc programs name a
 * built-in, and four of them rendered completely silent because of it.
 *
 * Living in the app layer was the whole reason. This file stays as a
 * re-export so the app's own imports keep reading naturally.
 *
 * It points at the MODULE, not the '@rondocode/engine' barrel: the docs page
 * loads the audio engine only on demand, and re-exporting through the barrel
 * dragged the whole engine into its eager graph (eager-graph.test.ts caught
 * it immediately). demo-samples has no imports of its own, so this costs
 * nothing. */
export {
  BUILT_IN_SAMPLE_NAMES,
  builtInSamples,
  makeVox,
  makePad,
  makeRiser,
  makeBreak,
  makeHall,
} from '../../../engine/src/demo-samples'
