# Release process

`gadget-mcp` releases are fully driven by GitHub Actions. Cutting a
release is a one-line operation on your workstation; everything else —
validation, build, packaging, checksumming, SBOM generation,
provenance attestation, release page creation, and container publish —
runs in CI from a signed annotated tag.

## Cutting a release

```sh
# 1. Bump the version in package.json + packages/*/package.json.
#    Append a new section to CHANGELOG.md under `## [X.Y.Z] - YYYY-MM-DD`.
#    Commit on main:
git add package.json packages/*/package.json CHANGELOG.md
git commit -m "chore(release): vX.Y.Z"

# 2. Tag (annotated + GPG-signed if you have a key configured).
git tag -s vX.Y.Z -m "gadget-mcp vX.Y.Z"

# 3. Push both the commit and the tag.
git push origin main --follow-tags
```

The push of any `v*` tag triggers `.github/workflows/release.yml`.

## What the release workflow does

```
tag:v*
  │
  ├── check   ───────────────── biome + tsc + bun test + bun run bench
  │                             (release gate — fails fast)
  │
  ├── release ───────────────── forge.ts release (per-triple binaries
  │                             + tar.gz + SHA256SUMS.txt + SBOM)
  │                             attest-build-provenance v2
  │                             softprops/action-gh-release (attach
  │                             artifacts + CHANGELOG section)
  │
  └── container ─────────────── docker buildx multi-arch (linux/amd64
                                + linux/arm64), push to ghcr.io with
                                :X.Y.Z, :vX.Y.Z, and :latest (latest
                                only for stable, not prereleases).
                                attest-build-provenance v2 push-to-
                                registry.
```

Every job is gated on the previous one succeeding — a failed
typecheck or a regressed benchmark stops the release before any
artifact ships.

## Prerelease detection

Tags that contain `-rc`, `-alpha`, `-beta`, `-pre`, or `-dev` (with
optional version segments) are automatically marked as **prerelease**
on the GitHub release and **do not** push the `:latest` container tag.

```
v0.2.0           → stable      (ghcr.io/...:0.2.0, :v0.2.0, :latest)
v0.2.0-rc.1      → prerelease  (ghcr.io/...:0.2.0-rc.1, :v0.2.0-rc.1)
v0.2.0-beta.3    → prerelease  (ghcr.io/...:0.2.0-beta.3, :v0.2.0-beta.3)
```

## Release notes

Body comes from the `CHANGELOG.md` section whose heading matches the
version (`## [X.Y.Z]` or `## X.Y.Z`) — trimmed from that line up to
the next `## ` heading. GitHub's `generate_release_notes: true` is
also on, so commits between tags are appended beneath the
hand-written section.

If `CHANGELOG.md` has no entry for the version, only the auto-generated
notes are used. The workflow does NOT fail the release in that case —
doc debt is caught earlier by reviewers, not at release time.

## Artifacts attached to each release

| Artifact                                    | Purpose                                  |
| ------------------------------------------- | ---------------------------------------- |
| `gadget-mcp-bun-linux-x64.tar.gz`           | glibc amd64 static binary                |
| `gadget-mcp-bun-linux-x64-musl.tar.gz`      | musl  amd64 static binary                |
| `gadget-mcp-bun-linux-arm64.tar.gz`         | glibc arm64 static binary                |
| `gadget-mcp-bun-linux-arm64-musl.tar.gz`    | musl  arm64 static binary                |
| `gadget-mcp-X.Y.Z-source.tar.gz`            | `git archive` of the tagged source tree  |
| `SHA256SUMS.txt`                            | `sha256sum -c`–verifiable manifest       |
| `SBOM.cyclonedx.json`                       | CycloneDX 1.5 dependency bill of materials |

Verify locally:

```sh
# Verify checksums.
sha256sum -c SHA256SUMS.txt

# Verify build provenance via `gh attestation`.
gh attestation verify gadget-mcp-bun-linux-x64.tar.gz \
  --repo c0ldfront/gadget-mcp
```

## Container image

```
ghcr.io/<owner>/gadget-mcp:X.Y.Z
ghcr.io/<owner>/gadget-mcp:vX.Y.Z
ghcr.io/<owner>/gadget-mcp:latest   # stable only
```

Multi-arch manifests cover `linux/amd64` and `linux/arm64`. Each
pushed image has a build-provenance attestation stored in the
registry and verifiable with `gh attestation verify --registry`.

## Pre-flight checklist

Before cutting a tag:

1. `bun run check` locally (biome + tsc + unit + e2e + harness).
2. `bun run bench` locally — if a regression is expected (intentional
   workload change), commit a refreshed `bench/baseline.json` first.
3. `CHANGELOG.md` has the new `## [X.Y.Z]` section filled in.
4. `package.json`, `packages/core/package.json`,
   `packages/server/package.json` all agree on the new version.
5. Docker image builds locally (optional):
   `docker build -t gadget-mcp:test .`

## Rolling back a release

The `release` job is idempotent **per tag**. To withdraw a bad
release:

1. `gh release delete vX.Y.Z --cleanup-tag` (removes the GitHub
   release and deletes the remote tag).
2. Delete the ghcr image tag:
   `docker rmi ghcr.io/<owner>/gadget-mcp:X.Y.Z` (locally) plus the
   remote via the ghcr UI — ghcr has no CLI for deleting image tags.
3. Mark the version **deprecated** with a follow-up
   `## [X.Y.Z+1] - yyyy-mm-dd` CHANGELOG entry that explains the
   regression.

Never retag an existing version; always cut a new patch.

## Why release inside the repo?

All artifact authority (binaries, SBOM, attestations, container
images) lives on the same commit and tag as the source. A downstream
can reproduce the release byte-for-byte by running
`bun run forge.ts release` on the tagged commit — no hidden CI
substitution, no out-of-band signing, no maintainer-specific keys.
