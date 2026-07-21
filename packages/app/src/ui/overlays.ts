/* A minimal registry so the app's full-screen sheets (projects, reference,
 * synth library) are mutually exclusive: opening one closes any other. Each
 * overlay passes its own close fn; opening it closes the rest. */

type Closer = () => void

const openClosers = new Set<Closer>()

/** Call when an overlay opens: closes every other registered-open overlay,
 *  then marks this one open. */
export function overlayOpened(self: Closer): void {
  for (const c of openClosers) if (c !== self) c()
  openClosers.add(self)
}

/** Call when an overlay closes. */
export function overlayClosed(self: Closer): void {
  openClosers.delete(self)
}
