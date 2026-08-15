import { describe, expect, it } from 'vitest'
import { visualBlockRanges, tokenizeWgsl } from '../src/editor/wgsl'

/* WGSL highlighting inside a rondo `visual` block.
 *
 * The shader overlay found its ranges from the JS syntax tree -- the argument
 * of a visual(`…`) call -- so in rondo, where a shader is a lone `visual`
 * header with an indented body and no backticks anywhere, it found nothing and
 * the body was left painted by rondo's rules. That is worse than colourless:
 * `mix`, `note`, `pan` and `sin` are rondo vocabulary too, so a WGSL call came
 * out coloured as though it were music.
 *
 * The tokenizer was never the problem, only WHICH RANGES it was pointed at, so
 * that is what these pin: the rondo spelling of a shader, and the block rule
 * (indentation, exactly the parser's) that says where it ends. */

const SHADER = `bpm 120

visual
  // a comment
  fn render(uv: vec2f) -> vec4f {
    let c = mix(0.0, 1.0, hit_kick);
    return vec4f(c, c, c, 1.0);
  }

play lead
  0 3 5
`

/** The shader source the highlighter would paint, as one string. */
const shaderOf = (src: string): string =>
  visualBlockRanges(src).map((r) => src.slice(r.from, r.to)).join('\n---\n')

const classOf = (src: string, text: string): string | undefined => {
  const body = shaderOf(src)
  return tokenizeWgsl(body).find((t) => body.slice(t.from, t.to) === text)?.cls
}

describe('visualBlockRanges', () => {
  it('finds the body of a rondo `visual` block', () => {
    const body = shaderOf(SHADER)
    expect(body).toContain('fn render(uv: vec2f) -> vec4f {')
    expect(body.startsWith('  // a comment')).toBe(true)
  })

  it('stops at the block, so the music around it is never painted as shader', () => {
    const body = shaderOf(SHADER)
    expect(body).not.toContain('bpm')
    expect(body).not.toContain('play lead')
  })

  it('keeps a blank line inside the shader rather than closing on one', () => {
    const doc = `visual
  fn render(uv: vec2f) -> vec4f {

    return vec4f(1.0);
  }

bpm 120
`
    // the `return` is AFTER a blank line: closing there would leave the rest of
    // every real shader uncoloured, since shaders have blank lines in them
    expect(shaderOf(doc)).toContain('return vec4f(1.0);')
    expect(shaderOf(doc)).not.toContain('bpm')
  })

  it('is not opened by `visual` used as anything but a lone header', () => {
    expect(visualBlockRanges('play visual\n  0 3 5\n')).toEqual([])
    expect(visualBlockRanges('  visual bright\n    fn x\n')).toEqual([])
  })

  it('finds a block that runs to the end of the document', () => {
    expect(shaderOf('bpm 120\n\nvisual\n  fn render() {}\n')).toBe('  fn render() {}')
  })

  it('finds more than one block', () => {
    expect(visualBlockRanges('visual\n  a\nbpm 1\nvisual\n  b\n')).toHaveLength(2)
  })
})

describe('what the rondo shader body gets painted as', () => {
  it('paints WGSL keywords, types and comments', () => {
    expect(classOf(SHADER, 'fn')).toBe('wgsl-kw')
    expect(classOf(SHADER, 'vec4f')).toBe('wgsl-type')
    expect(classOf(SHADER, '// a comment')).toBe('wgsl-com')
  })

  it('paints the collisions as WGSL, which is the whole bug', () => {
    // `mix` and `hit_kick` are exactly the words rondo would have claimed:
    // `mix` is rondo vocabulary and `hit_` is generated per synth
    expect(classOf(SHADER, 'mix')).toBe('wgsl-fn')
    expect(classOf(SHADER, 'hit_kick')).toBe('wgsl-api')
  })
})
