/* DEV-only: expose the singing engine on window so it can be driven from the
 * console during bring-up (loading is ~250MB so it's fire-and-forget + polled).
 * Never imported in production (main.ts gates it behind import.meta.env.DEV). */
import { loadEngine, type SupertonicEngine, type SingProgress } from './supertonic'
import { sing, singWithLyrics, renderSung, type Note, type AlignedSpeech } from './sing'
import { parseLyrics } from './lyrics'

interface Hook {
  state: string
  progress: SingProgress | null
  engine: SupertonicEngine | null
  audio: Float32Array | null
  sr: number
  load(): void
  say(text: string): Promise<{ len: number; sr: number; rms: number; peak: number }>
  sing(text: string, melody: Note[]): Promise<{ len: number; sr: number; peak: number }>
  singLyrics(lyrics: string, melody: Note[], opts?: { unpitched?: boolean }): Promise<{ len: number; sr: number; peak: number }>
  /** DEV: last captured TTS+alignment, for deterministic DSP re-rendering. */
  captured: (AlignedSpeech & { lyrics: string }) | null
  /** DEV: re-run only the DSP stage on the captured speech (no fresh TTS) — so
   *  PSOLA/level/placement tuning can be A/B'd without TTS randomness. Pass a
   *  lyrics string to re-capture; omit to reuse the last capture. */
  resing(melody: Note[], lyrics?: string, opts?: { unpitched?: boolean }): Promise<{ len: number; sr: number; peak: number }>
  /** DEV: prove in-browser RVC — convert the last say()/sing() audio to a singer
   *  voice at a constant f0. Verifies ContentVec + generator run via WebGPU. */
  testRvc(voiceId?: string): Promise<{ len: number; sr: number }>
  /** DEV: the FULL neural pipeline in-browser — TTS → phoneme CTC → vowel-aware
   *  warp → RVC. `melody` is a "midi:dur[:s]" spec (see warp.parseMelody). */
  singNeural(lyrics: string, melody: string, voiceId?: string): Promise<{ len: number; sr: number; phones: string; ms: Record<string, number> }>
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
    async singLyrics(lyrics: string, melody: Note[], opts: { unpitched?: boolean } = {}) {
      if (!this.engine) throw new Error('not loaded')
      const { audio, sr } = await singWithLyrics(this.engine, lyrics, melody, {
        capture: (c) => (this.captured = { ...c, lyrics }),
        unpitched: opts.unpitched,
      })
      this.audio = audio
      this.sr = sr
      let peak = 0
      for (let i = 0; i < audio.length; i++) peak = Math.max(peak, Math.abs(audio[i]!))
      return { len: audio.length, sr, peak }
    },
    captured: null,
    async testRvc(voiceId = 'kizuna') {
      if (!this.audio) throw new Error('call say()/sing() first to get a guide track')
      const { loadRvc, rvcConvert } = await import('./rvc')
      await loadRvc(voiceId, (p) => (this.progress = { phase: 'download', label: p.label, done: p.done, total: p.total }))
      const f0 = new Float32Array(200).fill(330) // constant ~E4 to prove it sings
      const { audio, sr } = await rvcConvert(this.audio, this.sr, f0, voiceId)
      this.audio = audio
      this.sr = sr
      return { len: audio.length, sr }
    },
    async singNeural(lyrics: string, melody: string, voiceId = 'kizuna') {
      if (!this.engine) throw new Error('not loaded')
      const [{ parseLyrics }, { loadPhonemes, extractPhonemes }, warp, { loadRvc, rvcConvert }] = await Promise.all([
        import('./lyrics'), import('./phonemes'), import('./warp'), import('./rvc'),
      ])
      const ms: Record<string, number> = {}
      const clk = (k: string, t: number): void => void (ms[k] = Math.round(performance.now() - t))
      const parsed = parseLyrics(lyrics)
      const notes = warp.parseMelody(melody)
      const sr = this.engine.sampleRate
      let t = performance.now()
      const spoken = await this.engine.synthesize(parsed.text, { onProgress: (p) => (this.progress = p) })
      clk('tts', t)
      t = performance.now()
      await loadPhonemes((p) => (this.progress = { phase: 'download', label: p.label, done: p.done, total: p.total }))
      const phones = await extractPhonemes(spoken, sr)
      clk('phonemes', t)
      t = performance.now()
      const { guide, f0 } = warp.buildGuide(spoken, sr, phones, notes)
      clk('warp', t)
      t = performance.now()
      await loadRvc(voiceId, (p) => (this.progress = { phase: 'download', label: p.label, done: p.done, total: p.total }))
      const { audio, sr: osr } = await rvcConvert(guide, sr, f0, voiceId)
      clk('rvc', t)
      this.audio = audio
      this.sr = osr
      return { len: audio.length, sr: osr, phones: phones.map((p) => p.sym).join(' '), ms }
    },
    async resing(melody: Note[], lyrics?: string, opts: { unpitched?: boolean } = {}) {
      if (lyrics && lyrics !== this.captured?.lyrics) {
        // need a fresh capture for new lyrics
        return this.singLyrics(lyrics, melody, opts)
      }
      if (!this.captured) throw new Error('no captured speech; call singLyrics(lyrics, melody) first')
      const parsed = parseLyrics(this.captured.lyrics)
      const audio = renderSung(this.captured, parsed, melody, { unpitched: opts.unpitched })
      this.audio = audio
      this.sr = this.captured.sr
      let peak = 0
      for (let i = 0; i < audio.length; i++) peak = Math.max(peak, Math.abs(audio[i]!))
      return { len: audio.length, sr: this.captured.sr, peak }
    },
  }
  ;(window as unknown as { __rcSing: Hook }).__rcSing = hook
}
