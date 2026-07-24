/* ------------------------------------------------------------------------- *
 * Share links — encode a tune into the URL so it can be sent anywhere, with
 * NO backend. The payload is JSON {n, c} → raw DEFLATE (pako, primed with a
 * rondocode preset DICTIONARY) → base64url, behind a 1-char scheme byte:
 *   'p' = pako deflate + dictionary   (current)
 *   'd' = raw deflate, no dictionary  (legacy CompressionStream links)
 *   'u' = uncompressed                (fallback when compression grows it)
 * The dictionary primes the compressor with the rondocode idioms every tune
 * repeats (synth(({ note, gate, adsr … / .sound(' / masterCompress({ …), so
 * even short tunes compress from the first byte — deflate otherwise can't
 * reference a token before it has seen it. base64url (not base85) keeps links
 * intact through chat/markdown auto-linkers and the `#s=` hash parser.
 * The link lives in the hash (`#s=<payload>`) so it never hits a server.
 * ------------------------------------------------------------------------- */

import { deflateRaw, inflateRaw } from 'pako'

export interface SharePayload {
  name: string
  code: string
  /** which language `code` is written in (omitted = JavaScript). */
  lang?: 'rondo'
}

/* The preset dictionary: common rondocode source fragments, ordered with the
 * MOST frequent toward the END (deflate back-references recent dictionary bytes
 * most cheaply). Fragments are intra-line (no newlines) so they match the
 * JSON-escaped payload directly, whatever the surrounding escaping. Extend it
 * freely — decoding stays correct as long as encode and decode share it, but
 * CHANGING it breaks links made with the old one, so only append. */
const DICT_TEXT =
  "arrange([8, full], [4, intro], [8, full], [4, breakdown])stack(intro, build, drop)" +
  ".struct(mini('~ t ~ t ~ t ~ t')).scale('a minor').scale('g# minor')n('0 3 5 7')" +
  "wavetable(note.freq, ladder(saw(f), env.pow(2).range(, { res: 0.62 })square(f.mul(0.5))" +
  "shape(input, reverb(input, { roomSize: 0.85, damp: 0.4 })chorus(input, { rate: 0.4, depth: 0." +
  "delay(input, 0.28, 0.35))bitcrush(dirty, { bits: 10, downsample: 1 })onepole(compress(" +
  "svf(noise(), 8800, { mode: 'hp' }).mul(adsr(gate, { a: 0.001, d: 0.0" +
  "saw(f).add(saw(f.mul(1.006))).add(saw(f.mul(0.994))).mul(0.4)const f = note.freq" +
  "visual(fn render(uv: vec2f) -> vec4f {let p = (uv * 2.0 - 1.0) * vec2f(res.x / res.y, 1.0);" +
  "let r = length(p);spectrum(fract(smoothstep(0.05, 0.0, abs(r - hit_kick hit_lead hit_stab" +
  "vec3f(0.return vec4f(min(col, vec3f(1.0)), 1.0);} * exp(-r * 3." +
  "sidechain('kick', { depth: 0.9, release: 0.16, duck: { sub: 0.9, pad: 0.5, stab: 0.5, lead: 0.4 } })" +
  "masterCompress({ threshold: -6, ratio: 2, attack: 25, release: 150, makeup: 1 })setCps(0.5" +
  "const kick = synth(({ note, gate, param, adsr, sine, saw, square, tri, noise, svf, ladder, lfo }) => {" +
  "  const env = adsr(gate, { a: 0.001, d: 0.09, s: 0, r: 0.05 })  const amp = adsr(gate, { a: 0.001, d: 0." +
  "})}, ({ input }) => input, { voices:  }, { mono: true, glide: 0. })" +
  ".mul(env).tanh().mul(0..add(.mix(, 0..range(, .pow(2)note.freq.mul(0.5)" +
  "note('c1*4').sound('kick').gain(1.0)chord('<Am F C G>').sound('pad').gain(0.5).dur(0.9" +
  "').sound('').gain(0.').dur(0.9).struct(mini('p('song', stack(setCps(0.5)"

const DICT = new TextEncoder().encode(DICT_TEXT)

const toB64Url = (bytes: Uint8Array): string => {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const fromB64Url = (str: string): Uint8Array => {
  const b = atob(str.replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(b.length)
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i)
  return out
}

/** Encode a tune into a URL-safe payload string. */
export async function encodeShare(p: SharePayload): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify({ n: p.name, c: p.code, ...(p.lang !== undefined ? { l: p.lang } : {}) }))
  try {
    const packed = deflateRaw(json, { level: 9, dictionary: DICT })
    // keep whichever is shorter (a pathological tiny tune can grow)
    if (packed.length < json.length) return `p${toB64Url(packed)}`
  } catch {
    /* fall through to uncompressed */
  }
  return `u${toB64Url(json)}`
}

/** Decode a payload string back to a tune, or null if malformed. */
export async function decodeShare(payload: string): Promise<SharePayload | null> {
  try {
    const scheme = payload[0]
    const bytes = fromB64Url(payload.slice(1))
    const json =
      scheme === 'p'
        ? inflateRaw(bytes, { dictionary: DICT }) // current: dictionary-primed
        : scheme === 'd'
          ? inflateRaw(bytes) // legacy CompressionStream links (no dictionary)
          : scheme === 'u'
            ? bytes
            : null
    if (json === null) return null
    const obj = JSON.parse(new TextDecoder().decode(json)) as { n?: unknown; c?: unknown; l?: unknown }
    if (typeof obj.c !== 'string') return null
    const out: SharePayload = { name: typeof obj.n === 'string' ? obj.n : 'shared', code: obj.c }
    if (obj.l === 'rondo') out.lang = 'rondo'
    return out
  } catch {
    return null
  }
}

/** Pull the share payload out of a location hash (`#s=…`), or null. */
export function readShareHash(hash: string): string | null {
  const m = /[#&]s=([^&]+)/.exec(hash)
  return m ? m[1]! : null
}

/** Build the full shareable URL for a payload. */
export function shareUrl(origin: string, pathname: string, payload: string): string {
  return `${origin}${pathname}#s=${payload}`
}
