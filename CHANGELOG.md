# Changelog

All notable changes to `gadget-mcp` are documented here. Format adheres to
[Keep a Changelog][kac] and versions follow [semver][semver].

## [Unreleased]

### Changed

- **`gadget.project-kickoff` now emits a full actionable baseline prompt
  regardless of library state.** The tool previously relied entirely on
  tag/keyword matches in the gadget library; when nothing matched (the
  common case for domains the seed library doesn't cover — e.g. a Bun
  OpenAI-compat proxy), it emitted only a header plus a
  "no matching gadgets" placeholder. Now the tool has built-in
  per-answer directive blocks for runtime (`bun | node | deno | python
  | rust | go`), quality bar (`enterprise | prototype`), project type
  (`cli | web-service | mcp-server | library | proxy | daemon |
  desktop-app`), and common integrations (`mcp`, `sqlite`, `openai`,
  `openai-compat`, `sse`, `github`, `prometheus`). Library-matched
  gadgets stack on top as additional flavor. Result: kickoff output is
  ~2 KB of concrete guidance even with a barebones library.
- **`gadget.project-kickoff` elicitation timeout raised to 10 minutes
  per step** (from the SDK default of 60 seconds) so the multi-step
  wizard doesn't time out while the user is still filling the form.
  Configurable via `GADGET_KICKOFF_TIMEOUT_MS`.

### Added

- **`gadget.project-kickoff` tool + `gadget-project-kickoff` slash
  prompt.** Interactive project-bootstrap wizard that uses the MCP
  `elicitation/create` primitive to walk the user through five steps
  (basics → project type → runtime + quality bar → integrations →
  preview), composes a paste-ready kickoff paragraph from the gadget
  library, and optionally spawns a configurable executor
  (`GADGET_KICKOFF_EXEC` env var) in the target path with the composed
  prompt on stdin. Selection heuristic is pure (tag/keyword scoring over
  the repo) so runs are deterministic and testable. Graceful fallback
  on clients that don't support elicitation — returns an
  `gadget.invalidGadget` with a suggestion to use
  `gadget-build-system-prompt` instead. Role: `reader`.

## [0.2.0] — 2026-04-14

### Added

- **Hard field caps on gadgets.** Constants `GADGET_TITLE_MAX=80`,
  `GADGET_DESCRIPTION_MAX=200`, `GADGET_CONTENT_MAX=500` are exported from
  `@gadget/core` and enforced at the Zod parse boundary for both `add-gadget`
  and `put-gadget`. Over-cap writes reject with `gadget.invalidGadget`.
- **Shape check for kitchen-sink gadgets.** Rejects bodies with more than
  two markdown headings or more than one fenced code block. Opt out with
  `GADGET_DISABLE_SHAPE_CHECK=1|true|yes|on`.
- **Authoring rules in `add-gadget` / `put-gadget` tool descriptions.**
  Targets ~150 chars, inline exemplars from the curated library, split-past-250
  guidance — surfaced to the LLM at `tools/list` time.
- **`gadget-author` prompt.** Pulls three live curated exemplars from the
  repo at render time; takes optional `intent` and `category` args; teaches
  the single-purpose/single-idea rule before authoring.
- **Content-size observability.** New Prometheus histogram
  `gadget_content_chars{tool="..."}` with buckets `50..8000`, recorded on
  every mutating write. `notifications/message` payloads for mutations now
  include a `contentChars` field. New method
  `GadgetMetrics.recordGadgetContentChars(tool, chars)`.
- **`gadget.list-gadgets` and `gadget.search-gadgets` return slim items.**
  Six fields `{id, category, title, description, tags, content}` — full
  `content` body (no preview truncation), and `source`/`createdAt`/`updatedAt`
  dropped from the list payload for token efficiency. Same trim applied to
  `gadget://gadgets/all`, `gadget://gadgets/category/{category}`, and
  `gadget://gadgets/tag/{tag}` resources. New type `GadgetListItem` and
  `toListItem` helper exported from `@gadget/core`.
- **Full MCP SDK compliance on every tool.** All 17 tools now declare an
  `outputSchema`, every input field carries `.describe()` per-arg help, and
  annotations are standardized: `openWorldHint: false` on local tools
  (`true` on `gadget.run-reviewer`), explicit `destructiveHint: false` on
  reversible mutations, `idempotentHint: true` on `put-gadget` and
  `delete-*`. Tags input now uses `GadgetTagSchema` so clients see the
  kebab-case constraint.
- **Extensible gadget packs.** New `GADGET_PACKS` env var enables opt-in
  NDJSON bundles embedded in the binary (comma-separated names). First
  pack: `tone-caveman` at `data/tone-caveman.ndjson` with three tone
  gadgets (lite / full / ultra) capturing the intensity levels from
  [JuliusBrussee/caveman][caveman]. Unknown pack names warn on stderr
  without failing startup. Pack registry + parser in
  `packages/server/src/cli.ts`.

### Changed

