/* DEV-only: expose the singing engine on window so it can be driven from the
 * console during bring-up (loading is ~250MB so it's fire-and-forget + polled).
 * Never imported in production (main.ts gates it behind import.meta.env.DEV). */
import { loadEngine, type SupertonicEngine, type SingProgress } from './supertonic'
import { sing, type Note } from './sing'

interface Hook {
  state: string
  progress: SingProgress | null
  engine: SupertonicEngine | null
  audio: Float32Array | null
  sr: number
  load(): void
  say(text: string): Promise<{ len: number; sr: number; rms: number; peak: number }>
  sing(text: string, melody: Note[]): Promise<{ len: number; sr: number; peak: number }>
}

export function installSingDevHook(): void {
  const hook: Hook = {
    state: 'idle',
    progress: null,
    engine: null,
    audio: null,
    sr: 44100,
    load() {
      this.state = 'loading'
      loadEngine((p) => (this.progress = p)).then(
        (e) => {
          this.engine = e
          this.state = 'ready'
        },
        (e: unknown) => (this.state = 'error: ' + (e instanceof Error ? e.message : String(e))),
      )
    },
    async say(text: string) {
      if (!this.engine) throw new Error('not loaded')
      const a = await this.engine.synthesize(text, { onProgress: (p) => (this.progress = p) })
      this.audio = a
      let sum = 0
      let peak = 0
      for (let i = 0; i < a.length; i++) {
        sum += a[i]! * a[i]!
        peak = Math.max(peak, Math.abs(a[i]!))
      }
      return { len: a.length, sr: this.engine.sampleRate, rms: Math.sqrt(sum / a.length), peak }
    },
    async sing(text: string, melody: Note[]) {
      if (!this.engine) throw new Error('not loaded')
      const { audio, sr } = await sing(this.engine, text, melody, { onProgress: (p) => (this.progress = { phase: p.phase as 'download' | 'synthesize', label: p.phase, done: p.done, total: p.total }) })
      this.audio = audio
      this.sr = sr
      let peak = 0
      for (let i = 0; i < audio.length; i++) peak = Math.max(peak, Math.abs(audio[i]!))
      return { len: audio.length, sr, peak }
    },
  }
  ;(window as unknown as { __rcSing: Hook }).__rcSing = hook
}
