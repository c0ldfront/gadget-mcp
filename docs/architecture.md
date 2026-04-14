# Architecture

`gadget-mcp` is a single-binary [MCP][mcp] server built on Bun + bun:sqlite
that manages a persistent library of reusable prompt **gadgets** across the
nine standard prompt components (role, context, task, constraint, format,
example, reasoning, tone, caveat) plus **reviewer runners** for peer-review
workflows.

## Layers

```
Transport           stdio  |  Streamable HTTP on Bun.serve
  ├── sessions:     per-session McpServer bound to role + workspace
  └── probes:       /healthz  /readyz  /metrics
MCP surface         @modelcontextprotocol/sdk
  ├── tools.ts      gadget.{list,search,get,add,put,rename,rollback,
  │                 delete,list-revisions,compose-prompt,import,export,
  │                 list-runners,upsert-runner,delete-runner,run-reviewer}
  ├── resources.ts  gadget://gadgets/all | ://categories |
  │                 ://compose/canonical | ://gadget/{id} |
  │                 ://gadgets/category/{category}
  └── prompts.ts    gadget-build-chain(task)
Core (@gadget/core)
  ├── domain/       Gadget, Revision, ids, categories, errors
  ├── repo/         GadgetRepo  |  keyset cursors
  └── services/     AuditWriter, MetricsRegistry, ReviewerRunnerRepo,
                    executeReviewerRun, exportNdjson/importNdjson, seed
Storage             bun:sqlite (WAL + FK=ON)
  └── tables:       gadgets, gadget_revisions, aliases, audit_log,
                    reviewer_runners, gadgets_fts (virtual)
```

## Composition root

```ts
const ws = registry.get(workspaceName);       // lazy per-workspace state
const server = buildServer({
  repo: ws.repo,
  runnerRepo: ws.runnerRepo,
  role,                                        // reader | writer | admin
  actor: `http:${role}` | `stdio:${workspace}`,
  audit: ws.audit,
  metrics: ws.metrics,
  workspace: ws.name,
  db: ws.db,
});
```

`buildServer` registers tools, resources, and prompts, gating tool
registration by the resolved role. Unauthorized tools are never advertised —
`tools/list` reflects the caller's surface.

## Storage invariants

- `gadgets.id` is the primary key; `aliases(alias)` maps old ids to live ids.
  Rename updates `gadgets.id` and — because revisions and aliases declare
  `ON UPDATE CASCADE` — their rows follow automatically; the old id is then
  inserted into `aliases`.
- `gadget_revisions` is append-only. Rollback does not mutate revisions — it
  writes a new revision whose content matches a prior one.
- `gadgets_fts` (contentless FTS5 with porter + unicode61) is kept consistent
  by insert/delete/update triggers; rebuild in-place is never required.
- All SQL is parameterized via `$name` bindings; no string interpolation of
  untrusted input.

## Why hand-rolled SQL, no ORM

- Schema is small (6 tables) and stable.
- Need full control over FTS5 triggers, keyset cursor shape, and BM25
  ordering.
- `bun:sqlite` is synchronous and predictable; transactions are a literal
  `db.transaction(fn)()`. No driver layer to babysit.

[mcp]: https://modelcontextprotocol.io/
