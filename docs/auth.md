# Auth

## Stdio

Stdio is trusted: the parent process owns the pipe, so the session runs as
`role = admin` with `actor = "stdio:<workspace>"`. There is no bearer token,
no origin check, and no rate limit on stdio — if you can open the stdio
pipe, you can call every tool.

## HTTP

The HTTP surface is untrusted. Every `/mcp` request must carry a bearer
token that resolves to one of three roles.

### Roles

| Role   | Sees                                                          |
| ------ | ------------------------------------------------------------- |
| reader | `list-gadgets`, `search-gadgets`, `get-gadget`, `list-revisions`, `compose-prompt`, `export-gadgets`, `list-runners` |
| writer | all reader tools **plus** `add-gadget`, `put-gadget`, `rename-gadget`, `rollback-gadget`, `import-gadgets`, `run-reviewer` |
| admin  | all writer tools **plus** `delete-gadget`, `upsert-runner`, `delete-runner` |

`tools/list` is role-scoped: disallowed tools are never registered on the
session `McpServer`, so a reader client cannot see mutating tools at all.
Calls to unknown tools surface as `McpError` with `ErrorCode.MethodNotFound`.

### Wire format

Tokens are provided through `GADGET_HTTP_TOKENS` as a comma-separated list
of `token:role` pairs:

```sh
GADGET_HTTP_TOKENS='ops-team:admin,app-a:writer,dashboards:reader'
```

Clients send `Authorization: Bearer <token>` on every HTTP request. The
check is strict string equality after the `Bearer` prefix; whitespace,
casing, or extra characters disqualify the token.

A missing or unknown token returns:

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer realm="gadget-mcp"
Content-Type: application/json
X-Request-Id: <uuid>

{"error":"missing or invalid bearer token"}
```

### Rotating a token

1. Append the new token alongside the old — both valid simultaneously:
   ```
   GADGET_HTTP_TOKENS='old:writer,new:writer,ops:admin'
   ```
2. `systemctl restart gadget-mcp` (or re-`docker run`).
3. Roll clients from `old` to `new`.
4. Drop `old` from the env, restart again.

### Origin allowlist

`GADGET_ORIGIN_ALLOWLIST` is a strict-equality set of allowed `Origin`
header values. Empty or unset ⇒ no check (local development). Missing
Origin with an allowlist set ⇒ 403.

### Host allowlist

`GADGET_HTTP_ALLOWED_HOSTS` (CSV) mitigates DNS rebinding: the `Host`
request header must appear in the set. Port suffixes are accepted on either
side.

### Request body limit

Requests whose `Content-Length` exceeds `GADGET_HTTP_MAX_BODY_BYTES`
(default 10 MB) are rejected with `413 Payload Too Large`.
