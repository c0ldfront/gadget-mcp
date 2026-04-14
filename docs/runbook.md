# Runbook

## Common operations

### Rotate an HTTP bearer token

```sh
# 1. Append the new token alongside the old.
export GADGET_HTTP_TOKENS='old:writer,new:writer,ops:admin'
systemctl restart gadget-mcp   # or `docker compose up -d`

# 2. Roll clients from `old` to `new`.

# 3. Drop the old token, restart once more.
export GADGET_HTTP_TOKENS='new:writer,ops:admin'
systemctl restart gadget-mcp
```

### Take a live backup

```sh
gadget-mcp backup --out /backups/gadget-$(date -I).db
```

Uses `VACUUM INTO` against the running database. Safe while the server is
serving traffic; no downtime.

### Restore from a backup

```sh
systemctl stop gadget-mcp
gadget-mcp restore --in /backups/gadget-2026-04-13.db
systemctl start gadget-mcp
```

`restore` closes all DB connections, unlinks the WAL / SHM journal files,
and copies the backup over the target path.

### Tail the audit log

```sh
gadget-mcp audit tail 200
```

Prints `ISO timestamp | workspace | actor | tool | resultCode | gadgetId`.
Filter in shell with `grep`.

### Scale audit retention

```sh
export GADGET_AUDIT_DAYS=30
systemctl restart gadget-mcp
```

Pruning runs on startup and only removes rows older than the retention
window. Missing / invalid values fall back to 90 days.

### Check readiness and metrics

```sh
curl -fsS http://localhost:7878/healthz
curl -fsS http://localhost:7878/readyz
curl -fsS http://localhost:7878/metrics | head -30
```

## Diagnostics

| Symptom                                           | Check                                                                                          |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `/readyz` returns 503                             | DB missing / unwritable / corrupt. `journalctl -u gadget-mcp` and `gadget-mcp --version`.    |
| Tool missing from `tools/list`                    | Session role lacks permission; check `GADGET_HTTP_TOKENS` and `docs/auth.md`.                 |
| `gadget.searchCursorQueryMismatch`               | Query changed between pages — restart pagination with the new query.                           |
| `gadget.runnerMissing`                           | `Bun.which()` could not find the runner executable; check PATH or `enabled = false`.           |
| Slow search (`search-gadgets`)                    | `bun run bench` to baseline; large corpora may need `.p95` tuning. See `docs/benchmarks.md`.   |
| Docker container exits immediately                | `docker logs` — the distroless image writes startup diagnostics to stderr.                     |

## Upgrade checklist

1. Review `CHANGELOG.md` for breaking changes.
2. Take a backup: `gadget-mcp backup --out /backups/pre-upgrade.db`.
3. Replace the binary / image tag.
4. Start the service. Schema migrations run automatically; if they fail the
   process exits non-zero before accepting traffic.
5. Verify `/readyz` returns 200 and the audit log records a new `gadget-mcp`
   startup entry.
