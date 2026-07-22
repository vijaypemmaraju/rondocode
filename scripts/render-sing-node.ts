/* Headless neural-sing render (no browser). Polyfills the Cache API with a disk
 * cache so the ~1.7 GB of models download once, then re-runs are fast. Writes a
 * mono WAV of the VOCAL clip for objective measurement.
 *   npx tsx scripts/render-sing-node.ts <out.wav> [voice] [cps] "<lyrics>" "<notes>"
 */
import { createHash } from 'node:crypto'
import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import * as ort from 'onnxruntime-web'

// onnxruntime-web's wasm backend can't import() the CDN URL under Node's ESM
// loader — point it at the locally-installed dist instead (the sing modules only
// set the CDN path when wasmPaths is still unset, so this wins).
{
  const pnpm = 'node_modules/.pnpm'
  const dir = readdirSync(pnpm).find((d) => d.startsWith('onnxruntime-web@'))
  if (!dir) throw new Error('onnxruntime-web not found under .pnpm')
  const dist = `${process.cwd()}/${pnpm}/${dir}/node_modules/onnxruntime-web/dist/`
  ort.env.wasm.wasmPaths = pathToFileURL(dist).href
}

const CACHE_DIR = '/private/tmp/claude-501/-Volumes-vijay-ssd-personal-music-code/97b4e403-54fb-49eb-919e-0ef09020ccfb/scratchpad/model_cache'
mkdirSync(CACHE_DIR, { recursive: true })
const keyFor = (url: string): string => createHash('md5').update(url).digest('hex')

// Minimal Cache API over disk: match reads the cached bytes, put writes them.
;(globalThis as unknown as { caches: unknown }).caches = {
  async open(): Promise<unknown> {
    return {
      async match(req: string | { url: string }): Promise<Response | undefined> {
        const url = typeof req === 'string' ? req : req.url
        const p = `${CACHE_DIR}/${keyFor(url)}`
        return existsSync(p) ? new Response(readFileSync(p)) : undefined
      },
      async put(req: string | { url: string }, resp: Response): Promise<void> {
        const url = typeof req === 'string' ? req : req.url
        const buf = Buffer.from(await resp.arrayBuffer())
        writeFileSync(`${CACHE_DIR}/${keyFor(url)}`, buf)
      },
    }
  },
}

function writeWavMono(path: string, data: Float32Array, sr: number): void {
  const buf = Buffer.alloc(44 + data.length * 2)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + data.length * 2, 4); buf.write('WAVE', 8)
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34)
  buf.write('data', 36); buf.writeUInt32LE(data.length * 2, 40)
  for (let i = 0; i < data.length; i++) {
    const s = Math.max(-1, Math.min(1, data[i]!))
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2)
  }
  writeFileSync(path, buf)
}

const TWINKLE_LYRICS = 'twin-kle twin-kle lit-tle star how I won-der what you are up a-bove the world so high like a dia-mond in the sky twin-kle twin-kle lit-tle star how I won-der what you are'
const TWINKLE_NOTES = 'c4 c4 g4 g4 a4 a4 g4@2 f4 f4 e4 e4 d4 d4 c4@2 g4 g4 f4 f4 e4 e4 d4@2 g4 g4 f4 f4 e4 e4 d4@2 c4 c4 g4 g4 a4 a4 g4@2 f4 f4 e4 e4 d4 d4 c4@2'

async function main(): Promise<void> {
  const out = process.argv[2] ?? '/tmp/node_sing.wav'
  const voice = process.argv[3] ?? 'barbara'
  const cps = Number(process.argv[4] ?? '0.05')
  const lyrics = process.argv[5] ?? TWINKLE_LYRICS
  const notes = process.argv[6] ?? TWINKLE_NOTES
  const t0 = Date.now()
  const { renderNeural } = await import('../packages/app/src/sing/neural')
  const { audio, sr } = await renderNeural(lyrics, notes, cps, voice, (p) => {
    if (p.total > 1e6) process.stderr.write(`\r${p.phase} ${p.label} ${(p.done / 1e6).toFixed(0)}/${(p.total / 1e6).toFixed(0)}MB   `)
  })
  process.stderr.write('\n')
  writeWavMono(out, audio, sr)
  console.log(`wrote ${out}  ${(audio.length / sr).toFixed(2)}s @ ${sr}Hz  in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
}
main().catch((e) => { console.error(e); process.exit(1) })
