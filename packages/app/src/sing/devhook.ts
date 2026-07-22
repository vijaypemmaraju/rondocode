/* DEV-only: expose the singing engine on window so it can be driven from the
 * console during bring-up (loading is large so it's fire-and-forget + polled).
 * Never imported in production (main.ts gates it behind import.meta.env.DEV). */
import { loadEngine, type SupertonicEngine, type SingProgress } from './supertonic'

interface Hook {
  state: string
  progress: SingProgress | null
  engine: SupertonicEngine | null
  audio: Float32Array | null
  sr: number
  load(): void
  say(text: string): Promise<{ len: number; sr: number; rms: number; peak: number }>
  /** DEV: prove in-browser RVC — convert the last say() audio to a singer voice
   *  at a constant f0. Verifies ContentVec + generator run via WebGPU. */
  testRvc(voiceId?: string): Promise<{ len: number; sr: number }>
  /** DEV: the FULL neural pipeline in-browser — TTS → phoneme forced-alignment →
   *  vowel-on-beat warp → RVC. BOTH lyrics and notes are mini-notation, aligned
   *  one note per syllable; `cps` (cycles/sec) sets the tempo. */
  singNeural(lyrics: string, notes: string, cps?: number, voiceId?: string): Promise<{ len: number; sr: number; ms: Record<string, number> }>
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
    async testRvc(voiceId = 'kizuna') {
      if (!this.audio) throw new Error('call say() first to get a guide track')
      const { loadRvc, rvcConvert } = await import('./rvc')
      await loadRvc(voiceId, (p) => (this.progress = { phase: 'download', label: p.label, done: p.done, total: p.total }))
      const f0 = new Float32Array(200).fill(330) // constant ~E4 to prove it sings
      const { audio, sr } = await rvcConvert(this.audio, this.sr, f0, voiceId)
      this.audio = audio
      this.sr = sr
      return { len: audio.length, sr }
    },
    async singNeural(lyrics: string, notes: string, cps = 0.5, voiceId = 'kizuna') {
      const t = performance.now()
      const { renderNeural } = await import('./neural')
      const { audio, sr } = await renderNeural(lyrics, notes, cps, voiceId, (p) => (this.progress = p as SingProgress))
      this.audio = audio
      this.sr = sr
      return { len: audio.length, sr, ms: { total: Math.round(performance.now() - t) } }
    },
  }
  ;(window as unknown as { __rcSing: Hook }).__rcSing = hook
}
