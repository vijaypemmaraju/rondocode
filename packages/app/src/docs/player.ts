import { AudioSession } from '../audio/AudioSession'
import { Session } from '../session'
import type { SchedulerEvent } from '@rondocode/pattern'

/* ------------------------------------------------------------------------- *
 * PreviewPlayer — a self-contained audio engine for auditioning snippets
 * away from the editor's live session (the docs page has no editor; the synth
 * library must not clobber the user's running track). It lazily boots its OWN
 * AudioSession + Session on the first play (satisfying the browser's
 * gesture-unlock requirement from the click that triggered it), and plays one
 * snippet at a time — starting a new one stops whatever was sounding.
 * ------------------------------------------------------------------------- */

export interface PlayResult {
  ok: boolean
  error?: string
}

export class PreviewPlayer {
  private audio: AudioSession | null = null
  private session: Session | null = null
  private booting: Promise<void> | null = null

  /** Fired whenever playback stops (either explicitly or when replaced), so a
   *  UI can reset its "playing" affordance. */
  onStop?: () => void

  /** Scheduler events for the currently-playing snippet, so the caller can
   *  drive a flash decoration on the editor that owns it. Re-pointed per play. */
  onPatternEvents?: (evs: SchedulerEvent[]) => void

  /** True while a snippet is sounding. */
  get playing(): boolean {
    return this.session?.getState().playing ?? false
  }

  /** Audio clock in seconds (0 before the engine boots) — the time base a
   *  flasher needs to schedule its pulses against. */
  now(): number {
    return this.audio ? this.audio.currentTimeFrames / this.audio.sampleRate : 0
  }

  private async ensure(): Promise<void> {
    if (this.session) return
    if (!this.booting) {
      this.booting = (async () => {
        const audio = await AudioSession.start()
        this.audio = audio
        this.session = new Session({
          audio,
          onPatternEvents: (evs) => this.onPatternEvents?.(evs),
        })
      })()
    }
    await this.booting
  }

  /** Evaluate `code` and play it. Returns eval success; a failed eval leaves
   *  the engine untouched (last-good contract) and produces no sound. */
  async play(code: string): Promise<PlayResult> {
    await this.ensure()
    const session = this.session
    const audio = this.audio
    if (!session || !audio) return { ok: false, error: 'audio unavailable' }
    // Stop whatever is currently sounding before staging the new snippet.
    session.transport('stop')
    const result = session.evalCode(code)
    if (!result.ok) {
      const msg = result.diagnostics.find((d) => d.severity === 'error')?.message
      return { ok: false, error: msg ?? 'evaluation failed' }
    }
    void audio.resume()
    session.transport('play')
    return { ok: true }
  }

  /** Stop playback (panic all-notes-off) and notify listeners. */
  stop(): void {
    this.session?.transport('stop')
    this.onStop?.()
  }

  dispose(): void {
    this.session?.dispose()
    this.session = null
    this.audio = null
    this.booting = null
  }
}
