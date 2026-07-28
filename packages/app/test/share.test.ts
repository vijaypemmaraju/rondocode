import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { deflateRaw } from 'pako'
import { decodeShare, encodeShare, readShareHash, sharePayloadFor, shareUrl } from '../src/session/share'

const toB64Url = (bytes: Uint8Array): string => {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

describe('share links', () => {
  it('round-trips a tune through encode → decode', async () => {
    const tune = { name: 'my track', code: "const s = synth(({ sine, note }) => sine(note.freq))\np('a', note('c4 e4 g4').sound('s'))\nsetCps(0.5)" }
    const payload = await encodeShare(tune)
    expect(payload).toMatch(/^[pu][A-Za-z0-9_-]+$/) // scheme byte + base64url
    expect(await decodeShare(payload)).toEqual(tune)
  })

  it('round-trips a large tune (deflate keeps the payload well under the raw size)', async () => {
    const code = 'x'.repeat(9000) // ~ veldt-full-sized, highly compressible
    const payload = await encodeShare({ name: 'big', code })
    expect(payload[0]).toBe('p') // chose the dictionary-deflated form
    expect(payload.length).toBeLessThan(code.length / 2)
    expect(await decodeShare(payload)).toEqual({ name: 'big', code })
  })

  it('still decodes legacy no-dictionary "d" links (CompressionStream era)', async () => {
    // an old link: raw DEFLATE with NO dictionary, base64url, scheme 'd'
    const tune = { name: 'old', code: "p('a', note('c4 e4 g4').sound('s'))" }
    const json = new TextEncoder().encode(JSON.stringify({ n: tune.name, c: tune.code }))
    const legacy = 'd' + toB64Url(deflateRaw(json))
    expect(await decodeShare(legacy)).toEqual(tune)
  })

  it('preserves non-ASCII (emoji, accents) in code/name', async () => {
    const tune = { name: 'café ✦', code: "// ✦ notes: é ü ∿\np('a', note('c4'))" }
    expect(await decodeShare(await encodeShare(tune))).toEqual(tune)
  })

  it('defaults a missing name to "shared"', async () => {
    // hand-build an uncompressed payload with only code
    const bytes = new TextEncoder().encode(JSON.stringify({ c: 'p("a", note("c4"))' }))
    let s = ''
    for (const b of bytes) s += String.fromCharCode(b)
    const payload = 'u' + btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const got = await decodeShare(payload)
    expect(got?.name).toBe('shared')
  })

  it('returns null on malformed / unknown-scheme payloads', async () => {
    expect(await decodeShare('zzz')).toBeNull() // unknown scheme
    expect(await decodeShare('u@@@not base64@@@')).toBeNull()
    expect(await decodeShare('u' + btoa('not json'))).toBeNull()
  })

  it('reads the payload out of a hash and builds a URL', () => {
    expect(readShareHash('#s=dABC123')).toBe('dABC123')
    expect(readShareHash('#foo&s=uXYZ')).toBe('uXYZ')
    expect(readShareHash('#nothing')).toBeNull()
    expect(readShareHash('')).toBeNull()
    expect(shareUrl('https://rondocode.pages.dev', '/', 'dABC')).toBe('https://rondocode.pages.dev/#s=dABC')
  })
})

describe('the shared LANGUAGE survives the link', () => {
  /* `lang` is optional and omitting it is silently valid, so a call site that
   * forgot it produced a link opening a rondo tune in JavaScript mode — where
   * it is not even syntactically legal. The decode side was always right, so
   * nothing failed loudly. sharePayloadFor() is the one place that decides. */

  it('marks rondo and leaves JavaScript implicit', () => {
    expect(sharePayloadFor('t', 'saw note', 'rondo')).toEqual({ name: 't', code: 'saw note', lang: 'rondo' })
    // 'rondocode' is the editor's name for the JS language: no field
    expect(sharePayloadFor('t', 'x', 'rondocode')).toEqual({ name: 't', code: 'x' })
    expect(sharePayloadFor('t', 'x', undefined)).toEqual({ name: 't', code: 'x' })
  })

  it('round-trips a rondo tune through encode and decode', async () => {
    const src = 'synth t\n  saw note\n  * env\n  env = adsr .01 .1 .5 .2\n\nplay t\n  c4 e4'
    const decoded = await decodeShare(await encodeShare(sharePayloadFor('tune', src, 'rondo')))
    expect(decoded).not.toBeNull()
    expect(decoded!.code).toBe(src)
    expect(decoded!.lang).toBe('rondo')
  })

  it('a JavaScript tune decodes with no lang, so it opens in JS', async () => {
    const src = "const a = synth(({ saw, note }) => saw(note.freq))\np('a', note('c4').sound('a'))"
    const decoded = await decodeShare(await encodeShare(sharePayloadFor('tune', src, 'rondocode')))
    expect(decoded!.lang).toBeUndefined()
  })

  it('survives a full URL round trip, not just the payload', async () => {
    const src = 'synth t\n  saw note'
    const url = shareUrl('https://rondocode.com', '/', await encodeShare(sharePayloadFor('t', src, 'rondo')))
    const payload = readShareHash(new URL(url).hash)
    expect(payload).not.toBeNull()
    const decoded = await decodeShare(payload!)
    expect(decoded!.lang).toBe('rondo')
    expect(decoded!.code).toBe(src)
  })
})

describe('every share link is built through the helper', () => {
  /* Two of the three call sites hand-assembled `{ name, code }` and silently
   * dropped the language. Since the field is optional, nothing failed loudly —
   * the link just opened a rondo tune in JavaScript mode. Assert the shape of
   * the call, not just the helper, because the helper was never the problem. */
  const SRC = ['../src/editor/library.ts', '../src/docs.ts']

  it.each(SRC)('%s passes a built payload, never an object literal', (rel) => {
    const src = readFileSync(join(__dirname, rel), 'utf8')
    const calls = [...src.matchAll(/encodeShare\(([^)]*)/g)].map((m) => m[1]!)
    expect(calls.length).toBeGreaterThan(0)
    for (const arg of calls) {
      expect(arg.trim().startsWith('{'), `hand-built payload: encodeShare(${arg}`).toBe(false)
      expect(arg).toContain('sharePayloadFor')
    }
  })
})
