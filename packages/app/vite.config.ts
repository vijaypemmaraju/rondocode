import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { docsMarkdown } from './src/docs/markdown'

const entry = (name: string): string => fileURLToPath(new URL(name, import.meta.url))

export default defineConfig(({ mode }) => ({
  // PRIVATE EXAMPLES MUST NOT SHIP. src/examples/local/ is gitignored, but the
  // loader's `import.meta.glob(..., { eager: true })` becomes STATIC IMPORTS at
  // build time, so every local example was bundled into production even though
  // nothing in the UI listed it (a runtime DEV guard cannot fix that — the code
  // is already in the file). Swapping the module out at resolve time is the
  // only way the sources are never read at all.
  resolve: {
    alias: mode === 'production'
      ? [{ find: /^\.\/local-loader$/, replacement: entry('./src/examples/local-loader.prod.ts') }]
      : [],
  },
  // Emit the docs as Markdown at /llms.txt (the LLM-consumable convention),
  // generated from the same guide + reference data the docs page renders.
  plugins: [
    {
      name: 'emit-llms-txt',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'llms.txt', source: docsMarkdown() })
      },
    },
  ],
  // The AudioWorklet processor is loaded via `?worker&url` (see
  // src/audio/AudioSession.ts). audioWorklet.addModule always loads ES
  // modules, so the worker bundle must be emitted as one.
  worker: { format: 'es' },
  // Allow access through the tailscale-serve HTTPS proxy (Vite's
  // DNS-rebinding host check rejects unknown hostnames otherwise).
  server: { allowedHosts: ['.ts.net'] },
  build: {
    // Three HTML entries: the editor (index), the standalone docs page, and
    // the iOS/Safari diagnostics page. Cloudflare Pages serves docs.html at
    // /docs and diag.html at /diag (clean URLs).
    rollupOptions: {
      input: {
        index: entry('index.html'),
        docs: entry('docs.html'),
        diag: entry('diag.html'),
      },
    },
  },
}))
