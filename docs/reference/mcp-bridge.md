# The MCP bridge

The bridge lets an AI agent drive a **live** rondocode session: read the code
that is playing, evaluate a new program, move a param, start and stop the
transport. It is the link between an MCP client (Claude Code, Claude Desktop)
and the browser tab making the sound.

It is entirely **optional**. The app runs with no bridge at all, and everything
below is only needed if you want an agent in the loop.

```
you (MCP client) -- stdio --> mcp server -- ws :6070 --> browser app
                                                          |- Session (the live program)
                                                          |- editor (the human's text)
                                                          '- audio engine (WebAudio worklet)
```

If you are the agent rather than the person setting this up, read
[agent-guide.md](agent-guide.md) instead: it covers the tool surface, the eval
semantics and the rules that matter once you are connected.

## "Firefox can't establish a connection to ws://localhost:6070/session"

**This is expected when you are not running the bridge, and it is harmless.**

The app dials the bridge on every page load and retries with a 1s..30s backoff,
because the bridge may be started at any time and the tab should pick it up
without a refresh. When nothing is listening on 6070, the browser logs a
connection failure each time it tries. Firefox says it loudly; Chrome says it
quietly. Nothing in the app depends on it: audio, MIDI, the editor and every
panel work exactly the same either way.

If you want it to stop, start the bridge (below). There is no way for the page
to silence it: a failed WebSocket connection is logged by the browser itself,
below the level any script can reach.

## Running it

Two entry points. They both open the same WebSocket on the same port, so run
**one** of them.

### With an agent (the usual case)

The repo root ships a `.mcp.json`, so an MCP client that reads it will launch
everything itself:

```json
{
  "mcpServers": {
    "rondocode": {
      "command": "pnpm",
      "args": ["--filter", "@rondocode/server", "exec", "tsx", "src/mcp-stdio.ts"]
    }
  }
}
```

One process runs **both halves**: the MCP server on stdio and the bridge on
`ws://localhost:6070/session`. You do not start the bridge separately. In Claude
Code, being in the repo is enough; for a client configured elsewhere, point it
at the same command with the repo as the working directory.

Then open the app (`pnpm dev`) in a browser tab. Order does not matter: the
bridge listens first on purpose, so an agent's first tool call meets a live
socket and gets the actionable `no browser session connected` error rather than
a dead port.

### Standalone, without an agent

```
pnpm bridge
```

Runs the bridge alone, for development and manual testing against the browser
client. There is no MCP server in this mode, so no tools -- it is for working on
the bridge itself.

### Port

6070 by default, `PORT` to change it:

```
PORT=6171 pnpm bridge
```

The **browser side is not configurable**: it derives the URL from the page it is
served from, always on port 6070 (see `defaultBridgeUrl` in
`packages/app/src/session/bridge-client.ts`). So changing the port is only
useful when you are not driving a browser at all.

## "port 6070 is already in use"

Only one bridge can hold the port, and both entry points open it. The usual
causes are a second editor with the MCP server configured, or a `pnpm bridge`
left running from earlier. Stop the other one, or give this one a different port
with `PORT` (remembering that a browser will then not find it).

## One tab at a time

The bridge holds a single browser session, and the **newest connection wins**. A
new `/session` connection closes the previous one with WebSocket code 4000 and
reason `superseded`, and the superseded tab goes dormant rather than
reconnecting: reconnecting would only steal the session back and thrash. Reload
the dormant tab to reclaim it.

That is what makes refreshing the page work: a reload would otherwise leave the
bridge talking to a zombie socket. The cost is that two open tabs cannot both be
driven, and the second one you open takes control.

## What needs a browser, and what does not

| tools | browser tab |
|---|---|
| `get_code`, `eval_code`, `set_param`, `set_channel`, `transport`, `get_state`, `get_diagnostics` | required |
| `render_code`, `render_synth`, `compare_renders` | not required |

The live tools talk to the running Session. Without a tab they return an error beginning
`no browser session connected`, which only a human can fix by opening or
refreshing the app.

The render tools evaluate and render offline inside the MCP server itself and
hand back a WAV plus analysis, so an agent can hear its work with no browser and
no audio device.

Three documentation resources come over the same connection:
`rondocode://docs/dsl-reference`, `rondocode://docs/agent-guide` and
`rondocode://docs/examples`.

## Pulling the buffer back to a file

The editor reads local examples from the gitignored local directory beside
`packages/app/src/examples/local-loader.ts`, and until recently nothing went
the other way: edits made in the browser lived in the project store while the
file on disk quietly fell behind.

```
pnpm pull-local levels          # write the running buffer to local/levels.ts
pnpm pull-local levels --dry    # say what would change, write nothing
```

It reads `GET /doc` on the bridge, which answers with the EDITOR's text and the
language it is in:

```json
{ "text": "synth pad\n  saw note\n", "lang": "rondo" }
```

That is deliberately not `get_code`, which answers with the session's evaluated
JavaScript: what you are editing may be rondo, and a file written from the
compiled output would lose the source. When the buffer is rondo the file gets
both, with the JavaScript COMPILED from it rather than written twice, so the
two halves cannot drift into different tunes. A buffer that does not compile is
refused rather than written.

It is an HTTP read rather than a second WebSocket for one reason: the bridge
gives the session to the newest `/session` connection and closes the previous
one, so a tool that dialled in to ask what the tab was showing would disconnect
the tab it was asking about. With no browser connected it answers 503 and the
command says so.

## Ghost-text completion

The bridge process also serves the editor's inline AI completion, over HTTP on
the same port. It needs `ANTHROPIC_API_KEY` in the environment:

```
ANTHROPIC_API_KEY=sk-... pnpm bridge
```

Both entry points say on startup which way they came up:

```
[bridge] ghost-text completion disabled (no ANTHROPIC_API_KEY)          # pnpm bridge
[rondocode-mcp] ghost-text completion disabled (no ANTHROPIC_API_KEY)   # mcp-stdio
```

Note the stdio entry logs to **stderr**, never stdout: stdout carries MCP
JSON-RPC frames and anything else written there corrupts the transport.

Ghost completion is also **dev-only** in the editor -- production builds never
install the extension -- so the key does nothing against a built app.

## Protocol

JSON text frames over the WebSocket. The server calls the browser; the browser
answers and volunteers notifications.

```
server -> browser   { id, method, params? }
browser -> server   { id, result? , error?: { message } }
browser -> server   { notify: 'diagnostics' | 'state' | 'hello', payload }   (no id, never answered)
```

`packages/server/src/bridge.ts` is the Node half and
`packages/app/src/session/bridge-client.ts` the browser half; between them the
header comments carry the details this page leaves out.

## One known limitation

`eval_code` evaluates into the **session**, not into the human's editor text.
Their document is unchanged, so if they press Run, their text replaces the
agent's program. Worth knowing before you wonder where your changes went.
