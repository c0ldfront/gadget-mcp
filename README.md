# gadget-mcp

A Bun + TypeScript [Model Context Protocol][mcp] server that manages a persistent
library of reusable prompt **gadgets** across the nine standard prompt
components (role, context, task, constraint, format, example, reasoning, tone,
caveat) and the **reviewer runners** that drive peer-review workflows. It
exposes tools to list, get, add, rename, rollback, export, import, and compose
gadgets into finished prompts for any upstream LLM.

gadget-mcp ships with dual stdio + Streamable HTTP transports on `Bun.serve`,
bearer-token RBAC, multi-workspace SQLite isolation, hand-rolled Prometheus
metrics, an append-only audit log, `VACUUM INTO` backups, a CycloneDX 1.5 SBOM,
and a distroless static-binary Docker image.

## Quick start

```sh
bun install
bun run dev             # --hot reloading server on stdio+http
bun run check           # biome + tsc + bun test
bun test tests/e2e.test.ts   # end-to-end over both transports
```

## Workspace layout

```
packages/
  core/      # domain + bun:sqlite storage + services (gadgets, audit, metrics, runners, ndjson)
  server/    # MCP SDK integration, auth, transports, CLI
data/
  gadgets.ndjson           # seed gadget catalog (22 rpp-ts-style domain gadgets, embedded in the compiled binary)
  gadgets.ndjson.bak       # prior meta-gadget seed set, preserved for reference
  reviewer_runners.json    # seed reviewer runners (also embedded)
  tone-caveman.ndjson      # optional pack: 3 compression-tone gadgets; enable with GADGET_PACKS=tone-caveman
artifacts/   # runtime output (DB, backups, custom gadgets)
tests/       # end-to-end spec spawning the CLI over stdio + HTTP
```

## CLI

```sh
gadget-mcp [serve] [--stdio|--http] [--workspace=NAME] [--host=HOST] [--port=N]
gadget-mcp backup  --out /path/to/backup.db [--workspace=NAME]
gadget-mcp restore --in  /path/to/backup.db [--workspace=NAME]
gadget-mcp audit tail 100 [--workspace=NAME]
gadget-mcp generate <claude-desktop|cursor|vscode|mcp-json|shell-env> \
            [--stdio|--http] [--url URL] [--token T] [--workspace NAME] [--out PATH]
gadget-mcp --version
gadget-mcp --help
```

Absent `--stdio` or `--http`, `serve` defaults to Streamable HTTP.

## Environment

| Variable                       | Purpose                                                      | Default                  |
| ------------------------------ | ------------------------------------------------------------ | ------------------------ |
| `GADGET_DB`                    | Default SQLite path                                          | `./artifacts/gadget.db`  |
| `GADGET_WORKSPACES`            | JSON `{name: dbPath}` for multi-workspace isolation          | single `default`         |
| `GADGET_HTTP_HOST`             | HTTP bind host                                               | `127.0.0.1`              |
| `GADGET_HTTP_PORT`             | HTTP bind port                                               | `7878`                   |
| `GADGET_HTTP_TOKENS`           | CSV of `token:role` pairs (`reader\|writer\|admin`)          | — (auth disabled, admin) |
| `GADGET_ORIGIN_ALLOWLIST`      | CSV of allowed `Origin` header values                        | — (no origin check)      |
| `GADGET_HTTP_ALLOWED_HOSTS`    | CSV of allowed `Host` header values (DNS-rebind mitigation)  | — (no host check)        |
| `GADGET_HTTP_MAX_BODY_BYTES`   | Cap on `Content-Length` for `/mcp` POSTs                     | `10485760` (10 MB)       |
| `GADGET_SEED`                  | `auto` (default) seeds from `data/` — or the payload embedded in the binary when files are absent; `off` skips | `auto`                   |
| `GADGET_PACKS`                 | CSV of opt-in NDJSON packs embedded in the binary (e.g. `tone-caveman`) | — |
| `GADGET_DISABLE_SHAPE_CHECK`   | Set to `1\|true\|yes\|on` to disable the heading/code-fence shape guard on add/put | — |
| `GADGET_KICKOFF_EXEC`          | Executable spawned by `gadget.project-kickoff` when the user picks `execute` at the preview step | —        |
| `GADGET_AUDIT_DAYS`            | Audit retention in days                                      | `90`                     |

