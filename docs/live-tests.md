# Live discovery tests

`tests/live/` is an **isolated, opt-in, harness-agnostic** smoke suite
that verifies `gadget-mcp` is *discoverable* by real LLM hosts from
natural-language user prompts alone — no user ever names the tool, the
server, or a specific function.

## What it proves

For each available local LLM harness, a vague request like
*"I need a system prompt for an autonomous Bun engineer…"* causes the LLM
to call an `mcp__gadget-mcp__*` tool (typically `list-gadgets`,
`search-gadgets`, `get-gadget`, or `compose-prompt`) without the prompt
mentioning any of those names. This validates that the tool titles and
descriptions registered in `packages/server/src/mcp/tools.ts`, the
resource URI-template titles, and the `gadget-build-chain` prompt are
semantically aligned with the problem space.

## Supported harnesses

Defined in `tests/live/harnesses/`:

| Adapter                             | Required binary | How MCP is wired                                         |
| ----------------------------------- | --------------- | -------------------------------------------------------- |
| `tests/live/harnesses/claude.ts`    | `claude`        | `--mcp-config <tmp.json>` + `--output-format stream-json`|
| `tests/live/harnesses/codex.ts`     | `codex`         | `-c mcp_servers.gadget-mcp.command=...` + `--json`       |

Adding a new harness is one file implementing the `Harness` interface in
`tests/live/harness.ts`. The suite auto-detects every harness whose
`isAvailable()` returns true.

## Running

The suite is skipped by default. Two knobs:

```sh
GADGET_LIVE_TESTS=1 bun run test:live
# optional timeout override (per harness × case):
GADGET_LIVE_TIMEOUT_MS=240000 bun run test:live
```

If neither `claude` nor `codex` is on `PATH`, the suite emits a skipped
result and returns success — the absence of a harness is not a failure.

Live runs spend real model credits. Expect one outbound model call per
case × harness. Current cases are in `tests/live/discovery.test.ts` under
`CASES`; keep the list small.

## CI integration

The CI workflow ships a `workflow_dispatch` job that runs the live suite
on demand, gated on a repository secret. See
`.github/workflows/ci.yml#live-discovery`. Normal PR runs never touch
this job.

## Failure signals

A failing test prints the harness exit code, duration, and tool-call
count to stderr. Common causes:

- **Model picked no tool.** Description or title drift in
  `tools.ts`; the server is advertising tools but their *names* or
  *purposes* no longer match the user intent. Fix by sharpening the
  `title` / `description` fields.
- **Harness invoked a different MCP server.** The allowlist
  (`allowedToolGlobs: ["mcp__gadget-mcp__*"]`) pins Claude to our server
  only; codex honors `mcp_servers` map. If the test still drifts, widen
  or narrow the allowlist to diagnose.
- **Timeout.** Bump `GADGET_LIVE_TIMEOUT_MS`; live calls can take a
  minute or more with reasoning-heavy prompts.
