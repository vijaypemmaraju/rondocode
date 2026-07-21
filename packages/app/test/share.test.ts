import { describe, expect, it } from 'vitest'
import { deflateRaw } from 'pako'
import { decodeShare, encodeShare, readShareHash, shareUrl } from '../src/session/share'

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