- **Default seed library swapped to the rpp-ts domain set.**
  `data/gadgets.ndjson` is now 22 curated gadgets (5 role / 5 context /
  5 constraint / 4 format / 3 tone) sized 98–251 chars — the house-style
  anchors the authoring rules point the LLM at. Prior 20 meta-gadgets
  preserved at `data/gadgets.ndjson.bak` for reference / re-import.
- **Default seeds are now embedded in the compiled binary.** In a
  `bun build --compile` binary, `import.meta.url` points into the bundled
  virtual filesystem, so the previous path-based seeding silently no-op'd
  whenever the binary was invoked from a CWD without `data/`. `maybeSeed`
  now tries on-disk first (preserves dev workflow) and falls back to the
  embedded payload. Binary is now zero-config: fresh DB anywhere auto-seeds
  the 22 curated gadgets + 4 reviewer runners.
- **Seed API refactor.** New public exports from `@gadget/core`:
  `seedFromContent`, `seedGadgetsFromNdjson`, `seedRunnersFromJson`, and
  type `SeedContent`. `seedFromFiles` retained and delegates to
  `seedFromContent` for disk loads.

### Known limitations

- Claude Code v2.1.107 does NOT surface MCP prompt-argument autocomplete
  in its slash-command UI. The server correctly advertises
  `completions: {}` and responds to `completion/complete` for prompt args
  (verified against the SDK client — see `packages/server/src/mcp/server.test.ts`),
  but the Claude Code UI renders completions only for resource-template args.
  Prompt-arg completion works in clients that wire it.

[caveman]: https://github.com/JuliusBrussee/caveman

## [0.1.0] — 2026-04-14

Initial release. Complete rewrite of the legacy `rpp-ts` project into a
Bun/TypeScript MCP server managing a persistent library of reusable prompt
**gadgets** across the nine standard prompt components plus **reviewer
runners**, with a first-class `compose-prompt` tool for building finished
prompts.

### Added

- Bun workspace layout: `packages/core` (domain + storage) and
  `packages/server` (MCP surface + transports + CLI), with `data/` seeds and
  `artifacts/` runtime output.
- `@modelcontextprotocol/sdk@^1.29.0` server with zod-backed tool input and
  output schemas, URI-templated resources with completion, prompts,
  `AbortSignal` cancellation, and `notifications/message` / `notifications/progress`.
- Dual stdio and Streamable HTTP transports on `Bun.serve` with `/healthz`,
  `/readyz`, `/metrics`, and `/mcp` routes, per-session `McpServer`
  instances, bearer-token RBAC (`reader | writer | admin`), origin
  allowlist, host allowlist, request-body size limit, and structured JSON
  logging.
- Multi-workspace isolation via `GADGET_WORKSPACES` JSON.
- `bun:sqlite` storage with WAL + `foreign_keys=ON`, hand-rolled migrations,
  FTS5 virtual table with insert/delete/update triggers.
- Gadget domain: 9-category schema, kebab-case ID validation, immutable
  revisions, rename-with-alias so consumers never break, rollback that
  writes a new revision.
- `GADGET_ERROR_CODES` registry (17 codes) surfaced through `McpError.data`
  via `gadgetMcpError()`.
- Keyset pagination cursors (base64url JSON) bound to their originating
  query with tamper detection.
- `compose-prompt` tool with optional canonical-order reordering.
- NDJSON export / import with `skip | overwrite | error` conflict policy.
- Reviewer runners: TOML-seeded catalog, per-workspace overrides,
  `executeReviewerRun` via `Bun.spawn` with `{input_file}` / `{output_file}`
  placeholders and timeout / missing status detection.
- Best-effort append-only audit log with retention pruning.
- Hand-rolled Prometheus text v0.0.4 metrics (counters, histograms, gauges).
- CLI: `serve`, `backup --out`, `restore --in`, `audit tail N`,
  `generate <format>` emitting claude-desktop, cursor, vscode, mcp-json, and
  shell-env configs.
- Multi-stage Dockerfile producing a static `bun build --compile` binary
  atop `gcr.io/distroless/base-debian12:nonroot`.
- `forge.ts` release pipeline emitting per-triple archives,
  `SHA256SUMS.txt`, and a CycloneDX 1.5 SBOM.
- GitHub Actions `ci.yml` (biome + tsc + unit + e2e + smoke build on Bun
  latest and canary; bench regression gate) and `release.yml` (forge release
  on `v*` tags with SBOM + archives attached to the GitHub release).
- Property-based security tests covering ID pattern invariants, cursor
  tamper-resistance, role hierarchy monotonicity, origin allowlist strict
  matching, and bearer-token parser hardening.
- Benchmark suite (`bun run bench`) with four hot-path benches
  (`put@1k`, `list@10k_first_page`, `search@10k_needle`, `metrics_render`)
  and a p50 ≥ 1.2× / p95 ≥ 1.5× regression gate against a committed
  baseline.

[kac]: https://keepachangelog.com/en/1.1.0/
[semver]: https://semver.org/
