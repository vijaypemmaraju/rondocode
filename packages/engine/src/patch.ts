import type { GraphSpec, NodeSpec, NodeType } from './graph'

/* ------------------------------------------------------------------------- *
 * Live constant patching — the "sweep a synth number and hear it glide"
 * path. Redefining a synth normally rebuilds its whole voice pool (cutting
 * ringing voices). But when two graphs differ ONLY in numeric INPUT-PORT
 * constants (e.g. a filter cutoff 800 → 820, a gain 0.5 → 0.6), the running
 * voices can be patched in place instead: each such constant is a per-voice
 * input buffer, so re-pointing it updates the live DSP with zero rebuild and
 * full state preservation (envelopes, filter memory) — held notes sweep too.
 *
 * Anything else — a structural edit, a changed kernel CONFIG (adsr a/d/s/r,
 * svf mode, reverb size…), a params change — is NOT patchable and must fall
 * back to defineSynth. diffGraphConstants returns null in those cases.
 * ------------------------------------------------------------------------- */

export interface ConstPatch {
  /** NodeSpec id of the kernel node whose input constant changed. */
  node: number
  /** Input port name (e.g. 'cutoff', 'freq', 'b'). */
  port: string
  /** New constant value to write into that voice input buffer. */
  value: number
}

/** Node types the compiler turns into runnable kernel steps (compile.ts
 *  REGISTRY). Only these have a per-voice input buffer we can re-point; a
 *  constant feeding pan/out/etc. is not patchable. */
const KERNEL_TYPES: ReadonlySet<NodeType> = new Set<NodeType>([
  'sine', 'saw', 'square', 'tri', 'pulse', 'syncsaw', 'wavetable', 'noise',
  'sample', 'granular', 'svf', 'ladder', 'onepole', 'adsr', 'lfo',
  'mul', 'add', 'sub', 'div', 'pow', 'clip', 'fold', 'tanh', 'mix',
  'delay', 'reverb', 'chorus', 'comb', 'bitcrush', 'shape', 'compress',
])

const cfg = (n: NodeSpec): string => JSON.stringify(n.config ?? {})

/**
 * If `next` differs from `prev` ONLY in numeric input-port constants on
 * kernel nodes, return the list of changed constants (possibly empty).
 * Otherwise — any structural, config, param, or node-set difference — return
 * null (the caller must rebuild via defineSynth).
 */
export function diffGraphConstants(prev: GraphSpec, next: GraphSpec): ConstPatch[] | null {
  if (prev.out !== next.out) return null
  if (JSON.stringify(prev.params) !== JSON.stringify(next.params)) return null
  if (prev.nodes.length !== next.nodes.length) return null

  const prevById = new Map<number, NodeSpec>()
  for (const n of prev.nodes) prevById.set(n.id, n)

  const patches: ConstPatch[] = []
  for (const nn of next.nodes) {
    const pn = prevById.get(nn.id)
    if (pn === undefined) return null // node set changed
    if (pn.type !== nn.type) return null
    if (cfg(pn) !== cfg(nn)) return null // kernel config changed → rebuild

    const ports = new Set([...Object.keys(pn.inputs), ...Object.keys(nn.inputs)])
    for (const port of ports) {
      const ps = pn.inputs[port]
      const ns = nn.inputs[port]
      if (ps === undefined || ns === undefined) return null // port set changed
      const pNum = typeof ps === 'number'
      const nNum = typeof ns === 'number'
      if (pNum !== nNum) return null // constant ↔ edge swap = structural
      if (!pNum) {
        // both are {node} refs — an edge; must point at the same producer
        if ((ps as { node: number }).node !== (ns as { node: number }).node) return null
        continue
      }
      if (ps === ns) continue // constant unchanged
      // a constant changed — patchable only if it feeds a kernel node
      if (!KERNEL_TYPES.has(nn.type)) return null
      patches.push({ node: nn.id, port, value: ns as number })
    }
  }
  return patches
}
