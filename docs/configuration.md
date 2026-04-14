# Configuration

Every runtime knob is an environment variable. There is no config file.

## Environment variables

| Variable                        | Default                   | Purpose                                                                     |
| ------------------------------- | ------------------------- | --------------------------------------------------------------------------- |
| `GADGET_DB`                    | `./artifacts/gadget.db`  | Default SQLite path when `GADGET_WORKSPACES` is absent.                    |
| `GADGET_WORKSPACES`            | — (single `default`)      | JSON `{name: dbPath}` for multi-workspace isolation.                        |
| `GADGET_HTTP_HOST`             | `127.0.0.1`               | HTTP bind host.                                                             |
| `GADGET_HTTP_PORT`             | `7878`                    | HTTP bind port.                                                             |
| `GADGET_HTTP_TOKENS`           | —                         | CSV of `token:role` pairs (`reader|writer|admin`). Empty ⇒ trusted + admin. |
| `GADGET_ORIGIN_ALLOWLIST`      | —                         | CSV of allowed `Origin` header values (strict equality).                    |
| `GADGET_HTTP_ALLOWED_HOSTS`    | —                         | CSV of allowed `Host` header values (DNS-rebind mitigation).                |
| `GADGET_HTTP_MAX_BODY_BYTES`   | `10485760` (10 MB)        | Cap on `Content-Length` for `/mcp` POSTs.                                   |
| `GADGET_SEED`                  | `auto`                    | `auto` seeds from `data/` at startup (falls back to seeds embedded in the binary when files are absent); `off` skips. |
| `GADGET_PACKS`                 | —                         | CSV of optional NDJSON packs embedded in the binary to seed alongside the default catalog. Available: `tone-caveman`. Unknown names warn on stderr without failing startup. |
| `GADGET_DISABLE_SHAPE_CHECK`   | —                         | Set to `1|true|yes|on` to disable the add/put shape validator (rejects >2 markdown headings or >1 fenced code block). |
| `GADGET_KICKOFF_EXEC`          | —                         | Executable invoked by `gadget.project-kickoff` when the user picks `execute` on the preview step (e.g. `claude`, `opencode`). Runs in the target project path with the composed prompt on stdin. Empty ⇒ the `execute` path degrades to `return`. |
| `GADGET_AUDIT_DAYS`            | `90`                      | Audit-log retention in days; pruned on startup.                             |

## CLI flags

```sh
gadget-mcp [serve] [--stdio | --http] [--workspace=NAME] [--host=HOST] [--port=N]
gadget-mcp backup  --out PATH [--workspace=NAME]
gadget-mcp restore --in PATH  [--workspace=NAME]
gadget-mcp audit tail [N]
gadget-mcp generate <claude-desktop|cursor|vscode|mcp-json|shell-env>
                     [--stdio|--http] [--url URL] [--token T]
                     [--workspace NAME] [--out PATH]
gadget-mcp --version
gadget-mcp --help
```

Flags override environment variables. Absent `--stdio` or `--http`, `serve`
defaults to Streamable HTTP.

## Workspaces

A single-workspace install needs nothing. For multiple isolated libraries:

```sh
export GADGET_WORKSPACES='{"team-a":"/var/lib/gadget/a.db","team-b":"/var/lib/gadget/b.db"}'
```

Names must match `^[a-z0-9][a-z0-9._-]{0,63}$`. HTTP clients pick one with
`?workspace=team-a`. Each workspace has its own DB, repo, audit writer, and
metrics registry — no shared state.

## Seeding

At startup the server seeds from:

- `data/gadgets.ndjson` — curated gadget catalog (22 rpp-ts-style domain
  gadgets: 5 role / 5 context / 5 constraint / 4 format / 3 tone).
- `data/reviewer_runners.json` — reviewer runner definitions (4 entries).

Both files are **embedded into the compiled binary** via Bun text-imports,
so a zero-config invocation (fresh `gadget.db`, no `data/` directory on
disk) still produces a fully seeded library. When run from a source
checkout the on-disk files win, which keeps the dev loop ergonomic.

Seeding is additive: an id that already exists is left alone, so
restarting never stomps a gadget you've edited via `put-gadget`.

Set `GADGET_SEED=off` to skip seeding entirely (useful in tests).

## Optional packs (`GADGET_PACKS`)

Packs are opt-in bundles of curated gadgets also embedded in the binary.
Enable one or more by name via the env var:

```sh
GADGET_PACKS=tone-caveman gadget-mcp serve --stdio
```

Packs seed *after* the default catalog and are additive — enabling a
pack on an existing DB just adds the new ids on the next startup.

| Pack          | Contents                                                     |
| ------------- | ------------------------------------------------------------ |
| `tone-caveman` | Three `tone-caveman-{lite,full,ultra}` gadgets capturing compression intensity levels (filler drop → article drop → telegraphic). Compose these with any role to tune output density. |

Adding another pack is a two-step code change: drop `data/<name>.ndjson`
and register it in the `GADGET_PACKS` object in `packages/server/src/cli.ts`.

## Shape validation (`GADGET_DISABLE_SHAPE_CHECK`)

Add/put reject gadget bodies with more than two markdown headings or
more than one fenced code block — a heuristic against kitchen-sink
gadgets that pack multiple ideas into one blob. Violations surface as
`gadget.invalidGadget` with a `reason` data field (`too-many-headings`
or `too-many-code-fences`). Set `GADGET_DISABLE_SHAPE_CHECK=1` to turn
the check off when you need a dense snippet to land.

## Paths inside the Docker image

- Binary: `/usr/local/bin/gadget-mcp`
- Seed data: `/app/data/`
- Persistent DB volume: `/data/` (mount as `-v gadget:/data`)
