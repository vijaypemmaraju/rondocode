import { Facet } from '@codemirror/state'

/** True while the rondo language is active.
 *
 *  Lives in its own module so the JS hover and the rondo LanguageSupport can
 *  both see it without importing each other. The JS DSL hover is a BASE
 *  extension (setup.ts) and therefore runs in rondo documents too — where it
 *  answered every builtin with the JavaScript call shape, `svf(inp, cutoff,
 *  opts?)`, for a language whose actual spelling is `svf cutoff res:…`. It
 *  stands down when this is set. */
export const rondoMode = Facet.define<true, boolean>({
  combine: (values) => values.length > 0,
})
