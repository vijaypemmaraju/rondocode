// Cloudflare Pages rejects any file over 25 MiB. onnxruntime-web's wasm
// (~26 MiB) is emitted into the bundle by Vite's asset scanner, but it is NEVER
// fetched from there at runtime: sing/*.ts set `ort.env.wasm.wasmPaths` to the
// onnxruntime-web CDN, so the browser loads the wasm from jsdelivr. The bundled
// copy is dead weight that only breaks `wrangler pages deploy`. Strip it here so
// `pnpm build` always produces a deployable dist.
//
// Any OTHER oversize file is a real problem (it would 404 in prod or fail the
// deploy), so we fail loudly rather than strip it blind.
import { readdir, stat, unlink } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const LIMIT = 25 * 1024 * 1024 // Cloudflare Pages per-file cap
const assetsDir = fileURLToPath(new URL('../dist/assets', import.meta.url))
const isOrtWasm = (name) => /^ort-wasm.*\.wasm$/.test(name)

let entries
try {
  entries = await readdir(assetsDir)
} catch {
  console.log('[postbuild] no dist/assets — nothing to strip')
  process.exit(0)
}

let stripped = 0
const offenders = []
for (const name of entries) {
  const path = `${assetsDir}/${name}`
  const { size } = await stat(path)
  if (size <= LIMIT) continue
  if (isOrtWasm(name)) {
    await unlink(path)
    stripped++
    console.log(`[postbuild] stripped ${name} (${(size / 1048576).toFixed(1)} MiB, loaded from CDN at runtime)`)
  } else {
    offenders.push(`${name} (${(size / 1048576).toFixed(1)} MiB)`)
  }
}

if (offenders.length > 0) {
  console.error(
    `[postbuild] ERROR: file(s) exceed the ${LIMIT / 1048576} MiB Cloudflare Pages limit and would break the deploy:\n  ` +
      offenders.join('\n  '),
  )
  process.exit(1)
}

if (stripped === 0) console.log('[postbuild] no oversize ort wasm found (nothing to strip)')
