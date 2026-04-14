# Tool reference

All tools live in the `gadget.*` namespace. Inputs are zod schemas; outputs
are JSON-serialized `CallToolResult` values. Role gates are enforced at
registration time.

## Reader-safe tools

| Tool                     | Inputs                                              | Returns                                                |
| ------------------------ | --------------------------------------------------- | ------------------------------------------------------ |
| `gadget.list-gadgets`   | `{ category?, limit?, cursor? }`                    | `{ items[], nextCursor }`                              |
| `gadget.search-gadgets` | `{ query, category?, limit?, cursor? }`             | `{ items[], nextCursor }` — BM25 over FTS5.            |
| `gadget.get-gadget`     | `{ id }`                                            | `{ gadget }` including `aliases[]`.                    |
| `gadget.list-revisions` | `{ id }`                                            | `{ revisions[] }` newest-first.                        |
| `gadget.compose-prompt` | `{ gadgetIds[], separator?, useCanonicalOrder? }`   | `{ prompt, chain[] }`. Unknown ids ⇒ `gadget.composeMissingIds` with `data.missing[]`. |
| `gadget.export-gadgets` | `{ includeHistory?, category? }`                    | `{ ndjson, count }`.                                   |
| `gadget.list-runners`   | —                                                   | `{ runners[] }`.                                       |
| `gadget.list-client-roots` | —                                                 | `{ roots[], supported }` — asks the connected client for its MCP `roots/list`. |

## Writer tools

| Tool                      | Inputs                                                                      | Returns                                   |
| ------------------------- | --------------------------------------------------------------------------- | ----------------------------------------- |
| `gadget.add-gadget`      | `{ id, category, title, description, content, tags? }`                      | `{ id, version }` — v1. Fails on conflict.|
| `gadget.put-gadget`      | same as add                                                                 | `{ id, version, created }`. Always writes a new revision. |
| `gadget.rename-gadget`   | `{ id, newId }`                                                             | `{ id, previousName, aliases[] }`.        |
| `gadget.rollback-gadget` | `{ id, toVersion }`                                                         | `{ id, newVersion }`. Never a silent revert. |
| `gadget.import-gadgets`  | `{ ndjson, conflict: "skip" \| "overwrite" \| "error" }`                    | `{ imported, overwritten, skipped, errors[] }` |
| `gadget.run-reviewer`    | `{ runnerId, prompt, timeoutSeconds? }`                                     | `{ runnerId, status, exitCode, output, stderr, durationMs }` |

## Admin tools

| Tool                    | Inputs                                                                 | Returns          |
| ----------------------- | ---------------------------------------------------------------------- | ---------------- |
| `gadget.delete-gadget` | `{ id }`                                                               | `{ deleted }`    |
| `gadget.upsert-runner` | `{ id, name, command[], enabled?, timeoutSeconds? }`                   | `{ id }`         |
| `gadget.delete-runner` | `{ id }`                                                               | `{ deleted }`    |

## Resource templates

URI-templated resources expose MCP `completion/complete` for their
variables, sourced from the same helpers as the prompt arguments in
`packages/server/src/mcp/completers.ts`.

| URI template                               | Variable   | Completion source                          |
| ------------------------------------------ | ---------- | ------------------------------------------ |
| `gadget://gadget/{id}`                     | `id`       | Live gadget ids + aliases (prefix/substring). |
| `gadget://gadgets/category/{category}`     | `category` | Nine canonical categories (prefix).        |
| `gadget://gadgets/tag/{tag}`               | `tag`      | Distinct tags across the library.          |
| `gadget://runner/{id}`                     | `id`       | Configured reviewer runner ids.            |

Static resources (`gadget://gadgets/all`, `gadget://categories`,
`gadget://compose/canonical`) do not have variables and therefore do
not surface completions.

## Conventions

- **IDs** are kebab-case: `^[a-z0-9][a-z0-9-]{0,63}$`. Validation is enforced
  at `add`, `put`, and `rename`.
- **Cursors** are base64url-encoded JSON, tamper-detected via zod decode; the
  search cursor is bound to its originating query and surfaces
  `gadget.searchCursorQueryMismatch` when the query changes.
- **Aliases** — rename preserves the old id as an alias so consumers still
  resolve it via `gadget.get-gadget`.
- **Revisions** are append-only. Rollback creates a new revision whose
  content matches a prior one; the revision history is auditable from day 0.
- **Errors** surface through `McpError` with `data.gadgetCode` — see
  the table in the top-level `README.md`.
