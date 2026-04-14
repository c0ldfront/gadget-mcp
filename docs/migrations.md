# Migrations

Schema changes ship as append-only, versioned migrations in
`packages/core/src/db/migrations.ts`. The server applies pending migrations
at startup inside a transaction keyed by `schema_migrations.version`.

## Current schema

- `gadgets (id, category, title, description, content, tags_json, source, created_at, updated_at)`
- `gadget_revisions (id, gadget_id, version, title, description, content, tags_json, created_at)`
- `aliases (alias, gadget_id, created_at)`
- `audit_log (id, ts, actor, tool, args_json, result_code, gadget_id, correlation_id)`
- `reviewer_runners (id, name, command_json, enabled, timeout_seconds, created_at, updated_at)`
- `gadgets_fts` — FTS5 virtual table mirroring `gadgets` via insert / delete / update triggers.

Foreign keys from `gadget_revisions.gadget_id` and `aliases.gadget_id` to
`gadgets.id` declare `ON DELETE CASCADE` and `ON UPDATE CASCADE`, which is
what makes `rename-gadget` work without orphaning rows.

## Adding a migration

1. Append a new SQL string to the `MIGRATIONS` array in `migrations.ts`.
2. Write a colocated test that exercises the new table / column / trigger.
3. If the change is user-visible, add a row to `CHANGELOG.md` under the
   appropriate version.
4. Do **not** edit an earlier migration in place — it has already been
   applied on deployed DBs. Add a new one that corrects it.

## Rollback policy

Migrations are forward-only. If a release has to roll back, restore from a
backup taken before the upgrade — see `docs/runbook.md`.
