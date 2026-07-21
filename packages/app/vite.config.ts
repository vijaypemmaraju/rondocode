import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { docsMarkdown } from './src/docs/markdown'

const entry = (name: string): string => fileURLToPath(new URL(name, import.meta.url))

export default defineConfig({
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
    // Two HTML entries: the editor (index) and the standalone docs page.
    // Cloudflare Pages serves docs.html at /docs (clean URLs).
    rollupOptions: {
      input: {
        index: entry('index.html'),
        docs: entry('docs.html'),
      },
    },
  },
})
