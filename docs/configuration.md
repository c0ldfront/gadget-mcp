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
| `GADGET_SEED`                  | `auto`                    | `auto` seeds from `data/` at startup; `off` skips.                          |
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

- `data/gadgets.ndjson` — curated gadget catalog (20 entries by default).
- `data/reviewer_runners.json` — reviewer runner definitions.

Set `GADGET_SEED=off` to skip this (useful in tests).

## Paths inside the Docker image

- Binary: `/usr/local/bin/gadget-mcp`
- Seed data: `/app/data/`
- Persistent DB volume: `/data/` (mount as `-v gadget:/data`)
