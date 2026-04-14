import { GADGET_CATEGORIES, type GadgetRepo, type ReviewerRunnerRepo } from "@gadget/core";
import { completable } from "@modelcontextprotocol/sdk/server/completable.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { completeCategory, completeGadgetId, completeRunnerId } from "./completers.ts";

export interface PromptContext {
	readonly repo: GadgetRepo;
	readonly runnerRepo: ReviewerRunnerRepo;
}

type PromptMessage = {
	role: "user" | "assistant";
	content: { type: "text"; text: string };
};

function userMessage(text: string): PromptMessage {
	return { role: "user", content: { type: "text", text } };
}

function categoryCatalog(repo: GadgetRepo): string {
	return GADGET_CATEGORIES.map((c) => {
		const n = repo.list({ category: c, limit: 1 }).items.length;
		return `- ${c}: ${n >= 1 ? "available" : "empty"}`;
	}).join("\n");
}

export function registerPrompts(server: McpServer, ctx: PromptContext): void {
	server.registerPrompt(
		"gadget-build-chain",
		{
			title: "Build a gadget chain for a task",
			description:
				"Walk the assistant through listing, inspecting, and composing gadgets into a system prompt for a given task.",
			argsSchema: {
				task: z.string().min(1).describe("The task the composed prompt should address"),
			},
		},
		(args) => ({
			messages: [
				userMessage(
					[
						`Build a composed system prompt for this task: "${args.task}".`,
						"",
						"Workflow:",
						"1. Call `gadget.list-gadgets` (optionally filter by category) to discover candidates.",
						"2. Call `gadget.get-gadget` for any you want to inspect.",
						"3. If no gadget fills a slot, call `gadget.add-gadget` to contribute one.",
						"4. Finally call `gadget.compose-prompt` with the chosen ids in canonical order (role \u2192 context \u2192 task \u2192 constraint \u2192 format \u2192 example \u2192 reasoning \u2192 tone \u2192 caveat).",
						"",
						"Category availability:",
						categoryCatalog(ctx.repo),
					].join("\n"),
				),
			],
		}),
	);

	server.registerPrompt(
		"gadget-build-system-prompt",
		{
			title: "Build a system prompt for <task>",
			description:
				"Produce a finished system prompt by selecting appropriate gadgets from the library and calling `gadget.compose-prompt`. Use this when a user asks for a new persona, workflow, or reviewer prompt.",
			argsSchema: {
				task: z.string().min(1).describe("Short description of the persona or workflow"),
				category: completable(
					z.string().optional().describe("Optional category filter while browsing candidates"),
					(value): string[] => completeCategory(value ?? ""),
				),
			},
		},
		(args) => ({
			messages: [
				userMessage(
					[
						`Compose a finished system prompt for: "${args.task}".`,
						args.category !== undefined && args.category !== ""
							? `Focus on gadgets in category \`${args.category}\` first, then fill the remaining slots.`
							: "Canonical slot order is role \u2192 context \u2192 task \u2192 constraint \u2192 format \u2192 example \u2192 reasoning \u2192 tone \u2192 caveat.",
						"",
						"1. Call `gadget.list-gadgets` (and `gadget.search-gadgets` for keyword searches).",
						"2. Inspect candidates with `gadget.get-gadget`.",
						"3. Call `gadget.compose-prompt` with the ordered `gadgetIds` and return the resulting `prompt`.",
						"",
						"Category availability:",
						categoryCatalog(ctx.repo),
					].join("\n"),
				),
			],
		}),
	);

	server.registerPrompt(
		"gadget-align-repo",
		{
			title: "Align the current repo to the gadget-mcp engineering standards",
			description:
				"Audit the repository you are working in against the gadget-mcp charter (Bun-native APIs, strict TypeScript, Biome, colocated tests, conventional commits, error registry, observability). Produce a prioritized punch list of gaps and fix them in order.",
			argsSchema: {
				focus: completable(
					z
						.string()
						.optional()
						.describe("Optional focus area: errors | tests | docs | ci | security"),
					(value): string[] =>
						["errors", "tests", "docs", "ci", "security"].filter((k) =>
							k.startsWith((value ?? "").toLowerCase()),
						),
				),
			},
		},
		(args) => ({
			messages: [
				userMessage(
					[
						"Audit the current working directory against the gadget-mcp engineering standards.",
						"",
						"Standards you must enforce:",
						"- Bun-native APIs only (`Bun.file`, `Bun.$`, `Bun.spawn`, `Bun.serve`, `bun:sqlite`, `bun:test`). No `node:fs` read/writeFile, no `express`, no `better-sqlite3`.",
						"- Strict TypeScript (no `any`, explicit return types on exports, `noUncheckedIndexedAccess`).",
						"- Biome is the only lint + format tool; `bunx biome check` must be clean.",
						"- Colocated tests (`foo.ts` \u2194 `foo.test.ts`); e2e under `tests/`; property tests under `*/security.test.ts`.",
						"- Conventional commits, one feature per commit, all three of `biome check`, `tsc --noEmit`, `bun test` green before commit.",
						"- Observability: every mutating tool records audit + metrics + MCP logging notification; bulk ops emit progress.",
						"- Error registry: domain errors flow through a `*_ERROR_CODES` constant + a single `*McpError()` factory with `McpError.data.<project>Code`.",
						args.focus !== undefined && args.focus !== ""
							? `\nFocus area: **${args.focus}**. Weight findings in this area highest in the punch list.`
							: "\nNo focus area specified \u2014 audit the full surface.",
						"",
						"Workflow:",
						"1. Read `README.md`, `CLAUDE.md`, `CHANGELOG.md`, `docs/` to understand declared intent.",
						"2. Inspect `package.json`, `biome.json`, `tsconfig.json`, the workspace layout.",
						"3. Call `gadget.list-gadgets` and `gadget.compose-prompt` if you need a reference standard to benchmark against.",
						"4. Produce a prioritized punch list (highest-risk first) with file:line citations.",
						"5. Propose commits \u2014 one per gap \u2014 and execute them when approved.",
					].join("\n"),
				),
			],
		}),
	);

	server.registerPrompt(
		"gadget-inspect",
		{
			title: "Inspect a specific gadget",
			description: "Fetch and display a single gadget (including content + revisions + aliases).",
			argsSchema: {
				id: completable(z.string().min(1).describe("Gadget id or alias"), (value): string[] =>
					completeGadgetId(ctx.repo, value),
				),
			},
		},
		(args) => ({
			messages: [
				userMessage(
					[
						`Inspect the gadget \`${args.id}\`.`,
						"",
						`1. Call \`gadget.get-gadget\` with \`{ id: "${args.id}" }\`.`,
						"2. Call `gadget.list-revisions` with the same id if the user wants history.",
						"3. Return a concise summary: category, title, tags, aliases, and the first ~400 characters of content.",
					].join("\n"),
				),
			],
		}),
	);

	server.registerPrompt(
		"gadget-run-reviewer",
		{
			title: "Run a reviewer runner against a prompt",
			description:
				"Execute a configured reviewer runner (claude | codex | gemini | local) against a prompt and return the review output.",
			argsSchema: {
				runnerId: completable(
					z.string().min(1).describe("Configured reviewer runner id"),
					(value): string[] => completeRunnerId(ctx.runnerRepo, value),
				),
				prompt: z.string().min(1).describe("The prompt to review or run through the runner"),
			},
		},
		(args) => ({
			messages: [
				userMessage(
					[
						`Run reviewer runner \`${args.runnerId}\` against the supplied prompt.`,
						"",
						"1. Call `gadget.list-runners` to confirm the runner is enabled.",
						"2. Call `gadget.run-reviewer` with `{ runnerId, prompt }`.",
						"3. Summarize the review: status, exitCode, notable output, stderr if present.",
						"",
						"Prompt to run:",
						"---",
						args.prompt,
						"---",
					].join("\n"),
				),
			],
		}),
	);
}
