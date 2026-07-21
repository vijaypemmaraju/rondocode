/* ------------------------------------------------------------------------- *
 * A small inline-SVG icon set (lucide-style: 24 viewBox, currentColor stroke,
 * round caps) so the chrome uses consistent line icons instead of emoji. No
 * external dependency — the paths are inlined. Use icon() for innerHTML or
 * iconEl() for a fresh element.
 * ------------------------------------------------------------------------- */

const ICONS: Record<string, string> = {
  // audio waveform — synth library
  waveform: '<path d="M2 12h2l2.5-7 4 15 3-10 2 5h6.5"/>',
  // sparkles — programmable visuals
  sparkles:
    '<path d="M11 3l1.6 4.4L17 9l-4.4 1.6L11 15l-1.6-4.4L5 9l4.4-1.6z"/><path d="M18 14l.8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8z"/>',
  // circled question — docs / reference
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.3 9.2a2.8 2.8 0 0 1 5.4 1c0 1.9-2.7 2.3-2.7 3.8"/><path d="M12 17.5h.01"/>',
  // horizontal faders — mixer
  sliders:
    '<path d="M4 7h9"/><path d="M17 7h3"/><circle cx="15" cy="7" r="2"/><path d="M4 17h3"/><path d="M11 17h9"/><circle cx="9" cy="17" r="2"/>',
  // plus — load sample
  plus: '<path d="M12 5v14M5 12h14"/>',
  // play (filled)
  play: '<path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none"/>',
  // stop (filled)
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
  // refresh — update while playing
  refresh: '<path d="M3 12a9 9 0 0 1 15-6.4L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.4L3 16"/><path d="M3 21v-5h5"/>',
  // close
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  // chevron down — dropdown affordance (project button)
  chevron: '<path d="m6 9 6 6 6-6"/>',
  // external link — "open full docs"
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5"/>',
  // rotate counter-clockwise — reset a widget to its default
  reset: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  // check — success confirmation
  check: '<path d="M20 6 9 17l-5-5"/>',
  // download — export to a file
  download: '<path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M5 21h14"/>',
  // record — filled dot
  record: '<circle cx="12" cy="12" r="6" fill="currentColor" stroke="none"/>',
  // dots — overflow "more" menu
  dots: '<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
  // midi — a little keyboard
  midi: '<rect x="3" y="7" width="18" height="10" rx="1.5"/><path d="M8 7v6M12 7v6M16 7v6"/>',
}

export function icon(name: string): string {
  const body = ICONS[name] ?? ''
  return `<svg class="ico" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`
}

/** A fresh SVG element for the named icon (each call returns a new node). */
export function iconEl(name: string): SVGSVGElement {
  const t = document.createElement('template')
  t.innerHTML = icon(name)
  return t.content.firstElementChild as SVGSVGElement
}
