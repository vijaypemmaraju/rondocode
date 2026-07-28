/** Structural stand-in for examples/index.ts's Example. Declared here rather
 *  than imported to keep this module free of a cycle with index.ts, which is
 *  what imports IT. */
export interface LocalExample {
  name: string
  code: string
  [k: string]: unknown
}

/* The production stand-in for local-loader.ts (see vite.config.ts's alias).
 *
 * It exists so that a release build cannot resolve `./local/*` at all. The
 * real loader's glob is eager, which means Vite emits static imports for every
 * match — those get BUNDLED even when nothing reachable reads them, so a
 * private example would ship inside the JavaScript while being invisible in
 * the UI. Swapping the module is the only way to be sure. */
export function loadLocalExamples(): LocalExample[] {
  return []
}
