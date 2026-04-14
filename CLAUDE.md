# CLAUDE.md — gadget-mcp operating rules

This file is loaded into every Claude Code conversation opened in this
repository. It is the short-form project charter for the model. The full
agent contract is in `SYSTEM_PROMPT.md`; this file is the 60-second version.

## What this project is

`gadget-mcp` is a single-binary [MCP][mcp] server written in Bun + TypeScript
that hosts a persistent library of reusable prompt **gadgets** across the
nine canonical prompt components (role, context, task, constraint, format,
example, reasoning, tone, caveat) plus **reviewer runners** for peer-review
workflows. Consumers list / get / add / rename / rollback / compose /
export / import gadgets via the MCP protocol over stdio or Streamable HTTP.

## Workspace layout

- `packages/core` — domain, `bun:sqlite` storage, services (audit, metrics,
  reviewer runners, NDJSON I/O, seeding). Exported under `@gadget/core`.
- `packages/server` — MCP surface (tools, resources, prompts), auth, dual
  stdio + Streamable HTTP transports on `Bun.serve`, and the CLI.
- `data/` — seed gadget catalog (`gadgets.ndjson`) and reviewer runners
  (`reviewer_runners.json`).
- `artifacts/` — runtime output (default DB path, backups).
- `tests/` — end-to-end spec that spawns the CLI over both transports.
- `bench/` — hot-path benchmarks with a baseline + regression gate.
- `docs/` — architecture, auth, transports, threat model, runbook,
  configuration, benchmarks, migrations, tool reference, prompts,
  release, live-tests.
- `.github/workflows/` — `ci.yml` (biome + tsc + tests + bench on push
  / PR), `release.yml` (on `v*` tags: build + SBOM + provenance
  attestation + ghcr.io container), `bench-seed.yml` (manual
  workflow_dispatch to re-baseline on GHA hardware).
- `SYSTEM_PROMPT.md` — the composed-via-Gadget system prompt that drives
  the autonomous build loop. Current chain is 29 gadgets covering all
  nine canonical slots; see the file's top-of-file table for ids.

## Hard rules

1. **Bun-native only.** `Bun.file`, `Bun.write`, `Bun.$`, `Bun.spawn`,
   `Bun.serve`, `bun:sqlite`, `bun:test`, `Bun.env`. No `express`, `pg`,
   `better-sqlite3`, `ws`, `dotenv`, `execa`, `node:fs` read/writeFile
   inside source. `node:fs/promises` is acceptable for path operations that
   Bun has no native replacement for (`mkdir`, `unlink`), and `node:os` /
   `node:path` / `node:crypto` are allowed.
2. **Strict TypeScript.** No `any`. Explicit return types on every
   exported function. `tsconfig.json` runs with `noUncheckedIndexedAccess`,
   `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`.
3. **Biome is the only lint + format tool.** `bunx biome check` clean before
   every commit. No ESLint, no Prettier. `// biome-ignore lint/<rule>:
   <reason>` is permitted only with a reason.
4. **Test discipline.** Every function-level source file ships with a
   sibling `*.test.ts` using `bun:test`. E2E tests live under `tests/`.
   Property-style invariants live in `packages/core/src/security.test.ts`.
   `bun test` is the runner; no jest, no vitest.
5. **Error registry.** MCP-surface errors funnel through
   `packages/server/src/mcp/errors.ts` — throw via `gadgetMcpError({ code,
   message, data })` with a `code` from `GADGET_ERROR_CODES`. New domain
   failures require a new entry in the registry **and** a row in the README
   error-codes table.
6. **Conventional commits per feature.** A feature is "done" only when
   `biome check`, `tsc --noEmit`, and `bun test` are all green. Then
   commit. Never `--amend` published history; never `--no-verify`.
7. **SQL discipline.** Every parameter uses `$name` bindings. No string
   interpolation of untrusted input. All writes run inside transactions
   when they touch more than one table or emit a revision.
8. **Observability is a first-class feature.** Every mutating tool
   records an audit row, bumps a metric (count + latency), emits an
   MCP `notifications/message`, and (if it changed resources) emits
   `notifications/resources/list_changed`. Bulk operations emit
   `notifications/progress` against the caller's `progressToken`.
   `/metrics` emits Prometheus text v0.0.4 with no client dependency.
   `/healthz` is liveness, `/readyz` probes the default workspace DB.

## The composed system prompt

`SYSTEM_PROMPT.md` is the live, in-tree copy of the system prompt that
drives this project's autonomous build loop. It was produced via the
Gadget MCP `compose-prompt` tool chaining these gadgets:

- `role-bun-runtime-engineer`
- `role-mcp-protocol-expert`
- `context-autonomous-mcp-build`
- `task-gadget-mcp-rewrite`
- `constraint-bun-native-apis`
- `constraint-solid-dry`
- `constraint-biome-lint-format`
- `constraint-commit-per-feature`
- `constraint-enterprise-grade-bar`
- `constraint-third-party-review-gate`
- `constraint-snippy-test-conventions`
- `constraint-snippy-error-registry`
- `format-bun-paste-ready`
- `tone-terse-engineering`

If you (a future Claude Code session) disagree with the prompt, update
`SYSTEM_PROMPT.md` and `CLAUDE.md` in the same commit — keep them
coherent.

## Quick commands

```sh
bun install
bun run dev             # --hot server on stdio + HTTP
bun run check           # biome check + tsc --noEmit + bun test
bun test tests          # end-to-end spec
bun run bench           # hot-path benches vs committed baseline
bun run forge.ts release # per-triple archives + SHA256SUMS.txt + SBOM
```

[mcp]: https://modelcontextprotocol.io/
