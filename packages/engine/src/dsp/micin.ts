import type { DspContext, Kernel } from './types'

/* The DEVICE-NAMED live input: `mic device:sm58` / `mic({ device: 'sm58' })`.
 *
 * A bare `mic()` costs nothing: compile aliases its node buffer straight to
 * ctx.mic, the block the host writes once per quantum. A named mic cannot
 * alias — which slot it reads depends on ctx.micMap, which the host updates
 * live as captures open, close and remap (a re-eval may rename devices), and
 * an alias is fixed at compile time. So the named form is a kernel that
 * copies its mapped slot each block: one small copy, and remapping never
 * recompiles a graph — the same contract setCps has.
 *
 * Unmapped (capture not open yet, offline render) reads SILENCE, which is
 * what the mic docs promise for every no-input case. */
export class MicInKernel implements Kernel {
  constructor(private readonly device: string | undefined) {}

  process(n: number, _inputs: Record<string, Float32Array>, out: Float32Array, ctx: DspContext): void {
    // bare mic: `out` IS the aliased ctx.mic block — never write over it
    if (this.device === undefined) return
    const slot = ctx.micMap?.[this.device]
    const src = slot === undefined ? undefined : ctx.mics?.[slot]
    if (src === undefined || src.length < n) {
      out.fill(0, 0, n)
      return
    }
    out.set(src.subarray(0, n))
  }

  reset(): void {
    // stateless: nothing latched between notes
  }
}
