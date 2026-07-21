export type NodeType =
  | 'sine' | 'saw' | 'square' | 'tri' | 'pulse' | 'noise' | 'wavetable' | 'syncsaw' | 'fm' | 'supersaw' | 'lfsr'
  | 'sample' | 'granular' | 'pluck' | 'modal'
  | 'svf' | 'ladder' | 'onepole'
  | 'adsr' | 'env' | 'lfo'
  | 'mul' | 'add' | 'sub' | 'div' | 'pow' | 'clip' | 'fold' | 'tanh'
  | 'delay' | 'reverb' | 'chorus' | 'comb' | 'bitcrush' | 'shape' | 'compress' | 'phaser' | 'formant'
  | 'pan' | 'const' | 'param' | 'notefreq' | 'gate' | 'velocity'
  | 'businput' | 'mix' | 'out'

/** number = constant, {node} = another node's output */
export type InputSource = number | { node: number }

export interface NodeSpec {
  id: number
  type: NodeType
  /** input port name -> source. number = constant, {node} = another node's output */
  inputs: Record<string, InputSource>
  /** static config (e.g. delay maxTime, param name/min/max) */
  config?: Record<string, unknown>
}

export interface ParamSpec {
  name: string
  default: number
  min: number
  max: number
  curve?: 'lin' | 'log'
}

export interface GraphSpec {
  nodes: NodeSpec[]
  /** node id whose output is the voice output */
  out: number
  params: ParamSpec[]
}

export class GraphError extends Error {
  override name = 'GraphError'
}

/** Validate: ids unique, edges reference existing nodes, out exists,
 *  and every cycle passes through at least one 'delay' node. */
export function validateGraph(g: GraphSpec): void {
  const byId = new Map<number, NodeSpec>()
  for (const n of g.nodes) {
    if (byId.has(n.id)) throw new GraphError(`duplicate node id ${n.id}`)
    byId.set(n.id, n)
  }

  if (!byId.has(g.out)) throw new GraphError(`out references nonexistent node ${g.out}`)

  // adjacency: source node id -> destination node ids,
  // excluding edges into a delay node's `in` port (a delay legally breaks a cycle)
  const adjacency = new Map<number, number[]>()
  for (const n of g.nodes) {
    for (const [port, source] of Object.entries(n.inputs)) {
      if (typeof source === 'number') continue
      if (!byId.has(source.node)) {
        throw new GraphError(`node ${n.id} input '${port}' references nonexistent node ${source.node}`)
      }
      if (n.type === 'delay' && port === 'in') continue
      let targets = adjacency.get(source.node)
      if (!targets) adjacency.set(source.node, (targets = []))
      targets.push(n.id)
    }
  }

  // DFS cycle detection: any back-edge (edge to a node on the current stack) is a delay-free cycle
  const WHITE = 0, GRAY = 1, BLACK = 2
  const color = new Map<number, number>()
  const visit = (id: number): void => {
    color.set(id, GRAY)
    for (const next of adjacency.get(id) ?? []) {
      const c = color.get(next) ?? WHITE
      if (c === GRAY) throw new GraphError(`delay-free cycle involving node ${next}`)
      if (c === WHITE) visit(next)
    }
    color.set(id, BLACK)
  }
  for (const n of g.nodes) {
    if ((color.get(n.id) ?? WHITE) === WHITE) visit(n.id)
  }
}
