/* Serve probe/index.html and open the shell on it:
 *
 *   pnpm --filter @rondocode/desktop probe
 *
 * The shell's devUrl is overridden on the command line rather than in
 * tauri.conf.json, so the checked-in config is never edited to run this (the
 * first version of this probe left a scratch URL in the config, which is
 * exactly the kind of thing that gets committed by accident).
 *
 * Node's own http server, no dependency: this has to work from a cold
 * checkout, since "does the shell still work after a bump" is the question it
 * exists to answer.
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'

const PORT = Number(process.env.PROBE_PORT ?? 6099)
const page = fileURLToPath(new URL('index.html', import.meta.url))

const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(readFileSync(page)) // read per request, so an edit needs only a reload
})

server.on('error', (e) => {
  process.stderr.write(`probe server: ${e.message}\n`)
  process.exit(1)
})

server.listen(PORT, () => {
  process.stderr.write(`probe page on http://localhost:${PORT}/ — launching the shell\n`)
  const shell = spawn(
    'cargo',
    ['tauri', 'dev', '--no-watch', '--config', JSON.stringify({ build: { devUrl: `http://localhost:${PORT}/`, beforeDevCommand: '' } })],
    { cwd: fileURLToPath(new URL('../src-tauri', import.meta.url)), stdio: 'inherit' },
  )
  shell.on('exit', (code) => {
    server.close()
    process.exit(code ?? 0)
  })
})
