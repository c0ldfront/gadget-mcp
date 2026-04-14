# gadget-mcp docs

| Doc                         | Scope                                                                |
| --------------------------- | -------------------------------------------------------------------- |
| [architecture.md][arch]     | Four-layer diagram, gadget/runner core, why hand-rolled SQL.         |
| [tool-reference.md][tools]  | Every `gadget.*` tool with role gate and contract.                  |
| [auth.md][auth]             | Stdio (trusted), HTTP (bearer tokens), `reader|writer|admin` roles.  |
| [transports.md][tx]         | stdio + Streamable HTTP, session scoping, probe routes.              |
| [threat-model.md][threat]   | Trust boundaries and per-threat mitigations.                         |
| [runbook.md][ops]           | Day-2 operations: token rotation, backup, restore, diagnostics.      |
| [configuration.md][config]  | Every environment variable, CLI flag, and runtime knob.              |
| [benchmarks.md][bench]      | Hot-path benches and the CI regression gate.                         |
| [migrations.md][mig]        | Schema migrations and breaking-change procedure.                     |
| [release.md][rel]           | How `v*` tag pushes drive the GitHub Actions release pipeline.       |
| [live-tests.md][live]       | Opt-in LLM-discovery smoke suite (claude + codex).                   |
| [prompts.md][pr]            | Per-prompt contract and argument completion.                         |

See the repository [README][readme] for install + quick-start.

[arch]: ./architecture.md
[tools]: ./tool-reference.md
[auth]: ./auth.md
[tx]: ./transports.md
[threat]: ./threat-model.md
[ops]: ./runbook.md
[config]: ./configuration.md
[bench]: ./benchmarks.md
[mig]: ./migrations.md
[rel]: ./release.md
[live]: ./live-tests.md
[pr]: ./prompts.md
[readme]: ../README.md
