# Benchmarks

`bench/all.bench.ts` exercises four hot paths against an in-memory SQLite
database and reports `p50 / p95 / p99 / mean` in milliseconds.

| Bench                     | Workload                                                   |
| ------------------------- | ---------------------------------------------------------- |
| `put@1k`                  | 500 randomized `GadgetRepo.put` calls (insert + revision). |
| `list@10k_first_page`     | First 25-row page over a 10 000-gadget corpus.             |
| `search@10k_needle`       | FTS5 `MATCH 'needle'` over the same corpus.                |
| `metrics_render`          | `MetricsRegistry.render()` emitting Prometheus text.       |

## Running locally

```sh
bun run bench          # prints JSON, fails on regressions vs. baseline
bun run bench:baseline # overwrite bench/baseline.json with fresh numbers
```

Regression gate (from `bench/_harness.ts::detectRegressions`):

- Fails if any bench's **p50 ≥ 1.2× baseline** (20% slower).
- Fails if any bench's **p95 ≥ 1.5× baseline** (50% slower).

The asymmetric threshold tolerates the noise floor on shared CI runners —
p50 is the central-tendency metric and shifts first on real regressions,
while p95 on sub-millisecond benches can swing ±15–30% run-to-run from
hardware jitter alone.

## Why the committed baseline must come from CI, not your laptop

The regression gate runs in GitHub Actions against `ubuntu-latest` (a
2-core shared VM). A developer laptop is routinely 3–10× faster for
CPU-bound work and has far lower variance. If you `bun run bench:baseline`
locally and commit that file, **every CI run will fail with phantom
regressions that are just hardware delta**.

The committed `bench/baseline.json` must reflect the same hardware as the
CI gate. There are two supported ways to seed it:

1. **`bench-seed` workflow (preferred).** Trigger
   `.github/workflows/bench-seed.yml` via the Actions tab
   (`workflow_dispatch`). It runs the benchmarks on `ubuntu-latest`,
   writes a fresh `bench/baseline.json`, and opens a pull request you can
   review and merge.
2. **Copy from a green CI log.** The CI `bench` job prints the full
   `{p50Ms, p95Ms}` JSON for every bench. Copy those numbers into
   `bench/baseline.json`, commit on a PR, and include a one-line
   justification for the change in the commit body.

## When the baseline is empty

`bench/baseline.json` ships as `{}`. The harness detects the empty map
and prints:

```
baseline is empty — regression gate disabled until seeded from CI.
```

CI still runs the benches (so you see the numbers in the log) but does
not gate the build. First green merge of a `bench-seed` PR turns the
gate on.

## Interpreting CI failures

A regression means *something in the hot path got slower*. Common
culprits:

- An accidental N+1 in the repo layer (extra query per row).
- A new index missing on a frequently-queried column.
- A new tool wrapper that runs on every call (audit writer, metrics
  registry, etc. all execute inside `wrapHandler` in `tools.ts`).

Reproduce locally with `bun run bench` and bisect the recent diff. If the
regression is real and accepted (deliberate hot-path change), re-baseline
via the `bench-seed` workflow and explain the acceptance in the merging
PR body.

## Adding a new benchmark

1. Extend `bench/all.bench.ts` with a new `bench(name, fn, opts)` call.
2. Run the `bench-seed` workflow to refresh the baseline on CI hardware.
3. The harness detects the new entry automatically on the next CI run.

## Why no library?

Existing benchmark harnesses (mitata, tinybench, …) add a dependency for
what is ultimately a `performance.now()` loop. `bench/_harness.ts` is
~70 lines, has no dependencies, and produces stable JSON we can diff in
CI.
