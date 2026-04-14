# Transports

## stdio (default)

Local, trusted, JSON-RPC over stdin/stdout. Invoked by parent processes
(Claude Desktop, Cursor, VS Code Copilot, Codex CLI, etc.) via the
`StdioClientTransport` in the MCP SDK.

```sh
gadget-mcp --stdio --workspace=default
```

Logging goes to stderr so stdio traffic stays clean for the MCP framing.

## Streamable HTTP

Untrusted, hosted on `Bun.serve`. Four routes:

| Route      | Method    | Behavior                                                        |
| ---------- | --------- | --------------------------------------------------------------- |
| `/healthz` | GET       | Always `200 "ok"` while the process is up.                      |
| `/readyz`  | GET       | `200 "ready"` if the default workspace DB answers `SELECT 1`.   |
| `/metrics` | GET       | Prometheus text v0.0.4 (counters, histograms, gauges).          |
| `/mcp`     | POST / GET / DELETE | MCP JSON-RPC over SSE via `WebStandardStreamableHTTPServerTransport`. |

### Sessions

First `/mcp` POST with no `Mcp-Session-Id` header initializes a session.
The server responds with a freshly generated UUID; subsequent requests are
routed by the header. Each session owns a new `McpServer` instance scoped
to `role` (from the bearer token) and `workspace` (from the query string
or the server default).

Session close (`DELETE /mcp` or network drop) tears down the server and
removes it from the session map.

### Multi-workspace routing

`?workspace=<name>` selects the workspace by name. Unknown workspace ⇒
`404` with `{"error":"unknown workspace: <name>"}`. Missing query
parameter ⇒ the server's default workspace (single-workspace installs
need no query string at all).

### Switching transports

```sh
gadget-mcp --stdio                      # local parent process
gadget-mcp --http --host 0.0.0.0 --port 7878
gadget-mcp --stdio --http               # both at once
```

Absent any flag, `serve` defaults to `--http`.

### Request tracing

Every response carries an `X-Request-Id` header (echoed from the request
when present, otherwise a fresh UUID). Structured JSON logs include the
same `requestId` for correlation.