## Tools (MCP)

| Tool                        | Role    | Purpose                                                          |
| --------------------------- | ------- | ---------------------------------------------------------------- |
| `gadget.list-gadgets`      | reader  | Paged list, optional category filter                             |
| `gadget.search-gadgets`    | reader  | FTS5 full-text search                                            |
| `gadget.get-gadget`        | reader  | Full gadget (by id or alias)                                     |
| `gadget.list-revisions`    | reader  | Revision history for a gadget                                    |
| `gadget.compose-prompt`    | reader  | Chain gadgets into a final prompt                                |
| `gadget.export-gadgets`    | reader  | NDJSON export with optional `_revisions`                         |
| `gadget.list-runners`      | reader  | List reviewer runners                                            |
| `gadget.list-client-roots` | reader  | Query the connected client's `roots/list` (observability)        |
| `gadget.add-gadget`        | writer  | Add a new gadget (fails on conflict)                             |
| `gadget.put-gadget`        | writer  | Upsert a gadget (always writes a new revision)                   |
| `gadget.rename-gadget`     | writer  | Rename; old id is preserved as an alias                          |
| `gadget.rollback-gadget`   | writer  | Restore a prior revision as the new live revision                |
| `gadget.import-gadgets`    | writer  | NDJSON import with `skip\|overwrite\|error` conflict policy      |
| `gadget.run-reviewer`      | writer  | Execute a reviewer runner against a prompt                       |
| `gadget.upsert-runner`     | admin   | Create/update a reviewer runner                                  |
| `gadget.delete-gadget`     | admin   | Delete a gadget (cascades revisions + aliases)                   |
| `gadget.delete-runner`     | admin   | Delete a reviewer runner                                         |

## Resources (MCP)

| URI                                            | Content                                     | Completes |
| ---------------------------------------------- | ------------------------------------------- | --------- |
| `gadget://gadgets/all`                         | All gadget summaries                        | —         |
| `gadget://categories`                          | The nine canonical categories               | —         |
| `gadget://compose/canonical`                   | Most-recent gadget per category             | —         |
| `gadget://gadget/{id}`                         | Full gadget by id (resolves aliases)        | `id`      |
| `gadget://gadgets/category/{category}`         | All gadgets in a category                   | `category`|
| `gadget://gadgets/tag/{tag}`                   | Gadgets whose tag list contains `{tag}`     | `tag`     |
| `gadget://runner/{id}`                         | Full JSON for a configured reviewer runner  | `id`      |

## Prompts (MCP)

All prompts surface in MCP clients as `/mcp__gadget-mcp__<name>`:

| Prompt                           | Args                                         | Purpose |
| -------------------------------- | -------------------------------------------- | ------- |
| `gadget-project-kickoff`         | —                                            | Interactive five-step MCP-elicitation wizard that composes a paste-ready project kickoff prompt. |
| `gadget-author`                  | `category?` *(completes)*, `intent?`         | Teach the single-purpose authoring rule with live curated exemplars before the LLM calls `add-gadget` or `put-gadget`. |
| `gadget-build-chain`             | `task`                                       | Walk the list → get → add → compose workflow for `task`. |
| `gadget-build-system-prompt`     | `task`, `category?` *(completes)*            | Primary entry point when a user asks for a system prompt / persona / reviewer template — ends in `gadget.compose-prompt`. |
| `gadget-align-repo`              | `focus?` *(completes: errors / tests / docs / ci / security)* | Audit the current working directory against the gadget-mcp engineering charter and produce a prioritized punch list. |
| `gadget-inspect`                 | `id` *(completes over live ids + aliases)*   | Fetch and summarize a single gadget (content + revisions + aliases). |
| `gadget-run-reviewer`            | `runnerId` *(completes)*, `prompt`           | Execute a configured reviewer runner against a prompt and summarize the output. |

