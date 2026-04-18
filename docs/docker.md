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

## Volumes and bind-mount ownership

The image runs as the distroless `nonroot` user (uid:gid **65532:65532**)
and pre-chowns `/data` to that user in the builder stage. Three ways to
persist `/data`; only the first is unconditionally safe:

### 1. Named volume — the recommended default

```sh
docker run -d -p 7878:7878 -v gadget-data:/data ghcr.io/c0ldfront/gadget-mcp:v0.3.0
```

Docker manages the filesystem, so UID 65532 never leaks to your host. This
is what `compose.yaml` and the `tests/e2e-docker.test.ts` suite use.

### 2. Bind mount + rootless runtime — the modern "host-visible" answer

If you *need* to inspect / edit the DB file from the host, run a rootless
container runtime so the container's uid 65532 is transparently mapped to
*your* host uid:

```sh
# rootless docker (install once): https://docs.docker.com/engine/security/rootless/
# or podman, which is rootless by default:
podman run -d -p 7878:7878 -v ./gadget-data:/data ghcr.io/c0ldfront/gadget-mcp:v0.3.0
ls -l ./gadget-data/gadget.db   # owned by you, not 65532
```

This is the direction the industry is heading (CNCF tooling, Kubernetes
user-namespaces GA, Podman/Buildah default). Prefer it over the hacks
below for any new deployment.

### 3. Bind mount + rootful daemon — only if (1) and (2) aren't available

Pre-chown the host directory **once** to match the container user, then
let the container write to it:

```sh
mkdir -p ./gadget-data
sudo chown -R 65532:65532 ./gadget-data
docker run -d -p 7878:7878 -v $(pwd)/gadget-data:/data ghcr.io/c0ldfront/gadget-mcp:v0.3.0
```

You will need `sudo` to read those files back. If you don't want that,
override the uid at run time:

```sh
docker run -d -p 7878:7878 \
  --user $(id -u):$(id -g) \
  -v $(pwd)/gadget-data:/data \
  ghcr.io/c0ldfront/gadget-mcp:v0.3.0
```

`--user` works because SQLite only needs the effective uid to be able to
write `/data`. Caveat: your uid isn't in the distroless `/etc/passwd`, so
anything that resolves `getpwuid` would fail — Bun + SQLite don't, but
keep this in mind if you fork the image. Do **not** `chown` your home
directory to 65532 to "make it work"; that is the anti-pattern this
section exists to prevent.

The image deliberately does **not** ship a `PUID` / `PGID` entrypoint
trick (the linuxserver.io pattern) — that requires a shell, and
distroless has none by design.

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
