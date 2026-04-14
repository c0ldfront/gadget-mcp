# Prompts

`gadget-mcp` ships six MCP prompts. MCP clients surface them as
`/mcp__gadget-mcp__<name>` slash commands. Each prompt returns a single
user-role message telling the caller exactly which `gadget.*` tools to
chain; clients are free to execute those tool calls automatically.

Arguments tagged *(completes)* use the MCP `completion/complete`
protocol and are backed by the central helpers in
`packages/server/src/mcp/completers.ts`.

> **Client-side autocomplete limitation.** The server advertises
> `completions: {}` and responds correctly to `completion/complete` for
> every prompt argument marked *(completes)* (verified against the SDK
> client in `packages/server/src/mcp/server.test.ts`). Some MCP clients —
> notably Claude Code as of v2.1.107 — do not yet surface prompt-argument
> autocomplete in their slash-command UI; only resource-template argument
> completion is rendered. When an arg can't be autocompleted, list/search
> the value via a tool call first (`gadget.list-gadgets`,
> `gadget.list-runners`) and paste it in.

## `gadget-author`

**Args:**
- `category` (string, optional, **completes** over the nine canonical
  categories) — target slot for the new gadget.
- `intent` (string, optional) — one-line description of the single rule
  the gadget should capture.

Teaches the house single-purpose rule before any `add-gadget` /
`put-gadget` call. Pulls **three live curated exemplars** from the
connected workspace's repo so the LLM has real in-domain shape to match,
quotes the hard caps (`title ≤ 80`, `description ≤ 200`, `content ≤ 500`)
and the shape guard (≤ 2 headings, ≤ 1 code fence), and walks through a
three-step process: calibrate to exemplars → write one gadget → call
`gadget.add-gadget` (or `gadget.put-gadget` to overwrite).

Use this whenever the LLM is tempted to stuff multiple rules into one
body — the prompt body forces the split-first discipline.

## `gadget-build-chain`

**Args:** `task` (string, required) — the task the composed prompt
should address.

Produces the baseline four-step workflow:

1. `gadget.list-gadgets` to browse candidates.
2. `gadget.get-gadget` to inspect.
3. `gadget.add-gadget` if any canonical slot is empty.
4. `gadget.compose-prompt` to chain the chosen ids.

Output also embeds a category-availability catalog so the caller
immediately knows which slots have gadgets.

## `gadget-build-system-prompt`

**Args:**
- `task` (string, required) — short description of the persona /
  workflow.
- `category` (string, optional, **completes** over the nine canonical
  categories) — optional focus area while browsing candidates.

This is the **primary entry point when a user asks for a system prompt /
persona / reviewer template**. The prompt closes on
`gadget.compose-prompt` and returns the concatenated result.

## `gadget-align-repo`

**Args:**
- `focus` (string, optional, **completes** over
  `errors | tests | docs | ci | security`) — area to weight heaviest.

Audits the current working directory against the gadget-mcp engineering
charter. The prompt enumerates the concrete standards (Bun-native APIs,
strict TypeScript, Biome-only tooling, colocated tests, conventional
commits, observability, error registry) and walks the assistant through
reading `README.md` / `CLAUDE.md` / `CHANGELOG.md` / `docs/` plus the
top-level configs, then producing a prioritized punch list with
`file:line` citations and one-commit-per-gap proposals.

## `gadget-inspect`

**Args:** `id` (string, required, **completes** over live ids + aliases).

Emits instructions to call `gadget.get-gadget` and optionally
`gadget.list-revisions` for the given id, then return a concise summary
(category, title, tags, aliases, first ~400 characters of content).

## `gadget-run-reviewer`

**Args:**
- `runnerId` (string, required, **completes** over configured reviewer
  runners).
- `prompt` (string, required) — the prompt to run through the reviewer.

Calls `gadget.list-runners` to confirm the runner is enabled, then
`gadget.run-reviewer` to execute it, and summarizes the output
(`status`, `exitCode`, notable output, stderr).

## Adding a new prompt

1. Register via `server.registerPrompt(name, {title, description,
   argsSchema}, handler)` in `packages/server/src/mcp/prompts.ts`.
2. For arguments that should offer autocomplete, wrap the zod field in
   `completable(schema, completer)` from
   `@modelcontextprotocol/sdk/server/completable.js` and back the
   `completer` with a helper from `completers.ts` (add one if needed,
   with colocated tests).
3. Update `README.md` (Prompts table) and this file. See
   [`docs/live-tests.md`](./live-tests.md) for the discovery suite that
   exercises prompt + tool selection from natural-language prompts.
