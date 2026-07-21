/* ------------------------------------------------------------------------- *
 * The UI palette — SINGLE source of truth for every shared color.
 *
 * Three consumers, one origin:
 * - main.ts calls applyPalette() on boot, writing each entry as a :root CSS
 *   custom property, so style.css styles with var(--c-*) and never repeats
 *   a hex.
 * - theme.ts (CodeMirror theme) imports the consts directly — CM themes are
 *   JS-built style sheets, so vars would work there too, but consts keep the
 *   theme usable standalone (tests, SSR-ish tooling) without a DOM boot step.
 * - viz.ts paints canvases with the consts (canvas 2D has no var() access).
 *
 * One-off colors that exist in exactly one place (syntax highlight hues,
 * the error-strip reds, flash rgba ramps) stay where they are used — this
 * file is for colors with more than one consumer, not a registry of every
 * shade in the app.
 * ------------------------------------------------------------------------- */

/* Oscilloscope Lab palette — the UI reads like looking through scope glass:
 * a green-cast black, faint graticule lines, a phosphor-mint trace with a cyan
 * tip, and amber as the second (warning) channel. Cool green-tinted text, not
 * neutral gray — everything is "on the display". */
export const C_BG = '#050807' // scope glass — near-black with a faint green cast
export const C_BAR = '#0a100e' // header / viz panel bezel
export const C_SURFACE = '#0e1512' // inputs, selects
export const C_RAISED = '#14201b' // buttons, meter tracks, tooltips
export const C_BORDER = '#1e352c' // hairline control borders (green-cast)
export const C_TEXT = '#c8e6da' // cool phosphor-white
export const C_DIM = '#6f9284' // secondary text
export const C_FAINT = '#3c5249' // gutter numbers, graticule-adjacent
export const C_ACCENT = '#6ee7b7' // phosphor mint — the primary trace/accent
export const C_ACCENT_ALT = '#67e8f9' // cyan trace-tip (meter/scope gradient)
export const C_GREEN = '#155e45' // run-button / selection phosphor
export const C_GREEN_DEEP = '#0b2c20'
export const C_WARN = '#f2b155' // amber channel
export const C_ERROR = '#ff6b6b'
export const C_ERROR_BG = '#170c0a' // error surfaces (status strip, boot error)
export const C_ERROR_BORDER = '#3a1e18'
/** Faint graticule grid line color (the scope's measurement grid). */
export const C_GRID = '#12241d'

export const CSS_VARS: Readonly<Record<string, string>> = {
  '--c-bg': C_BG,
  '--c-bar': C_BAR,
  '--c-surface': C_SURFACE,
  '--c-raised': C_RAISED,
  '--c-border': C_BORDER,
  '--c-text': C_TEXT,
  '--c-dim': C_DIM,
  '--c-faint': C_FAINT,
  '--c-accent': C_ACCENT,
  '--c-accent-alt': C_ACCENT_ALT,
  '--c-green': C_GREEN,
  '--c-green-deep': C_GREEN_DEEP,
  '--c-warn': C_WARN,
  '--c-error': C_ERROR,
  '--c-error-bg': C_ERROR_BG,
  '--c-error-border': C_ERROR_BORDER,
  '--c-grid': C_GRID,
}

/** Write the palette as CSS custom properties (call once on boot, before
 *  anything renders — style.css consumes these with no fallbacks). */
export const applyPalette = (root: HTMLElement = document.documentElement): void => {
  for (const [name, hex] of Object.entries(CSS_VARS)) root.style.setProperty(name, hex)
}
