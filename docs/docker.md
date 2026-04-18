# Docker

The repo ships a two-stage [Dockerfile](../Dockerfile) that produces a
distroless, nonroot image wrapping the compiled single-binary CLI. The image
is what the `release.yml` workflow publishes to
`ghcr.io/c0ldfront/gadget-mcp:<tag>` on every `v*` tag push.

| Layer   | Base                                      | Purpose                                                        |
| ------- | ----------------------------------------- | -------------------------------------------------------------- |
| builder | `oven/bun:1`                              | `bun install --frozen-lockfile` then `bun build --compile`.    |
| runtime | `gcr.io/distroless/base-debian12:nonroot` | Ships only the compiled `gadget-mcp` binary + `data/` seeds.   |

The `bun build --compile` step targets `bun-linux-x64` (glibc). The runtime
base is glibc as well — do not flip to `-musl` unless you also swap the
runtime base, otherwise `exec` fails with `no such file or directory`.

## Build + run locally

```sh
docker build -t gadget-mcp:dev .
docker run --rm -d \
  --name gadget-mcp \
  -p 7878:7878 \
  -v gadget-data:/data \
  gadget-mcp:dev

# liveness / readiness / metrics
curl -fsS localhost:7878/healthz     # -> ok
curl -fsS localhost:7878/readyz      # -> ready
curl -fsS localhost:7878/metrics     # -> Prometheus text v0.0.4
```

The container entrypoint is `gadget-mcp --http`. The image hard-codes:

| Env                  | Default           | Notes                                                  |
| -------------------- | ----------------- | ------------------------------------------------------ |
| `GADGET_HTTP_HOST`   | `0.0.0.0`         | Bind inside the container; publish with `-p`.          |
| `GADGET_HTTP_PORT`   | `7878`            | Must match the `-p` publish port.                      |
| `GADGET_DB`          | `/data/gadget.db` | Mount `/data` as a volume to persist gadgets.          |

Everything else from [configuration.md](./configuration.md) still applies —
pass `-e GADGET_AUTH_TOKENS=...`, `-e GADGET_ORIGIN_ALLOWLIST=...`, etc.

## Auth

With no `GADGET_AUTH_TOKENS` set, HTTP callers resolve to the `admin` role.
That is fine for a laptop smoke test but unacceptable for anything exposed
beyond loopback. Before publishing the port, set tokens:

```sh
docker run --rm -d \
  -p 7878:7878 \
  -v gadget-data:/data \
  -e GADGET_AUTH_TOKENS='admin:$ADMIN_TOKEN,reader:$READ_TOKEN' \
  ghcr.io/c0ldfront/gadget-mcp:v0.3.0
```

See [auth.md](./auth.md) for the full token-role grammar.

## `.mcp.json` client wiring

Claude Code, Cursor, and other MCP-capable clients read an `.mcp.json` (or
`mcp.json` / `claude_desktop_config.json`) to discover servers. Two supported
shapes:

### Stdio (run the container per-session)

Each client session spawns a throwaway container on stdio. Simple, no port
management, but one DB per session unless you share a named volume.

```json
{
  "mcpServers": {
    "gadget": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "-v", "gadget-data:/data",
        "ghcr.io/c0ldfront/gadget-mcp:v0.3.0",
        "--stdio"
      ]
    }
  }
}
```

> The image `CMD` is `--http` — passing `--stdio` overrides it so the
> container speaks MCP over stdio to the parent client.

### Streamable HTTP (long-running container)

Start the container once, point every client at its URL. Best for shared
workstations or remote deployments.

```json
{
  "mcpServers": {
    "gadget": {
      "type": "http",
      "url": "http://localhost:7878/mcp",
      "headers": {
        "Authorization": "Bearer ${GADGET_TOKEN}"
      }
    }
  }
}
```

Drop the `headers` block if you run without `GADGET_AUTH_TOKENS`. For any
non-loopback deployment, terminate TLS in front of the container and keep
the token in an environment variable on the client side — never inline it.

## Compose

A ready-to-use [compose.yaml](../compose.yaml) lives at the repo root:

```sh
# edit compose.yaml if you want to set GADGET_AUTH_TOKENS, then:
docker compose up -d
docker compose logs -f
docker compose down        # stop; keep the gadget-mcp-data volume
docker compose down -v     # stop and wipe the DB volume too
```

By default it binds to `127.0.0.1:7878` (loopback only) and pulls
`ghcr.io/c0ldfront/gadget-mcp:latest`. Uncomment `build: .` to iterate on
the Dockerfile locally without pushing a tag.

The image already ships a `HEALTHCHECK` that runs `gadget-mcp healthcheck`
against the in-container `/healthz`, so compose, swarm, and ECS pick it up
automatically. Override it at the orchestrator level only if you need a
different interval. Distroless has no `curl`, so the binary probes itself.

## The `healthcheck` subcommand

```sh
gadget-mcp healthcheck [--host=HOST] [--port=N]
```

Exits `0` when `GET http://<host>:<port>/healthz` returns 200, `1`
otherwise. Defaults to `GADGET_HTTP_HOST` / `GADGET_HTTP_PORT` from the
environment, rewriting `0.0.0.0` / `::` to `127.0.0.1` so the probe hits
the loopback inside the container. Useful outside Docker too — point it at
a remote deployment to script a smoke test.

## Regression tests

`tests/e2e-docker.test.ts` builds the image, runs it, and asserts that
`/healthz`, `/readyz`, `/metrics`, and MCP `initialize` all succeed against
the compiled binary inside the distroless runtime. The suite is gated on
`GADGET_DOCKER_TESTS=1` so `bun test` stays fast by default; CI sets the
flag. See [live-tests.md](./live-tests.md) for the same gating pattern
applied to LLM-discovery smoke tests.

Run locally:

```sh
GADGET_DOCKER_TESTS=1 bun test tests/e2e-docker.test.ts
```
