/* ------------------------------------------------------------------------- *
 * AES-128, one block at a time.
 *
 * The LED mask encrypts every 16-byte command and every reply with AES-128 in
 * ECB mode under one fixed key. WebCrypto refuses ECB (rightly, for anything
 * that is not a single block), and pulling a crypto library in for one block
 * each way is more code than the cipher. So: the textbook cipher, both
 * directions, verified against node's `aes-128-ecb` in aes.test.ts.
 * ------------------------------------------------------------------------- */

const SBOX = new Uint8Array(256)
const INV_SBOX = new Uint8Array(256)
/** xtime: multiply by 2 in GF(2^8). */
const XT = new Uint8Array(256)
;(() => {
  let p = 1
  let q = 1
  do {
    p = p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0)
    q ^= q << 1
    q ^= q << 2
    q ^= q << 4
    q &= 0xff
    if (q & 0x80) q ^= 0x09
    const x = q ^ ((q << 1) | (q >> 7)) ^ ((q << 2) | (q >> 6)) ^ ((q << 3) | (q >> 5)) ^ ((q << 4) | (q >> 4))
    SBOX[p] = (x ^ 0x63) & 0xff
  } while (p !== 1)
  SBOX[0] = 0x63
  for (let i = 0; i < 256; i++) {
    INV_SBOX[SBOX[i]!] = i
    XT[i] = ((i << 1) ^ (i & 0x80 ? 0x1b : 0)) & 0xff
  }
})()

/** Multiply in GF(2^8) by a small constant (the inverse MixColumns needs 9, 11, 13, 14). */
const mul = (a: number, b: number): number => {
  let r = 0
  let x = a
  for (let m = b; m > 0; m >>= 1) {
    if (m & 1) r ^= x
    x = XT[x]!
  }
  return r
}

/** 11 round keys, 176 bytes. */
function expandKey(key: Uint8Array): Uint8Array {
  if (key.length !== 16) throw new RangeError(`AES-128 key must be 16 bytes, got ${key.length}`)
  const w = new Uint8Array(176)
  w.set(key)
  let rcon = 1
  for (let i = 16; i < 176; i += 4) {
    let t0 = w[i - 4]!
    let t1 = w[i - 3]!
    let t2 = w[i - 2]!
    let t3 = w[i - 1]!
    if (i % 16 === 0) {
      ;[t0, t1, t2, t3] = [SBOX[t1]! ^ rcon, SBOX[t2]!, SBOX[t3]!, SBOX[t0]!]
      rcon = XT[rcon]!
    }
    w[i] = w[i - 16]! ^ t0
    w[i + 1] = w[i - 15]! ^ t1
    w[i + 2] = w[i - 14]! ^ t2
    w[i + 3] = w[i - 13]! ^ t3
  }
  return w
}

const addRoundKey = (s: Uint8Array, w: Uint8Array, r: number): void => {
  for (let i = 0; i < 16; i++) s[i]! ^= w[r * 16 + i]!
}

// The state is column-major: byte i sits at row i % 4, column i >> 2.
const shiftRows = (s: Uint8Array, inverse: boolean): void => {
  for (let r = 1; r < 4; r++) {
    const row = [s[r]!, s[r + 4]!, s[r + 8]!, s[r + 12]!]
    for (let c = 0; c < 4; c++) s[r + 4 * c] = row[(inverse ? c - r + 4 : c + r) % 4]!
  }
}

const mixColumns = (s: Uint8Array): void => {
  for (let c = 0; c < 4; c++) {
    const a0 = s[4 * c]!
    const a1 = s[4 * c + 1]!
    const a2 = s[4 * c + 2]!
    const a3 = s[4 * c + 3]!
    s[4 * c] = XT[a0]! ^ (XT[a1]! ^ a1) ^ a2 ^ a3
    s[4 * c + 1] = a0 ^ XT[a1]! ^ (XT[a2]! ^ a2) ^ a3
    s[4 * c + 2] = a0 ^ a1 ^ XT[a2]! ^ (XT[a3]! ^ a3)
    s[4 * c + 3] = (XT[a0]! ^ a0) ^ a1 ^ a2 ^ XT[a3]!
  }
}

const invMixColumns = (s: Uint8Array): void => {
  for (let c = 0; c < 4; c++) {
    const a0 = s[4 * c]!
    const a1 = s[4 * c + 1]!
    const a2 = s[4 * c + 2]!
    const a3 = s[4 * c + 3]!
    s[4 * c] = mul(a0, 14) ^ mul(a1, 11) ^ mul(a2, 13) ^ mul(a3, 9)
    s[4 * c + 1] = mul(a0, 9) ^ mul(a1, 14) ^ mul(a2, 11) ^ mul(a3, 13)
    s[4 * c + 2] = mul(a0, 13) ^ mul(a1, 9) ^ mul(a2, 14) ^ mul(a3, 11)
    s[4 * c + 3] = mul(a0, 11) ^ mul(a1, 13) ^ mul(a2, 9) ^ mul(a3, 14)
  }
}

const checkBlock = (block: Uint8Array): void => {
  if (block.length !== 16) throw new RangeError(`AES block must be 16 bytes, got ${block.length}`)
}

/** Encrypt one 16-byte block. Returns a new array. */
export function encryptBlock(key: Uint8Array, block: Uint8Array): Uint8Array {
  checkBlock(block)
  const w = expandKey(key)
  const s = Uint8Array.from(block)
  addRoundKey(s, w, 0)
  for (let r = 1; r < 10; r++) {
    for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]!]!
    shiftRows(s, false)
    mixColumns(s)
    addRoundKey(s, w, r)
  }
  for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]!]!
  shiftRows(s, false)
  addRoundKey(s, w, 10)
  return s
}

/** Decrypt one 16-byte block. Returns a new array. */
export function decryptBlock(key: Uint8Array, block: Uint8Array): Uint8Array {
  checkBlock(block)
  const w = expandKey(key)
  const s = Uint8Array.from(block)
  addRoundKey(s, w, 10)
  for (let r = 9; r >= 1; r--) {
    shiftRows(s, true)
    for (let i = 0; i < 16; i++) s[i] = INV_SBOX[s[i]!]!
    addRoundKey(s, w, r)
    invMixColumns(s)
  }
  shiftRows(s, true)
  for (let i = 0; i < 16; i++) s[i] = INV_SBOX[s[i]!]!
  addRoundKey(s, w, 0)
  return s
}
