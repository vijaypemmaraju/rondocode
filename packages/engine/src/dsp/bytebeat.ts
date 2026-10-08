import type { DspContext, Kernel } from './types'

export interface BytebeatConfig {
  expression: string
  mode?: 'byte' | 'signed' | 'float'
}

type Expr = (t: number) => number
type Binary = (a: number, b: number) => number
const OPS: Record<string, [number, Binary]> = {
  '|': [1, (a, b) => a | b], '^': [2, (a, b) => a ^ b], '&': [3, (a, b) => a & b],
  '==': [4, (a, b) => +(a === b)], '!=': [4, (a, b) => +(a !== b)],
  '<': [5, (a, b) => +(a < b)], '<=': [5, (a, b) => +(a <= b)],
  '>': [5, (a, b) => +(a > b)], '>=': [5, (a, b) => +(a >= b)],
  '<<': [6, (a, b) => a << b], '>>': [6, (a, b) => a >> b], '>>>': [6, (a, b) => a >>> b],
  '+': [7, (a, b) => a + b], '-': [7, (a, b) => a - b],
  '*': [8, (a, b) => a * b], '/': [8, (a, b) => a / b], '%': [8, (a, b) => a % b],
}
const UNARY: Record<string, (a: number) => number> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, abs: Math.abs,
  floor: Math.floor, ceil: Math.ceil, round: Math.round, sqrt: Math.sqrt,
  log: Math.log, exp: Math.exp,
}
const BINARY: Record<string, Binary> = { min: Math.min, max: Math.max, pow: Math.pow }
const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)

/** A small expression language, compiled once to allocation-free closures.
 * No eval/Function (including in the AudioWorklet), statements, properties,
 * assignment or loops. Bound source and token counts also bound audio cost. */
export function compileBytebeat(source: string): Expr {
  if (typeof source !== 'string' || source.length === 0 || source.length > 2048) {
    throw new Error('bytebeat: expected an expression of 1–2048 characters')
  }
  const tokens: string[] = []
  const re = /\s*(0[xX][\da-fA-F]+|0[bB][01]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z_]\w*|>>>|<<|>>|<=|>=|==|!=|[()+\-*/%&|^~!<>,?:])/y
  let offset = 0
  while (offset < source.trimEnd().length) {
    re.lastIndex = offset
    const m = re.exec(source)
    if (!m) throw new Error(`bytebeat: unexpected character at ${offset + 1}`)
    tokens.push(m[1]!)
    offset = re.lastIndex
    if (tokens.length > 256) throw new Error('bytebeat: expression exceeds 256 tokens')
  }
  let pos = 0
  const take = (s: string): void => {
    if (tokens[pos++] !== s) throw new Error(`bytebeat: expected '${s}'`)
  }
  const atom = (): Expr => {
    const tok = tokens[pos++]
    if (tok === undefined) throw new Error('bytebeat: incomplete expression')
    if (tok === '(') { const f = expr(0); take(')'); return f }
    if (tok === '+' || tok === '-' || tok === '~' || tok === '!') {
      const f = atom()
      if (tok === '+') return f
      if (tok === '-') return t => -f(t)
      if (tok === '~') return t => ~f(t)
      return t => +!f(t)
    }
    if (tok === 't') return t => t
    if (tok === 'PI') return () => Math.PI
    if (/^(?:\d|\.)/.test(tok)) {
      const n = Number(tok)
      if (!Number.isFinite(n)) throw new Error('bytebeat: number must be finite')
      return () => n
    }
    if (own(UNARY, tok) || own(BINARY, tok)) {
      take('(')
      const a = expr(0)
      if (own(UNARY, tok)) { take(')'); const f = UNARY[tok]!; return t => f(a(t)) }
      take(','); const b = expr(0); take(')')
      const f = BINARY[tok]!
      return t => f(a(t), b(t))
    }
    throw new Error(`bytebeat: unknown name '${tok}'`)
  }
  const expr = (min: number): Expr => {
    let a = atom()
    while (own(OPS, tokens[pos] ?? '')) {
      const [precedence, f] = OPS[tokens[pos]!]!
      if (precedence < min) break
      pos++
      const b = expr(precedence + 1), left = a
      a = t => f(left(t), b(t))
    }
    if (min === 0 && tokens[pos] === '?') {
      pos++
      const yes = expr(0); take(':'); const no = expr(0), condition = a
      a = t => condition(t) ? yes(t) : no(t)
    }
    return a
  }
  const result = expr(0)
  if (pos !== tokens.length) throw new Error(`bytebeat: unexpected token '${tokens[pos]}'`)
  return result
}

/** t is an integer clock tick, independent of the device sample rate. Each
 * voice starts at zero; reset restarts it. The previous value is held between
 * ticks. Clock is audio-rate Hz; 0 pauses, invalid rates pause, max 192 kHz. */
export class BytebeatKernel implements Kernel {
  private readonly formula: Expr
  private readonly mode: NonNullable<BytebeatConfig['mode']>
  private ticks = 0
  private fraction = 0
  private lastTick = -1
  private value = 0

  constructor(config: BytebeatConfig) {
    this.formula = compileBytebeat(config.expression)
    this.mode = config.mode ?? 'byte'
    if (!['byte', 'signed', 'float'].includes(this.mode)) throw new Error('bytebeat: mode must be byte, signed or float')
  }

  process(n: number, inputs: Record<string, Float32Array>, out: Float32Array, ctx: DspContext): void {
    const rate = inputs['rate']!
    for (let i = 0; i < n; i++) {
      if (this.ticks !== this.lastTick) {
        const v = this.formula(this.ticks)
        this.value = !Number.isFinite(v) ? 0 : this.mode === 'float'
          ? Math.max(-1, Math.min(1, v))
          : this.mode === 'signed' ? ((v << 24) >> 24) / 128 : ((v & 255) - 128) / 128
        this.lastTick = this.ticks
      }
      out[i] = this.value
      const hz = rate[i]!
      this.fraction += (Number.isFinite(hz) ? Math.max(0, Math.min(192000, hz)) : 0) / ctx.sampleRate
      // Epsilon prevents an exact 8000/48000 tick from falling a sample late.
      const advance = Math.floor(this.fraction + 1e-10)
      this.ticks += advance
      this.fraction -= advance
    }
  }

  reset(): void { this.ticks = 0; this.fraction = 0; this.lastTick = -1; this.value = 0 }
}
