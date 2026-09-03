import { createCipheriv } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { MaskDevice } from '../src/mask/device'
import type { MaskLink } from '../src/mask/device'
import { decryptBlock } from '../src/mask/aes'
import { FRAME_BYTES, MASK_KEY, RHYTHM_BANDS, encodeRhythm } from '../src/mask/protocol'

/* The radio discipline, against a scripted mask.
 *
 * The real mask acknowledges every upload chunk and drops the ones written
 * before it has answered the last. The device has to wait for each REOK, cope
 * with a reply landing before the write promise settles (Web Bluetooth does
 * this), give up on a missing one after a timeout rather than hang, and keep
 * every command in one queue. A scripted link makes each of those a case. */

// framed like the real mask: [len][WORD], a stale "OK" from an earlier reply
// after the word, the counter in the last byte
const encReply = (word: string, counter = 0): Uint8Array => {
  const b = new Uint8Array(16)
  b[0] = word.length
  for (let i = 0; i < word.length; i++) b[1 + i] = word.charCodeAt(i)
  b.set([0x4f, 0x4b], 1 + word.length)
  b[15] = counter
  return Uint8Array.from(createCipheriv('aes-128-ecb', MASK_KEY, null).setAutoPadding(false).update(b))
}

/** The word a written command block spells, so the script can answer it. A
 *  command is [len][NAME][args] with len covering the args too, so the name
 *  is the run of capitals after the length byte. */
const wordOf = (bytes: Uint8Array): string => {
  const plain = decryptBlock(MASK_KEY, bytes)
  let word = ''
  for (let i = 1; i <= plain[0]! && plain[i]! >= 0x41 && plain[i]! <= 0x5a; i++) word += String.fromCharCode(plain[i]!)
  return word
}

interface Rig {
  dev: MaskDevice
  link: MaskLink
  /** what was written, in order: 'cmd:DATS', 'up:0', 'up:1', ... */
  writes: string[]
  /** deliver a notification */
  reply: (word: string) => void
  /** run all due fake timers */
  fireTimers: () => void
  drop: () => void
}

interface RigOpts {
  /** answer each write with the right word automatically, `before` the
   *  write promise settles or `after` it */
  auto?: 'before' | 'after' | 'none'
  /** seq numbers whose REOK never comes */
  loseChunks?: Set<number>
}

const makeRig = (o: RigOpts = {}): Rig => {
  const writes: string[] = []
  const replyFns = new Set<(b: Uint8Array) => void>()
  const closeFns = new Set<() => void>()
  const timers: { fn: () => void; ms: number }[] = []
  const reply = (word: string): void => {
    for (const fn of replyFns) fn(encReply(word))
  }
  const ackFor = (kind: 'cmd' | 'up', word: string, seq: number): string | null => {
    if (kind === 'up') return o.loseChunks?.has(seq) ? null : 'REOK'
    if (word === 'DATS') return 'DATSOK'
    if (word === 'DATCP') return 'DATCPOK'
    if (word === 'PLAY') return 'PLAYOK'
    return `${word}OK`
  }
  const write = (kind: 'cmd' | 'up', bytes: Uint8Array): Promise<void> => {
    const word = kind === 'cmd' ? wordOf(bytes) : ''
    const seq = kind === 'up' ? bytes[1]! : -1
    writes.push(kind === 'cmd' ? `cmd:${word}` : `up:${seq}`)
    const ack = ackFor(kind, word, seq)
    const auto = o.auto ?? 'after'
    if (auto === 'before' && ack !== null) reply(ack)
    return Promise.resolve().then(() => {
      if (auto === 'after' && ack !== null) reply(ack)
    })
  }
  const link: MaskLink = {
    name: 'MASK-TEST',
    writeCommand: (b) => write('cmd', b),
    writeUpload: (b) => write('up', b),
    // a rhythm frame has no reply: the write settles and that is all
    writeRhythm: (b) => {
      writes.push(`rhy:${decryptBlock(MASK_KEY, b)[1]}`)
      return Promise.resolve()
    },
    onReply: (fn) => {
      replyFns.add(fn)
    },
    onDisconnect: (fn) => {
      closeFns.add(fn)
    },
    disconnect: () => {
      writes.push('disconnect')
    },
  }
  const dev = new MaskDevice(link, {
    ackTimeoutMs: 400,
    setTimer: (fn, ms) => {
      const t = { fn, ms }
      timers.push(t)
      return t
    },
    clearTimer: (h) => {
      const i = timers.indexOf(h as { fn: () => void; ms: number })
      if (i >= 0) timers.splice(i, 1)
    },
  })
  return {
    dev,
    link,
    writes,
    reply,
    fireTimers: () => {
      const due = timers.splice(0)
      for (const t of due) t.fn()
    },
    drop: () => {
      for (const fn of closeFns) fn()
    },
  }
}

