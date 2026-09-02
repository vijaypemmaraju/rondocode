/* ------------------------------------------------------------------------- *
 * A picture for the LED mask, in the form the program writes it.
 *
 * Device-neutral on purpose: the evaluator stages these (maskFrame() in
 * evalCode.ts) and the mask module turns them into the panel's byte order
 * (protocol.ts). Row-major RGB, x from the WEARER'S LEFT as the viewer sees
 * it, y from the top, so a painter can think in ordinary picture coordinates.
 *
 * The panel is 46 wide and 58 tall. It is not a rectangle of LEDs: the two
 * eye cut-outs carry none, and the corners sit under the oval bezel, so a
 * shape drawn across those areas is broken by them. That is the mask, not a
 * bug in the frame.
 * ------------------------------------------------------------------------- */

export const MASK_W = 46
export const MASK_H = 58
/** DIY picture slots. Slots 1 and 2 were verified to coexist on the bench;
 *  the community controllers address 20, which is taken as the ceiling. */
export const MASK_SLOT_MIN = 1
export const MASK_SLOT_MAX = 20

export interface MaskFrame {
  width: typeof MASK_W
  height: typeof MASK_H
  /** row-major RGB, 3 bytes a pixel, width * height * 3 bytes */
  rgb: Uint8Array
}

/** What a painter may answer for one pixel: a grey level 0..1, an [r, g, b]
 *  triple 0..1, a CSS hex colour ('#f00', '#ff0000'), or nothing for black. */
export type MaskColor = number | readonly [number, number, number] | string | null | undefined | false

/** Called once per pixel; `w` and `h` are the panel size, for painters that
 *  want to centre or scale. */
export type MaskPainter = (x: number, y: number, w: number, h: number) => MaskColor

const byte = (v: number): number => {
  if (!Number.isFinite(v)) return 0
  return Math.round(Math.max(0, Math.min(1, v)) * 255)
}

/** One colour answer → [r, g, b] bytes. Throws on a shape that is not a
 *  colour, at eval time, with the pixel it came from. */
export function colorBytes(c: MaskColor, where = ''): [number, number, number] {
  if (c === null || c === undefined || c === false) return [0, 0, 0]
  if (typeof c === 'number') {
    const g = byte(c)
    return [g, g, g]
  }
  if (typeof c === 'string') {
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim())
    if (m === null) throw new TypeError(`maskFrame(): ${where}colour must be '#rgb' or '#rrggbb', got ${JSON.stringify(c)}`)
    const h = m[1]!
    const hex = h.length === 3 ? h.split('').map((ch) => ch + ch).join('') : h
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)]
  }
  if (Array.isArray(c) && c.length === 3 && c.every((v) => typeof v === 'number')) {
    return [byte(c[0]!), byte(c[1]!), byte(c[2]!)]
  }
  throw new TypeError(`maskFrame(): ${where}colour must be a grey 0..1, an [r, g, b] 0..1, or a '#hex' string`)
}

/** Run a painter over every pixel. */
export function paintFrame(paint: MaskPainter): MaskFrame {
  const rgb = new Uint8Array(MASK_W * MASK_H * 3)
  for (let y = 0; y < MASK_H; y++) {
    for (let x = 0; x < MASK_W; x++) {
      const [r, g, b] = colorBytes(paint(x, y, MASK_W, MASK_H), `at (${x}, ${y}) `)
      const i = (y * MASK_W + x) * 3
      rgb[i] = r
      rgb[i + 1] = g
      rgb[i + 2] = b
    }
  }
  return { width: MASK_W, height: MASK_H, rgb }
}

/** Byte-for-byte equality, for deciding whether a slot needs re-uploading. */
export function sameFrame(a: MaskFrame, b: MaskFrame): boolean {
  if (a.rgb.length !== b.rgb.length) return false
  for (let i = 0; i < a.rgb.length; i++) if (a.rgb[i] !== b.rgb[i]) return false
  return true
}
