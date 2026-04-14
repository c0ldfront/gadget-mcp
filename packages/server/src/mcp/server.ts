import type { AuditWriter, Db, GadgetMetrics, GadgetRepo, ReviewerRunnerRepo } from "@gadget/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pkg from "../../package.json" with { type: "json" };
import type { Role } from "./auth.ts";
import { registerPrompts } from "./prompts.ts";
import { registerResources } from "./resources.ts";
import { registerTools } from "./tools.ts";

export interface BuildServerInput {
	readonly repo: GadgetRepo;
	readonly runnerRepo: ReviewerRunnerRepo;
	readonly role: Role;
	readonly actor: string;
	readonly audit: AuditWriter;
	readonly metrics: GadgetMetrics;
	readonly workspace: string;
	readonly db: Db;
}

export const SERVER_NAME = "gadget-mcp";
export const SERVER_VERSION: string = pkg.version;

export function buildServer(input: BuildServerInput): McpServer {
	const server = new McpServer(
		{ name: SERVER_NAME, version: SERVER_VERSION },
		{
			capabilities: {
				tools: { listChanged: true },
				resources: { subscribe: false, listChanged: true },
				prompts: { listChanged: true },
				logging: {},
			},
			instructions: [
				"When the user asks you to build, author, compose, or reuse a system prompt, persona, or prompt template, use this server. It is a persistent library of reusable prompt components ('gadgets') across nine categories (role, context, task, constraint, format, example, reasoning, tone, caveat), and it exposes a compose-prompt tool that stitches chosen gadget ids into a finished prompt.",
				"",
				"Typical workflow:",
				"1. gadget.list-gadgets — browse the catalog (filter by category).",
				"2. gadget.search-gadgets — keyword search (BM25 over FTS5).",
				"3. gadget.get-gadget — inspect a candidate.",
				"4. gadget.add-gadget — contribute a new one if a slot is empty.",
				"5. gadget.compose-prompt — concatenate chosen ids into the final prompt.",
				"",
				"Also available: /gadget-build-system-prompt (walks the full compose flow), /gadget-align-repo (audits the current repo against the gadget-mcp engineering standards), /gadget-inspect (a single gadget), /gadget-run-reviewer (execute a peer-review runner).",
			].join("\n"),
		},
	);
	registerTools(server, {
		repo: input.repo,
		runnerRepo: input.runnerRepo,
		role: input.role,
		actor: input.actor,
		audit: input.audit,
		metrics: input.metrics,
	});
	registerResources(server, { repo: input.repo, runnerRepo: input.runnerRepo });
	registerPrompts(server, { repo: input.repo, runnerRepo: input.runnerRepo });
	return server;
}