Server advertises `completions: {}` and responds correctly to
`completion/complete`; some clients (e.g. Claude Code as of v2.1.107)
don't yet surface prompt-arg autocomplete in their slash-command UI. See
[`docs/prompts.md`](docs/prompts.md) for the full contract of each.

## Error codes

All MCP-surface errors are `McpError` with `data.gadgetCode`:

| Code                                 | Meaning                                                        |
| ------------------------------------ | -------------------------------------------------------------- |
| `gadget.notFound`                   | Gadget id or alias not found                                   |
| `gadget.alreadyExists`              | Gadget id already exists on `add-gadget`                       |
| `gadget.aliasConflict`              | New id collides with an existing live id or alias              |
| `gadget.tooManyAliases`             | Rename would exceed the per-gadget alias cap (32)              |
| `gadget.invalidGadget`              | Invalid gadget payload (zod validation)                        |
| `gadget.invalidGadgetId`            | Invalid gadget id (must match `^[a-z0-9][a-z0-9-]{0,63}$`)     |
| `gadget.categoryUnknown`            | Unknown gadget category                                        |
| `gadget.composeMissingIds`          | `compose-prompt` received unknown ids (with `data.missing[]`)  |
| `gadget.revisionMissing`            | Rollback target version does not exist                         |
| `gadget.malformedCursor`            | Pagination cursor is malformed                                 |
| `gadget.searchCursorQueryMismatch`  | Search cursor was issued for a different query                 |
| `gadget.unauthorized`               | Missing or invalid bearer token                                |
| `gadget.forbidden`                  | Authenticated role lacks the required permission               |
| `gadget.workspaceUnknown`           | Unknown workspace in `?workspace=` or `GADGET_WORKSPACES`     |
| `gadget.cancelled`                  | Client cancelled the request                                   |
| `gadget.runnerMissing`              | Reviewer runner not configured                                 |
| `gadget.runnerFailed`               | Reviewer runner exited non-zero                                |

## HTTP surface

| Route      | Purpose                                                 |
| ---------- | ------------------------------------------------------- |
| `/healthz` | Liveness (always 200 when process is up)                |
| `/readyz`  | Readiness (probes the default workspace DB)             |
| `/metrics` | Prometheus text v0.0.4 (counters, histograms, gauges)   |
| `/mcp`     | Streamable HTTP MCP endpoint (bearer auth + sessions)   |

### Metrics

- `gadget_tool_calls_total{tool,result}` — counter
- `gadget_tool_call_duration_seconds{tool}` — histogram
- `gadget_content_chars{tool}` — histogram of gadget content size
  (buckets `50..8000`) recorded on every mutating write; watch for
  drift away from the 150–250-char house style.
- `gadget_gadgets_total`, `gadget_revisions_total`, `gadget_aliases_total`,
  `gadget_audit_rows_total`, `gadget_fts_rows_total` — gauges

## Config generators

```sh
gadget-mcp generate claude-desktop --stdio > claude_desktop_config.json
gadget-mcp generate vscode --http --url http://localhost:7878/mcp --token s3cr3t
gadget-mcp generate shell-env --token s3cr3t
```

## Docker

```sh
docker build -t gadget-mcp .
docker run --rm -v gadget:/data -p 7878:7878 gadget-mcp
```

Runtime image is `gcr.io/distroless/base-debian12:nonroot`, single static
binary, no shell.

## Releases

```sh
bun run forge.ts targets
bun run forge.ts build
bun run forge.ts package       # tars + SHA256SUMS.txt
bun run forge.ts source        # git archive
bun run forge.ts sbom          # CycloneDX 1.5 JSON
bun run forge.ts release       # all of the above
```

## License

MIT.

[mcp]: https://modelcontextprotocol.io/