/** Let the microtask queue drain completely (one macrotask hop). */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** Pump until the promise settles or the fake clock has to advance; returns
 *  how many timeouts it fired. */
const settle = async <T>(rig: Rig, p: Promise<T>, maxTimeouts = 200): Promise<{ value: T; timeouts: number }> => {
  let done = false
  let value!: T
  void p.then((v) => {
    value = v
    done = true
  })
  let timeouts = 0
  for (let i = 0; i < 100000 && !done; i++) {
    await tick()
    if (done) break
    if (timeouts >= maxTimeouts) throw new Error('did not settle')
    timeouts++
    rig.fireTimers()
  }
  return { value, timeouts }
}

const packed = (): Uint8Array => new Uint8Array(FRAME_BYTES)

describe('MaskDevice upload', () => {
  it('writes DATS, 82 acknowledged chunks in order, then DATCP, and reports all acked', async () => {
    const rig = makeRig()
    const progress: number[] = []
    const { value: report, timeouts } = await settle(rig, rig.dev.uploadFrame(3, packed(), (d) => progress.push(d)))
    expect(report).toEqual({ slot: 3, chunks: 82, acked: 82, framed: true })
    expect(timeouts).toBe(0) // every ack arrived, no wait ran out
    expect(rig.writes[0]).toBe('cmd:DATS')
    expect(rig.writes.slice(1, 83)).toEqual(Array.from({ length: 82 }, (_, i) => `up:${i}`))
    expect(rig.writes[83]).toBe('cmd:DATCP')
    expect(rig.writes.length).toBe(84)
    expect(progress[0]).toBe(1)
    expect(progress[81]).toBe(82)
    expect(rig.dev.uploading).toBe(false)
  })

  it('does not write the next chunk until the last one is acknowledged', async () => {
    // a mask that never answers: the upload must stall on chunk 0, not race on
    const rig = makeRig({ auto: 'none' })
    const p = rig.dev.uploadFrame(1, packed())
    await tick()
    expect(rig.writes).toEqual(['cmd:DATS'])
    expect(rig.dev.uploading).toBe(true)
    rig.reply('DATSOK')
    await tick()
    expect(rig.writes).toEqual(['cmd:DATS', 'up:0'])
    await tick()
    expect(rig.writes.length).toBe(2) // still waiting for REOK
    rig.reply('REOK')
    await tick()
    expect(rig.writes).toEqual(['cmd:DATS', 'up:0', 'up:1'])
    rig.drop()
    await settle(rig, p)
  })

  it('counts a reply that lands before the write promise settles, without drifting by one', async () => {
    const rig = makeRig({ auto: 'before' })
    const { value: report, timeouts } = await settle(rig, rig.dev.uploadFrame(1, packed()))
    expect(report.acked).toBe(82)
    expect(report.framed).toBe(true)
    expect(timeouts).toBe(0)
  })

  it('gives up on a lost acknowledgement after the timeout and reports the chunk unacked', async () => {
    const rig = makeRig({ loseChunks: new Set([5, 40]) })
    const { value: report, timeouts } = await settle(rig, rig.dev.uploadFrame(2, packed()))
    expect(report.acked).toBe(80)
    expect(report.framed).toBe(true)
    expect(report.chunks).toBe(82)
    expect(timeouts).toBe(2)
    // and it still wrote every chunk: a dropped ack does not stop the picture
    expect(rig.writes.filter((w) => w.startsWith('up:')).length).toBe(82)
  })

  it('reports framed=false when DATS or DATCP goes unconfirmed', async () => {
    const rig = makeRig({ auto: 'none' })
    const p = rig.dev.uploadFrame(1, packed())
    // answer everything except DATS and DATCP
    const answered = new Set<string>()
    for (let i = 0; i < 120; i++) {
      await tick()
      const last = rig.writes[rig.writes.length - 1]!
      if (last.startsWith('up:') && !answered.has(last)) {
        answered.add(last)
        rig.reply('REOK')
      } else {
        rig.fireTimers()
      }
    }
    const { value: report } = await settle(rig, p)
    expect(report.acked).toBe(82)
    expect(report.framed).toBe(false)
  })
})

