/* CLI entry: run the bridge for real (root script `pnpm bridge`). The MCP
 * server (Task 4.2) will embed Bridge directly; this standalone entry exists
 * for development and manual testing against the browser client. */
import { Bridge } from './bridge'
import { CompletionService, makeCompleteHandler } from './complete'

const port = Number(process.env.PORT ?? 6070)
const completion = new CompletionService()
const bridge = new Bridge({ port, httpHandler: makeCompleteHandler(completion) })
console.log(
  `[bridge] ghost-text completion ${completion.available ? 'enabled' : 'disabled (no ANTHROPIC_API_KEY)'}`,
)

bridge.onNotify = (kind, payload) => {
  console.log(`[bridge] notify ${kind}:`, JSON.stringify(payload))
}

await bridge.listen()
console.log(`bridge listening :${bridge.port}`)

process.on('SIGINT', () => {
  console.log('\n[bridge] shutting down')
  void bridge.close().then(() => process.exit(0))
})
