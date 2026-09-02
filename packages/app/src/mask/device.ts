/* ------------------------------------------------------------------------- *
 * One connected mask: a serial command queue and the paced picture upload.
 *
 * The link underneath is an interface rather than Web Bluetooth directly so
 * the pacing, the acknowledgement counting and the queueing can be tested
 * against a scripted mask (device.test.ts). webbluetooth.ts is the only real
 * implementation.
 *
 * Why serial: the mask answers one thing at a time. A burst of unacknowledged
 * writes measured at ~850 ms per command afterwards, against 30-50 ms when
 * each write waits for its response. Everything goes through one queue, and
 * an upload holds that queue for its whole run, which is what lets the output
 * layer coalesce pattern commands behind it instead of piling them up.
 * ------------------------------------------------------------------------- */

import { cmdUploadEnd, cmdUploadStart, decodeReply, uploadPackets } from './protocol'

/** The transport the device drives. Both writes are WITH response. */
export interface MaskLink {
  /** the advertised name, for the UI */
  name: string
  writeCommand(bytes: Uint8Array): Promise<void>
  writeUpload(bytes: Uint8Array): Promise<void>
  /** every notification the mask sends, raw (still encrypted) */
  onReply(fn: (bytes: Uint8Array) => void): void
  onDisconnect(fn: () => void): void
  disconnect(): void
}

export interface UploadReport {
  slot: number
  chunks: number
  /** chunks the mask acknowledged; fewer than `chunks` means a torn picture */
  acked: number
  /** the mask confirmed `DATS` and `DATCP` */
  framed: boolean
}

export interface MaskDeviceOpts {
  /** how long to wait for one acknowledgement before moving on */
  ackTimeoutMs?: number
  /** injectable for tests */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (h: unknown) => void
}

/** Measured: a chunk is acknowledged well inside 100 ms; 400 leaves room for
 *  a slow radio without stalling a torn upload for long. */
const DEFAULT_ACK_TIMEOUT_MS = 400

export class MaskDevice {
  private queue: Promise<unknown> = Promise.resolve()
  /** replies are COUNTED, not paired with writes: the mask's notification
   *  for a write can land before the write's own promise settles, so waiting
   *  for "the next reply" after the write would skip one and drift by one
   *  for the rest of the upload. Each wait names the count it needs. */
  private replyCount = 0
  private lastWord = ''
  private waiters: { target: number; finish: (word: string) => void }[] = []
  private closed = false
  private readonly ackTimeoutMs: number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (h: unknown) => void
  private readonly closeListeners = new Set<() => void>()
  /** true while an upload owns the queue; the output layer holds its
   *  commands until it clears rather than queueing them behind five seconds
   *  of chunks */
  uploading = false

  constructor(private readonly link: MaskLink, opts: MaskDeviceOpts = {}) {
    this.ackTimeoutMs = opts.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
    link.onReply((bytes) => {
      this.lastWord = decodeReply(bytes).word
      this.replyCount++
      const ready = this.waiters.filter((w) => w.target <= this.replyCount)
      this.waiters = this.waiters.filter((w) => w.target > this.replyCount)
      for (const w of ready) w.finish(this.lastWord)
    })
    link.onDisconnect(() => this.markClosed())
  }

  get name(): string {
    return this.link.name
  }

  get connected(): boolean {
    return !this.closed
  }

  /** Fires once, when the link drops or disconnect() is called. */
  onClose(fn: () => void): void {
    this.closeListeners.add(fn)
  }

  /** Send one encrypted command block, after everything already queued. */
  command(bytes: Uint8Array): Promise<void> {
    return this.run(() => this.link.writeCommand(bytes))
  }

  /** Upload a PACKED picture (see protocol.packFrame) into a DIY slot, one
   *  acknowledged chunk at a time. Holds the queue for the duration. */
  uploadFrame(slot: number, packed: Uint8Array, onProgress?: (done: number, total: number) => void): Promise<UploadReport> {
    return this.run(async () => {
      this.uploading = true
      try {
        const packets = uploadPackets(packed)
        let acked = 0
        let framed = true
        let expect = this.replyCount
        // the reply after the next write. A reply that never comes (the mask
        // dropped the chunk) must not leave every later wait one behind, so a
        // timed-out wait re-aligns the count with what has actually arrived.
        const nextReply = async (): Promise<string> => {
          const word = await this.replyNumber(++expect)
          if (word === '') expect = this.replyCount
          return word
        }
        await this.link.writeCommand(cmdUploadStart(packed.length, slot))
        if ((await nextReply()) !== 'DATSOK') framed = false
        for (let i = 0; i < packets.length && !this.closed; i++) {
          await this.link.writeUpload(packets[i]!)
          if ((await nextReply()) === 'REOK') acked++
          onProgress?.(i + 1, packets.length)
        }
        // a link that dropped mid-picture has nothing to finish
        if (this.closed) return { slot, chunks: packets.length, acked, framed: false }
        await this.link.writeCommand(cmdUploadEnd())
        if ((await nextReply()) !== 'DATCPOK') framed = false
        return { slot, chunks: packets.length, acked, framed }
      } finally {
        this.uploading = false
      }
    })
  }

  disconnect(): void {
    if (this.closed) return
    this.link.disconnect()
    this.markClosed()
  }

  /** The word of the `target`-th reply (1-based, cumulative), or '' when it
   *  has not arrived within the timeout. Resolves at once if it already has. */
  private replyNumber(target: number): Promise<string> {
    if (this.replyCount >= target) return Promise.resolve(this.lastWord)
    if (this.closed) return Promise.resolve('')
    return new Promise<string>((resolve) => {
      let done = false
      const finish = (word: string): void => {
        if (done) return
        done = true
        this.clearTimer(h)
        resolve(word)
      }
      const h = this.setTimer(() => {
        this.waiters = this.waiters.filter((w) => w.finish !== finish)
        finish('')
      }, this.ackTimeoutMs)
      this.waiters.push({ target, finish })
    })
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('mask disconnected'))
    const next = this.queue.then(fn)
    // the queue itself never rejects, or one failed write would poison it
    this.queue = next.catch(() => undefined)
    return next
  }

  private markClosed(): void {
    if (this.closed) return
    this.closed = true
    // release anything waiting on an acknowledgement that will never come
    const ws = this.waiters
    this.waiters = []
    for (const w of ws) w.finish('')
    for (const fn of this.closeListeners) fn()
  }
}
