/* Stdio entry: ONE process runs both halves of the agent link — the MCP
 * server on stdio (Claude Code's default transport) and the Bridge on
 * ws :6070 (PORT env) for the browser. Launched by the repo-root .mcp.json.
 *
 * STDOUT DISCIPLINE: the stdio transport owns stdout — every frame written
 * there must be MCP JSON-RPC. All logging goes to STDERR (console.error /
 * console.warn; the Bridge itself only console.warn's). Never console.log
 * in anything this file imports at runtime. */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { Bridge } from './bridge'
import { createMcpServer } from './mcp'
import { CompletionService, makeCompleteHandler } from './complete'

const port = Number(process.env.PORT ?? 6070)
const completion = new CompletionService()
const bridge = new Bridge({ port, httpHandler: makeCompleteHandler(completion) })
const server = createMcpServer(bridge)
console.error(
  `[rondocode-mcp] ghost-text completion ${completion.available ? 'ENABLED' : 'disabled (no ANTHROPIC_API_KEY)'}`,
)

// Bridge first: an agent's first tool call should meet a listening ws even
// if the browser hasn't dialed in yet (it gets the actionable NO_SESSION
// error, not a dead port).
await bridge.listen()
console.error(`[rondocode-mcp] bridge listening on ws://localhost:${bridge.port}/session`)

await server.connect(new StdioServerTransport())
console.error('[rondocode-mcp] mcp server ready on stdio')

const shutdown = (): void => {
  void bridge.close().then(() => process.exit(0))
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
// Claude Code signals shutdown by closing our stdin.
process.stdin.on('close', shutdown)
