# Tool reference

All tools live in the `gadget.*` namespace. Every tool declares an
`inputSchema` (raw Zod shape with per-field `.describe()` hints) AND an
`outputSchema` — so clients can validate responses and surface per-arg help
at `tools/list` time. Role gates are enforced at registration time.

## Reader-safe tools

| Tool                     | Inputs                                              | Returns                                                |
| ------------------------ | --------------------------------------------------- | ------------------------------------------------------ |
| `gadget.list-gadgets`   | `{ category?, limit?, cursor? }`                    | `{ items: GadgetListItem[], nextCursor }` — items are 6 fields: `{ id, category, title, description, tags, content }`. Full `content` body, no truncation. |
| `gadget.search-gadgets` | `{ query, category?, limit?, cursor? }`             | Same shape as `list-gadgets` items. BM25 over FTS5.    |
| `gadget.get-gadget`     | `{ id }`                                            | `{ gadget }` — full record including `aliases[]`, `source`, `createdAt`, `updatedAt`. |
| `gadget.list-revisions` | `{ id }`                                            | `{ revisions: Array<{ version, createdAt, title, description }> }` newest-first. |
| `gadget.compose-prompt` | `{ gadgetIds[], separator?, useCanonicalOrder? }`   | `{ prompt, chain[] }`. Unknown ids ⇒ `gadget.composeMissingIds` with `data.missing[]`. |
| `gadget.project-kickoff` | —                                                 | Interactive five-step MCP elicitation wizard (basics → type → runtime+quality → integrations → preview). Returns `{ prompt, chain, action, executedCommand? }`. Requires client elicitation support; honors `GADGET_KICKOFF_EXEC` for the `execute` path. See `docs/prompts.md`. |
| `gadget.export-gadgets` | `{ includeHistory?, category? }`                    | `{ ndjson, count }`.                                   |
| `gadget.list-runners`   | —                                                   | `{ runners[] }`.                                       |
| `gadget.list-client-roots` | —                                                 | `{ roots[], supported }` — asks the connected client for its MCP `roots/list`. |

`list-gadgets` and `search-gadgets` deliberately return the full `content`
body (not a truncated preview) so the LLM has complete reference exemplars
to calibrate against before composing or authoring. `source`,
`createdAt`, `updatedAt` are dropped from the list payload; fetch via
`get-gadget` when you need them.

## Writer tools

| Tool                      | Inputs                                                                      | Returns                                   |
| ------------------------- | --------------------------------------------------------------------------- | ----------------------------------------- |
| `gadget.add-gadget`      | `{ id, category, title, description, content, tags? }` — `title ≤ 80`, `description ≤ 200`, `content ≤ 500`, tags lowercase kebab-case. Shape guard rejects content with > 2 markdown headings or > 1 fenced code block. | `{ id, version }` — v1. Fails on id conflict, cap violation (`gadget.invalidGadget`), or shape violation (`gadget.invalidGadget` with `data.reason`). |
| `gadget.put-gadget`      | same as add                                                                 | `{ id, version, created }`. Always writes a new revision. `idempotentHint: true`. |
| `gadget.rename-gadget`   | `{ id, newId }`                                                             | `{ id, previousName, aliases[] }`. Non-destructive — old id preserved as alias. |
| `gadget.rollback-gadget` | `{ id, toVersion }`                                                         | `{ id, newVersion }`. Never a silent revert. |
| `gadget.import-gadgets`  | `{ ndjson, conflict: "skip" \| "overwrite" \| "error" }`                    | `{ imported, overwritten, skipped, errors[] }` |
| `gadget.run-reviewer`    | `{ runnerId, prompt, timeoutSeconds? }`                                     | `{ runnerId, status, exitCode, output, stderr, durationMs }` — `openWorldHint: true` (shells out). |

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
- **Field caps** — `title ≤ 80`, `description ≤ 200`, `content ≤ 500`.
  Constants exported from `@gadget/core` as `GADGET_TITLE_MAX`,
  `GADGET_DESCRIPTION_MAX`, `GADGET_CONTENT_MAX`. Violations reject at the
  Zod boundary as `gadget.invalidGadget`.
- **Shape guard** — content with > 2 markdown headings or > 1 fenced code
  block is rejected as `gadget.invalidGadget` with
  `data.reason ∈ { "too-many-headings", "too-many-code-fences" }`.
  Disable with `GADGET_DISABLE_SHAPE_CHECK=1` (see `docs/configuration.md`).
- **Cursors** are base64url-encoded JSON, tamper-detected via zod decode; the
  search cursor is bound to its originating query and surfaces
  `gadget.searchCursorQueryMismatch` when the query changes.
- **Aliases** — rename preserves the old id as an alias so consumers still
  resolve it via `gadget.get-gadget`.
- **Revisions** are append-only. Rollback creates a new revision whose
  content matches a prior one; the revision history is auditable from day 0.
- **Errors** surface through `McpError` with `data.gadgetCode` — see
  the table in the top-level `README.md`.

## Annotations

All tools declare the standard MCP tool hints. Clients should treat these
as reasoning aids, not authorization:

- `readOnlyHint: true` on list/search/get/compose/export; `false` on mutations.
- `idempotentHint: true` on `put-gadget`, `delete-gadget`, `delete-runner`,
  `upsert-runner`, and reads; `false` on `add-gadget`, `rename-gadget`,
  `rollback-gadget`, `import-gadgets`, `run-reviewer`.
- `destructiveHint: true` on `delete-gadget`, `delete-runner`; `false`
  (explicit) on reversible mutations.
- `openWorldHint: false` on every tool except `gadget.run-reviewer`, which
  shells out to an external reviewer process.
