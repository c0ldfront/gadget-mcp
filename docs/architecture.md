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
  │                 list-runners,upsert-runner,delete-runner,run-reviewer,
  │                 list-client-roots}  — every tool declares outputSchema
  │                 + per-field .describe() + annotations
  │                 (readOnly|destructive|idempotent|openWorld hints)
  ├── resources.ts  gadget://gadgets/all | ://categories |
  │                 ://compose/canonical | ://gadget/{id} |
  │                 ://gadgets/category/{category} | ://gadgets/tag/{tag}
  ├── prompts.ts    gadget-author, gadget-build-chain,
  │                 gadget-build-system-prompt, gadget-align-repo,
  │                 gadget-inspect, gadget-run-reviewer
  └── gadget-shape  kitchen-sink heuristic reject (>2 headings, >1 fence);
                    disable with GADGET_DISABLE_SHAPE_CHECK
Core (@gadget/core)
  ├── domain/       Gadget, Revision, ids, categories, errors;
  │                 caps: GADGET_{TITLE,DESCRIPTION,CONTENT}_MAX
  │                 toSummary / toListItem (6-field list payload)
  ├── repo/         GadgetRepo  |  keyset cursors
  └── services/     AuditWriter, MetricsRegistry, ReviewerRunnerRepo,
                    executeReviewerRun, exportNdjson/importNdjson,
                    seedFromFiles / seedFromContent / seedGadgetsFromNdjson,
                    GadgetMetrics.recordGadgetContentChars()
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

## Seeding strategy

`maybeSeed` runs once per workspace on startup and is additive (existing
ids are preserved):

1. Try on-disk seed files at `data/gadgets.ndjson` and
   `data/reviewer_runners.json` (preserves the dev-loop ergonomics).
2. If neither produced a row, fall back to the **seed payload embedded
   in the compiled binary** via Bun text-imports
   (`import data from "…" with { type: "text" }`). This closes the gap
   introduced by `bun build --compile`, where `import.meta.url` resolves
   into the bundled virtual filesystem and the path-based lookup
   silently misses.
3. Load any opt-in packs listed in `GADGET_PACKS` (comma-separated names
   registered in the `GADGET_PACKS` map in `packages/server/src/cli.ts`).
   Each pack is its own embedded NDJSON.

`GADGET_SEED=off` short-circuits the whole sequence. See
[`docs/configuration.md`](./configuration.md) for the user-facing knobs.

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
