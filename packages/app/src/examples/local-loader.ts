/** Structural stand-in for examples/index.ts's Example. Declared here rather
 *  than imported to keep this module free of a cycle with index.ts, which is
 *  what imports IT. */
export interface LocalExample {
  name: string
  code: string
  [k: string]: unknown
}

/* ------------------------------------------------------------------------- *
 * Private/WIP examples from `./local/`, which is gitignored.
 *
 * This lives in its OWN module because of how it must be excluded. The glob is
 * `eager: true`, so Vite rewrites it into static imports at the top of whatever
 * module contains it — and static imports are bundled whether or not anything
 * reachable uses them. A runtime `if (import.meta.env.DEV)` guard therefore
 * does NOT keep local examples out of a production build: it only stops them
 * being listed, while the code still ships.
 *
 * So vite.config.ts ALIASES this module to local-loader.prod.ts for a
 * production build, and the local sources are never resolved at all.
 * ------------------------------------------------------------------------- */

export function loadLocalExamples(): LocalExample[] {
  let mods: Record<string, unknown> = {}
  try {
    // MUST be a direct literal call — Vite rewrites `import.meta.glob('…')` at
    // build time (reading it into a variable first defeats that and loads
    // nothing). Under plain node (the tsx render tools) import.meta.glob is
    // undefined, so the call throws and we fall back to no local examples.
    // @ts-ignore import.meta.glob is a Vite-only macro, untyped outside the app tsconfig
    mods = import.meta.glob('./local/*.{ts,js}', { eager: true }) as Record<string, unknown>
  } catch {
    return []
  }
  return Object.values(mods).flatMap((m) => {
    const v = (m as { default?: unknown }).default
    if (Array.isArray(v)) return v as LocalExample[]
    if (v !== null && typeof v === 'object' && 'code' in (v as object)) return [v as LocalExample]
    return []
  })
}
