# Threat model

## Trust boundaries

| Surface          | Trust                                                   |
| ---------------- | ------------------------------------------------------- |
| Stdio transport  | **Trusted.** Parent process owns the pipe.              |
| HTTP transport   | **Untrusted.** Bearer token + origin + host + size caps.|
| SQLite file      | **Trusted.** Private filesystem assumed.                |
| Reviewer runners | **Semi-trusted.** `Bun.spawn` subprocess with timeout.  |
| Seed data files  | **Trusted at deploy time.** Shipped inside the image.   |

## Threats and mitigations

| Threat                                        | Mitigation                                                                                   |
| --------------------------------------------- | -------------------------------------------------------------------------------------------- |
| SQL injection                                 | All queries use named-parameter bindings (`$name`); no user input is interpolated into SQL.  |
| FTS5 injection                                | `query` is bound as a parameter; trimmed; empty string short-circuits to empty page.         |
| Path traversal in backup / restore            | Paths are resolved and normalized before use; `VACUUM INTO` accepts a bound string argument. |
| Cursor replay / tampering                     | Cursor JSON is validated by zod on decode; search cursor binds the originating query.        |
| Cross-tenant leakage                          | Workspace registry gives each tenant its own DB, repo, audit, metrics — no shared state.     |
| Bearer-token leak in logs                     | Audit log records `actor = "http:<role>"`, never the token itself.                           |
| Privilege escalation                          | Disallowed tools are not registered on the session `McpServer`; `tools/list` reflects role.  |
| Origin spoofing                               | Strict string-equality allowlist; substring / scheme coercion does not bypass.               |
| DNS rebinding                                 | Optional `GADGET_HTTP_ALLOWED_HOSTS` set gates the `Host` header.                           |
| Request-body DoS                              | `Content-Length` capped by `GADGET_HTTP_MAX_BODY_BYTES` (default 10 MB) → 413.              |
| Reviewer-runner hangs                         | `Bun.spawn` with explicit timeout; `SIGKILL` on expiry; status surfaced as `timeout`.        |
| Reviewer-runner absent                        | `Bun.which()` gate before spawn; absence ⇒ status `missing`, not a crash.                    |
| Audit log DoS                                 | `GADGET_AUDIT_DAYS` pruning on startup; inserts are best-effort and never block primary ops. |
| Alias takeover on rename                      | `rename-gadget` checks both live ids and aliases before committing; collision ⇒ `aliasConflict`. |
| Category enum drift                           | `GadgetCategorySchema` is a closed zod enum; invalid values never reach the DB layer.        |

## Out of scope

- SQLite at-rest encryption (use filesystem ACLs or encrypted volume).
- mTLS on `/mcp` (terminate TLS at a reverse proxy).
- Per-tool rate limiting (run behind a gateway if needed).
- Token rotation via API (rotate via env + restart; see `docs/auth.md`).
