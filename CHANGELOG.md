# Changelog

All notable changes to `gadget-mcp` are documented here. Format adheres to
[Keep a Changelog][kac] and versions follow [semver][semver].

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
