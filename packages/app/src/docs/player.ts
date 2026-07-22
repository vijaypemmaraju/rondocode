import { AudioSession } from '../audio/AudioSession'
import { Session } from '../session'
import { makeVox, makeRiser, makePad } from '../audio/demo-samples'
import * as singMgr from '../sing/singMgr'
import { mountSingDialog, confirmSingDownload } from '../ui/singDialog'
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
  /** Synth/channel names of the currently-playing snippet's sing() vocals, so a
   *  docs snippet's karaoke can spot their trigger events (incl. renamed ones). */
  private _singSounds = new Set<string>()

  /** The current snippet's sing() vocal channel names (for karaoke detection). */
  get singSounds(): Set<string> {
    return this._singSounds
  }

  /** Fired whenever playback stops (either explicitly or when replaced), so a
   *  UI can reset its "playing" affordance. */
  onStop?: () => void

  /** Scheduler events for the currently-playing snippet, so the caller can
   *  drive a flash decoration on the editor that owns it. Re-pointed per play. */
  onPatternEvents?: (evs: SchedulerEvent[]) => void

  /** The staged WGSL of the last good eval (or null) + its synth names — so the
   *  docs page can render a snippet's visual() inline. Fired per successful eval. */
  onVisual?: (wgsl: string | null, synths: string[]) => void

  /** The audio analyser (spectrum/waveform tap), available once booted. */
  get analyser(): AnalyserNode | null {
    return this.audio?.analyser ?? null
  }

  /** Engine sample rate (0 before boot). */
  get sampleRate(): number {
    return this.audio?.sampleRate ?? 48000
  }

  /** Current tempo (cps) of the playing snippet — for the visualizer's phase. */
  get cps(): number {
    return this.session?.getState().cps ?? 0.5
  }

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
        // load the built-in demo samples so sample()/granular() snippets are audible here too
        try {
          audio.loadSamplePcm('vox', makeVox(audio.sampleRate), audio.sampleRate, true)
          audio.loadSamplePcm('riser', makeRiser(audio.sampleRate), audio.sampleRate, true)
          audio.loadSamplePcm('pad', makePad(audio.sampleRate), audio.sampleRate, true)
        } catch {
          /* samples optional — snippets that don't use them still play */
        }
        this.session = new Session({
          audio,
          onPatternEvents: (evs) => this.onPatternEvents?.(evs),
          onVisual: (wgsl, synths) => this.onVisual?.(wgsl, synths),
        })
        // sing() support: the neural vocal bakes through the same manager +
        // dialogs as the editor, so a sing() snippet plays here identically.
        singMgr.initSing(audio)
        mountSingDialog()
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
    this._singSounds = new Set(result.sings.map((s) => s.synthName))
    void audio.resume()
    // sing(): if the snippet has a vocal that isn't baked yet, download the
    // models (with first-time consent) and WAIT so it plays in time — the same
    // preload path the editor's first Run uses. Already-baked vocals just play.
    if (result.sings.length > 0) {
      const cps = result.cps ?? session.getState().cps
      if (singMgr.hasUnloaded(result.sings, cps)) {
        if (!(await singMgr.modelsCached()) && !(await confirmSingDownload())) {
          session.transport('play') // declined the download: play without the vocal
          return { ok: true }
        }
        singMgr.bake(result.sings, cps)
        await singMgr.whenReady(result.sings, cps)
      }
    }
    session.transport('play')
    return { ok: true }
  }

  /** Live-update the currently-playing snippet without restarting the
   *  transport — the hot-patch path a widget/scrub drag uses. A failed eval is
   *  ignored (last-good contract), and it's a no-op before the engine boots or
   *  when nothing is playing. */
  update(code: string): void {
    if (!this.session || !this.playing) return
    this.session.evalCode(code, { live: true })
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