describe('MaskDevice queue', () => {
  it('runs commands one at a time in order, and holds them behind an upload', async () => {
    const rig = makeRig({ auto: 'none' })
    const up = rig.dev.uploadFrame(1, packed())
    const cmd = rig.dev.command(Uint8Array.from(encReply('PLAY'))) // any block; the rig reads its word
    await tick()
    expect(rig.writes).toEqual(['cmd:DATS'])
    expect(rig.dev.uploading).toBe(true)
    // finish the upload by hand
    rig.reply('DATSOK')
    for (let i = 0; i < 82; i++) {
      await tick()
      rig.reply('REOK')
    }
    await tick()
    rig.reply('DATCPOK')
    await settle(rig, up)
    await settle(rig, cmd)
    expect(rig.writes[rig.writes.length - 1]).toBe('cmd:PLAY')
    expect(rig.writes.indexOf('cmd:PLAY')).toBeGreaterThan(rig.writes.indexOf('cmd:DATCP'))
  })

  it('sends rhythm frames through the same queue, without waiting for a reply', async () => {
    const rig = makeRig({ auto: 'none' })
    const zeros = new Array<number>(RHYTHM_BANDS).fill(0)
    // a frame queued behind a command goes out after it, and the command's
    // missing reply does not hold it: nothing waits for a reply on a frame
    const cmd = rig.dev.command(encReply('PLAY'))
    const frame = rig.dev.rhythm(encodeRhythm(2, zeros))
    await tick()
    expect(rig.writes).toEqual(['cmd:PLAY', 'rhy:2'])
    await expect(frame).resolves.toBeUndefined()
    rig.reply('PLAYOK')
    await cmd
    // an upload owns the queue: a frame sent during it is dropped, not
    // queued five seconds behind the chunks
    const up = rig.dev.uploadFrame(1, packed())
    await tick()
    expect(rig.dev.uploading).toBe(true)
    await expect(rig.dev.rhythm(encodeRhythm(2, zeros))).resolves.toBeUndefined()
    expect(rig.writes.filter((w) => w.startsWith('rhy:')).length).toBe(1)
    rig.drop()
    await settle(rig, up)
    await expect(rig.dev.rhythm(encodeRhythm(2, zeros))).rejects.toThrow(/disconnected/)
  })

  it('keeps going after a failed write instead of poisoning the queue', async () => {
    const rig = makeRig()
    let fail = true
    const orig = rig.link.writeCommand
    rig.link.writeCommand = (b) => (fail ? Promise.reject(new Error('GATT operation failed')) : orig(b))
    await expect(rig.dev.command(encReply('LIGHT'))).rejects.toThrow(/GATT/)
    fail = false
    await expect(rig.dev.command(encReply('LIGHT'))).resolves.toBeUndefined()
    expect(rig.writes).toEqual(['cmd:LIGHT'])
  })

  it('releases a waiting upload and rejects new commands once the link drops', async () => {
    const rig = makeRig({ auto: 'none' })
    const closes: number[] = []
    rig.dev.onClose(() => closes.push(1))
    const up = rig.dev.uploadFrame(1, packed())
    await tick()
    rig.drop()
    const { value: report, timeouts } = await settle(rig, up)
    expect(timeouts).toBe(0) // the waiters were released, not timed out
    expect(report.framed).toBe(false)
    expect(rig.dev.connected).toBe(false)
    expect(closes).toEqual([1])
    await expect(rig.dev.command(encReply('LIGHT'))).rejects.toThrow(/disconnected/)
    // disconnect() after a drop is a no-op, not a second close
    rig.dev.disconnect()
    expect(closes).toEqual([1])
    expect(rig.writes).not.toContain('disconnect')
  })

  it('disconnect() tells the link and fires onClose once', () => {
    const rig = makeRig()
    let n = 0
    rig.dev.onClose(() => n++)
    rig.dev.disconnect()
    rig.dev.disconnect()
    expect(rig.writes).toEqual(['disconnect'])
    expect(n).toBe(1)
    expect(rig.dev.name).toBe('MASK-TEST')
  })
})
