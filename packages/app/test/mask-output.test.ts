import { createCipheriv } from 'node:crypto'
import type { SchedulerEvent } from '@rondocode/pattern'
import { describe, expect, it } from 'vitest'
import { MaskDevice } from '../src/mask/device'
import type { MaskLink } from '../src/mask/device'
import { paintFrame } from '../src/mask/frame'
import { MaskOutput, eventState } from '../src/mask/output'
import type { MaskStatus } from '../src/mask/output'
import { decryptBlock } from '../src/mask/aes'
import { MASK_KEY } from '../src/mask/protocol'

/* The mask as a pattern output. The contract, from output.ts: events are
 * timed against the audio clock, only CHANGES are sent, and changes that land
 * during a picture upload are folded into one state sent when it ends. */

// framed like the real mask: [len][WORD], with stale bytes after the word
const encReply = (word: string): Uint8Array => {
  const b = new Uint8Array(16)
  b[0] = word.length
  for (let i = 0; i < word.length; i++) b[1 + i] = word.charCodeAt(i)
  b.set([0x4f, 0x4b], 1 + word.length)
  return Uint8Array.from(createCipheriv('aes-128-ecb', MASK_KEY, null).setAutoPadding(false).update(b))
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

const ev = (timeSec: number, controls: Record<string, unknown>): SchedulerEvent =>
  ({ timeSec, durSec: 0.1, controls: { sound: 'mask', ...controls } }) as unknown as SchedulerEvent

interface Rig {
  out: MaskOutput
  dev: MaskDevice
  /** decrypted command words + first arg(s): 'LIGHT 128', 'PLAY 1 2', 'IMAG 3', 'DATS', 'DATCP' */
  sent: string[]
  /** how many upload chunks were written */
  chunks: number
  setNow: (t: number) => void
  /** fire output-layer timers due at or before `ms` from the last flush */
  fireDue: (ms: number) => void
  statuses: MaskStatus[]
  errors: string[]
  /** stop auto-acking uploads (the rig acks everything by default) */
  ackUploads: boolean
  drop: () => void
}

const makeRig = (): Rig => {
  let now = 0
  const sent: string[] = []
  const replyFns = new Set<(b: Uint8Array) => void>()
  const closeFns = new Set<() => void>()
  const timers: { fn: () => void; ms: number }[] = []
  const rig = { chunks: 0, ackUploads: true } as Rig
  const reply = (word: string): void => {
    for (const fn of replyFns) fn(encReply(word))
  }
  const link: MaskLink = {
    name: 'MASK-TEST',
    writeCommand: (bytes) => {
      // a command is [len][NAME][args], len covering the args
      const plain = decryptBlock(MASK_KEY, bytes)
      let word = ''
      for (let i = 1; i <= plain[0]! && plain[i]! >= 0x41 && plain[i]! <= 0x5a; i++) word += String.fromCharCode(plain[i]!)
      const nArgs = plain[0]! - word.length
      const args = Array.from(plain.subarray(1 + word.length, 1 + word.length + nArgs))
      sent.push(word === 'DATS' || word === 'DATCP' ? word : `${word} ${args.join(' ')}`)
      return Promise.resolve().then(() => reply(word === 'DATS' ? 'DATSOK' : word === 'DATCP' ? 'DATCPOK' : `${word}OK`))
    },
    writeUpload: () => {
      rig.chunks++
      return Promise.resolve().then(() => {
        if (rig.ackUploads) reply('REOK')
      })
    },
    onReply: (fn) => {
      replyFns.add(fn)
    },
    onDisconnect: (fn) => {
      closeFns.add(fn)
    },
    disconnect: () => {},
  }
  // device timers are never needed when every chunk is acked; when they are
  // (ackUploads false) the device would wait 400 ms, which the rig fires too
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
  const statuses: MaskStatus[] = []
  const errors: string[] = []
  const out = new MaskOutput({
    now: () => now,
    setTimer: (fn, ms) => {
      const t = { fn, ms }
      timers.push(t)
      return t
    },
    clearTimer: (h) => {
      const i = timers.indexOf(h as { fn: () => void; ms: number })
      if (i >= 0) timers.splice(i, 1)
    },
    onStatus: (s) => statuses.push(s),
    onError: (m) => errors.push(m),
  })
  Object.assign(rig, {
    out,
    dev,
    sent,
    setNow: (t: number) => {
      now = t
    },
    fireDue: (ms: number) => {
      const due = timers.filter((t) => t.ms <= ms)
      for (const t of due) timers.splice(timers.indexOf(t), 1)
      for (const t of due) t.fn()
    },
    statuses,
    errors,
    drop: () => {
      for (const fn of closeFns) fn()
    },
  })
  return rig
}

describe('eventState', () => {
  it('reads slot over face over anim, and gain as brightness', () => {
    expect(eventState({ n: 2 })).toEqual({ picture: { kind: 'slot', n: 2 } })
    expect(eventState({ frame: 3, n: 2 })).toEqual({ picture: { kind: 'slot', n: 3 } })
    expect(eventState({ n: 2, face: 5, anim: 1 })).toEqual({ picture: { kind: 'slot', n: 2 } })
    expect(eventState({ face: 5, anim: 1 })).toEqual({ picture: { kind: 'face', n: 5 } })
    expect(eventState({ anim: 4 })).toEqual({ picture: { kind: 'anim', n: 4 } })
    expect(eventState({ gain: 0.5 })).toEqual({ light: 128 })
    expect(eventState({ gain: 1, face: 1 })).toEqual({ picture: { kind: 'face', n: 1 }, light: 255 })
    // a note with none of them says nothing about the mask
    expect(eventState({ note: 60 })).toEqual({})
    expect(eventState({ n: 'x' })).toEqual({})
    // a step outside the slots is a beat with no picture of its own, so a
    // face lane can use `0 0 0 0` as its grid
    expect(eventState({ n: 0, face: 2 })).toEqual({ picture: { kind: 'face', n: 2 } })
    expect(eventState({ n: 0 })).toEqual({})
    expect(eventState({ n: 99, anim: 1 })).toEqual({ picture: { kind: 'anim', n: 1 } })
  })
})

describe('MaskOutput', () => {
  it('sends only to the mask sound, timed against the clock', async () => {
    const rig = makeRig()
    rig.out.attach(rig.dev)
    rig.setNow(10)
    rig.out.send([ev(10, { n: 1 }), ev(10.25, { n: 2 }), ev(10.25, { sound: 'bd', n: 3 })])
    await tick()
    expect(rig.sent).toEqual(['PLAY 1 1']) // due now: sent now
    rig.fireDue(100)
    await tick()
    expect(rig.sent).toEqual(['PLAY 1 1']) // 250 ms away: not yet
    rig.fireDue(250)
    await tick()
    expect(rig.sent).toEqual(['PLAY 1 1', 'PLAY 1 2'])
  })

  it('sends only changes', async () => {
    const rig = makeRig()
    rig.out.attach(rig.dev)
    rig.out.send([ev(0, { n: 1, gain: 1 }), ev(0, { n: 1, gain: 1 }), ev(0, { n: 2, gain: 1 }), ev(0, { gain: 0.5 }), ev(0, { gain: 0.5 })])
    await tick()
    expect(rig.sent).toEqual(['LIGHT 255', 'PLAY 1 1', 'PLAY 1 2', 'LIGHT 128'])
    rig.out.send([ev(0, { face: 2 }), ev(0, { face: 2 }), ev(0, { anim: 7 }), ev(0, { n: 2 })])
    await tick()
    expect(rig.sent.slice(4)).toEqual(['IMAG 2', 'ANIM 7', 'PLAY 1 2'])
    expect(rig.out.status().shown).toEqual({ picture: { kind: 'slot', n: 2 }, light: 128 })
  })

  it('does nothing without a device and forgets what it sent when the device changes', async () => {
    const rig = makeRig()
    rig.out.send([ev(0, { n: 1 })])
    await tick()
    expect(rig.sent).toEqual([])
    expect(rig.out.status().device).toBeNull()
    rig.out.attach(rig.dev)
    await tick()
    // the state the pattern asked for while unplugged is sent on attach
    expect(rig.sent).toEqual(['PLAY 1 1'])
    expect(rig.out.status().device).toBe('MASK-TEST')
    rig.out.attach(null)
    expect(rig.out.status().shown).toEqual({})
    rig.out.attach(rig.dev)
    await tick()
    expect(rig.sent).toEqual(['PLAY 1 1', 'PLAY 1 1']) // a "new" mask is told again
  })

  it('stop() drops what is queued and leaves the mask as it is', async () => {
    const rig = makeRig()
    rig.out.attach(rig.dev)
    rig.out.send([ev(1, { n: 4 })])
    rig.out.stop()
    rig.fireDue(5000)
    await tick()
    expect(rig.sent).toEqual([])
  })

  it('uploads changed slots one at a time and re-shows a slot whose picture was replaced', async () => {
    const rig = makeRig()
    rig.out.attach(rig.dev)
    const a = paintFrame(() => 0.1)
    const b = paintFrame(() => 0.2)
    rig.out.setFrames(new Map([[1, a], [2, b]]))
    for (let i = 0; i < 200 && rig.sent.filter((s) => s === 'DATCP').length < 2; i++) await tick()
    expect(rig.sent).toEqual(['DATS', 'DATCP', 'DATS', 'DATCP'])
    expect(rig.chunks).toBe(164)
    expect(rig.out.status().upload).toBeNull()
    expect(rig.out.status().torn).toEqual([])
    // progress was reported along the way, slots remaining counted down
    const ups = rig.statuses.map((s) => s.upload).filter((u) => u !== null)
    expect(ups[0]).toEqual({ slot: 1, done: 0, total: 1, remaining: 1 })
    expect(ups.some((u) => u.slot === 1 && u.done === 82 && u.total === 82)).toBe(true)
    expect(ups[ups.length - 1]).toMatchObject({ slot: 2, done: 82, remaining: 0 })

    // same pictures again: nothing to do
    rig.out.setFrames(new Map([[1, a], [2, b]]))
    await tick()
    expect(rig.sent.length).toBe(4)

    // slot 1 is showing; a new picture for it re-uploads AND re-plays it
    rig.out.send([ev(0, { n: 1 })])
    await tick()
    expect(rig.sent[4]).toBe('PLAY 1 1')
    rig.out.setFrames(new Map([[1, b], [2, b]]))
    for (let i = 0; i < 200 && rig.sent.length < 8; i++) await tick()
    expect(rig.sent.slice(5)).toEqual(['DATS', 'DATCP', 'PLAY 1 1'])
    // while slot 2 (not showing) changing does not re-play anything
    rig.out.setFrames(new Map([[1, b], [2, a]]))
    for (let i = 0; i < 200 && rig.sent.length < 10; i++) await tick()
    await tick()
    expect(rig.sent.slice(8)).toEqual(['DATS', 'DATCP'])
  })

  it('folds state changes during an upload into one send when it ends', async () => {
    const rig = makeRig()
    rig.out.attach(rig.dev)
    rig.ackUploads = false // the upload now stalls on each chunk until the device timer fires
    rig.out.setFrames(new Map([[1, paintFrame(() => 0.1)]]))
    await tick()
    expect(rig.sent).toEqual(['DATS'])
    expect(rig.dev.uploading).toBe(true)
    // the pattern runs on through the upload
    rig.out.send([ev(0, { n: 1, gain: 1 }), ev(0, { n: 2 }), ev(0, { n: 3, gain: 0.5 })])
    expect(rig.sent).toEqual(['DATS']) // nothing sent during the upload
    // let the upload time out its way through
    for (let i = 0; i < 200 && rig.dev.uploading; i++) {
      await tick()
      rig.fireDue(400)
    }
    await tick()
    // then the mask is told where the pattern IS, once
    expect(rig.sent).toEqual(['DATS', 'DATCP', 'LIGHT 128', 'PLAY 1 3'])
    expect(rig.out.status().torn.length).toBe(1)
    expect(rig.out.status().torn[0]).toMatchObject({ slot: 1, acked: 0, chunks: 82 })
  })

  it('reports a failed write to onError rather than throwing into the scheduler', async () => {
    const rig = makeRig()
    rig.out.attach(rig.dev)
    rig.drop()
    expect(rig.out.status().device).toBeNull()
    rig.out.send([ev(0, { n: 1 })])
    await tick()
    expect(rig.sent).toEqual([])
    expect(rig.errors).toEqual([])
  })
})
