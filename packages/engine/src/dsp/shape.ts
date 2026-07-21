import type { DspContext, Kernel } from './types'
import { clamp } from './util'

export type ShapeType = 'soft' | 'hard' | 'sine' | 'tube'

/** Drive waveshaper (distortion). Inputs 'in' and 'drive' (audio-rate, clamped
 *  per sample to [1, 40]). The input is multiplied by `drive` and passed
 *  through one of four curves, each bounded to roughly [-1, 1]:
 *   - soft: tanh(drive*x)          — smooth, warm saturation
 *   - hard: clip(drive*x, -1, 1)   — harsh digital clipping
 *   - sine: sin(drive*x)           — wavefolding, bright and buzzy
 *   - tube: asymmetric soft clip (positive half tanh(drive*x), negative half
 *           tanh(0.7*drive*x)) — adds EVEN harmonics for a tube-like color.
 *
 *  Stateless: the curve depends only on the current sample, so reset() is a
 *  no-op and process() is trivially block-boundary continuous. */
export class ShapeKernel implements Kernel {
  constructor(private readonly type: ShapeType = 'soft') {}

  process(n: number, inputs: Record<string, Float32Array>, out: Float32Array, _ctx: DspContext): void {
    const input = inputs['in']!
    const drive = inputs['drive']!
    const type = this.type
    for (let i = 0; i < n; i++) {
      const g = clamp(drive[i]!, 1, 40)
      const v = g * input[i]!
      out[i] =
        type === 'soft'
          ? Math.tanh(v)
          : type === 'hard'
            ? v < -1
              ? -1
              : v > 1
                ? 1
                : v
            : type === 'sine'
              ? Math.sin(v)
              : // tube: asymmetric soft clip -> even harmonics
                v >= 0
                ? Math.tanh(v)
                : Math.tanh(0.7 * v)
    }
  }

  reset(): void {}
}
