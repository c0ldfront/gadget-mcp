# Prompts

`gadget-mcp` ships five MCP prompts. MCP clients surface them as
`/mcp__gadget-mcp__<name>` slash commands. Each prompt returns a single
user-role message telling the caller exactly which `gadget.*` tools to
chain; clients are free to execute those tool calls automatically.

Arguments tagged *(completes)* use the MCP `completion/complete`
protocol and are backed by the central helpers in
`packages/server/src/mcp/completers.ts`.

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
