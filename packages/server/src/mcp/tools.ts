import {
	type AuditWriter,
	COMPOSE_ORDER,
	executeReviewerRun,
	exportNdjson,
	GADGET_CONTENT_MAX,
	GADGET_DESCRIPTION_MAX,
	GADGET_TITLE_MAX,
	GadgetCategorySchema,
	GadgetInputSchema,
	type GadgetMetrics,
	type GadgetRepo,
	GadgetTagSchema,
	importNdjson,
	type ReviewerRunnerRepo,
	toListItem,
} from "@gadget/core";
import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type CallToolResult, ListRootsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { type Role, roleAllows, TOOL_REQUIRED_ROLES } from "./auth.ts";
import { GADGET_ERROR_CODES, gadgetMcpError, resultCodeOf, toMcpError } from "./errors.ts";
import { assertGadgetShape } from "./gadget-shape.ts";
import {
	mcpRunner,
	renderTopLineInstruction,
	resolveElicitTimeoutMs,
	runKickoff,
} from "./kickoff.ts";

export interface ToolContext {
	readonly repo: GadgetRepo;
	readonly runnerRepo: ReviewerRunnerRepo;
	readonly role: Role;
	readonly actor: string;
	readonly audit: AuditWriter;
	readonly metrics: GadgetMetrics;
}

const MUTATION_TOOLS = new Set([
	"gadget.add-gadget",
	"gadget.put-gadget",
	"gadget.rename-gadget",
	"gadget.rollback-gadget",
	"gadget.delete-gadget",
	"gadget.import-gadgets",
	"gadget.upsert-runner",
	"gadget.delete-runner",
]);

function affectsResources(name: string): boolean {
	return MUTATION_TOOLS.has(name);
}

function contentCharsOf(args: unknown): number | undefined {
	if (typeof args !== "object" || args === null) return undefined;
	const c = (args as { content?: unknown }).content;
	return typeof c === "string" ? c.length : undefined;
}

function jsonContent(value: unknown): CallToolResult["content"] {
	return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}

function structured(value: Record<string, unknown>): CallToolResult {
	return { content: jsonContent(value), structuredContent: value };
}

const GadgetIdParam = z.string().min(1).describe("Gadget id (lowercase kebab-case) or alias.");
const CategoryEnum = GadgetCategorySchema;

// ── shared output-schema shapes ─────────────────────────────────────────────
const GadgetListItemOutput = {
	id: z.string().describe("Gadget id."),
	category: CategoryEnum.describe("Canonical prompt slot."),
	title: z.string().describe("Human-readable title."),
	description: z.string().describe("One-line summary of what this gadget does."),
	tags: z.array(z.string()).describe("Lowercase kebab-case tags."),
	content: z.string().describe("Full gadget body — use this to calibrate the house shape."),
};

const GadgetFullOutput = {
	id: z.string(),
	category: CategoryEnum,
	title: z.string(),
	description: z.string(),
	content: z.string(),
	tags: z.array(z.string()),
	source: z.enum(["curated", "generated"]),
	createdAt: z.number(),
	updatedAt: z.number(),
	aliases: z.array(z.string()).describe("Former ids that resolve to this gadget."),
};

const RevisionSummaryOutput = {
	version: z.number().int().positive().describe("Monotonically increasing revision number."),
	createdAt: z.number().int().nonnegative().describe("Unix epoch ms when this revision landed."),
	title: z.string(),
	description: z.string(),
};

const ComposeChainItemOutput = {
	id: z.string(),
	category: CategoryEnum,
	title: z.string(),
};

const RunnerOutput = {
	id: z.string(),
	name: z.string(),
	command: z.array(z.string()),
	enabled: z.boolean(),
	timeoutSeconds: z.number().int().positive().nullable(),
};

export interface HandlerExtra {
	readonly signal?: AbortSignal;
	readonly _meta?: { readonly progressToken?: string | number };
	readonly sendNotification?: (n: { method: string; params?: unknown }) => Promise<void>;
	readonly sendRequest?: <S extends { parse: (x: unknown) => unknown }>(
		request: { method: string; params?: unknown },
		schema: S,
	) => Promise<ReturnType<S["parse"]>>;
}

function wrapHandler<A extends object>(
	server: McpServer,
	ctx: ToolContext,
	name: string,
	handler: (args: A, extra: HandlerExtra) => CallToolResult | Promise<CallToolResult>,
	gadgetIdOf?: (args: A) => string | undefined,
): ToolCallback<z.ZodRawShape> {
	const mutating = isMutatingTool(name);
	const touchesResources = affectsResources(name);
	return (async (rawArgs: unknown, rawExtra: unknown): Promise<CallToolResult> => {
		const started = performance.now();
		let code = "ok";
		const args = rawArgs as A;
		const extra = (rawExtra as HandlerExtra) ?? {};
		try {
			return await handler(args, extra);
		} catch (err) {
			code = resultCodeOf(err);
			const mapped = toMcpError(err);
			if (mapped !== null) throw mapped;
			throw err;
		} finally {
			const durationSeconds = (performance.now() - started) / 1000;
			ctx.metrics.recordToolCall(name, code, durationSeconds);
			const gadgetId = gadgetIdOf !== undefined ? gadgetIdOf(args) : undefined;
			const contentChars = mutating ? contentCharsOf(args) : undefined;
			if (contentChars !== undefined) {
				ctx.metrics.recordGadgetContentChars(name, contentChars);
			}
			ctx.audit.record({
				actor: ctx.actor,
				tool: name,
				args,
				resultCode: code,
				...(gadgetId !== undefined ? { gadgetId } : {}),
			});
			if (mutating && typeof extra.sendNotification === "function") {
				const payload = {
					tool: name,
					actor: ctx.actor,
					resultCode: code,
					durationMs: Math.round(durationSeconds * 1000),
					...(gadgetId !== undefined ? { gadgetId } : {}),
					...(contentChars !== undefined ? { contentChars } : {}),
				};
				extra
					.sendNotification({
						method: "notifications/message",
						params: {
							level: code === "ok" ? "info" : "warning",
							logger: "gadget-mcp",
							data: payload,
						},
					})
					.catch(() => {
						// logging is best-effort
					});
			}
			if (touchesResources && code === "ok") {
				try {
					server.sendResourceListChanged();
				} catch {
					// best-effort
				}
			}
		}
		// biome-ignore lint/suspicious/noExplicitAny: SDK overload union resolves to never; shape is correct.
	}) as any;
}

function isToolAllowed(role: Role, name: string): boolean {
	const req = TOOL_REQUIRED_ROLES[name];
	return req === undefined || roleAllows(role, req);
}

function isMutatingTool(name: string): boolean {
	const req = TOOL_REQUIRED_ROLES[name];
	return req === "writer" || req === "admin";
}

export async function emitProgress(
	extra: HandlerExtra,
	progress: number,
	total: number | undefined,
): Promise<void> {
	const token = extra._meta?.progressToken;
	if (token === undefined || extra.sendNotification === undefined) return;
	try {
		await extra.sendNotification({
			method: "notifications/progress",
			params: {
				progressToken: token,
				progress,
				...(total !== undefined ? { total } : {}),
			},
		});
	} catch {
		// best-effort
	}
}

/**
 * Drip progress notifications at a steady cadence so the caller's
 * `resetTimeoutOnProgress` keeps a long-running tool call alive while the
 * handler blocks on something slow (user-facing elicitation, sampling, etc.).
 *
 * MCP SDK default tool-call timeout on the requester side is 60 s. Dripping
 * every 15 s gives us ~4x headroom per beat and avoids spamming the log.
 *
 * The returned function stops the heartbeat and must be called on every exit
 * path. No-op when the caller didn't supply a `progressToken` or when
 * `sendNotification` isn't available (e.g. in unit-test stubs).
 */
export function startProgressHeartbeat(extra: HandlerExtra, intervalMs = 15_000): () => void {
	const token = extra._meta?.progressToken;
	const send = extra.sendNotification;
	if (token === undefined || typeof send !== "function") {
		return () => {};
	}
	let tick = 0;
	const timer = setInterval(() => {
		tick += 1;
		send({
			method: "notifications/progress",
			params: { progressToken: token, progress: tick },
		}).catch(() => {
			// best-effort
		});
	}, intervalMs);
	// Don't block process exit while a tool is pending.
	if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
		(timer as unknown as { unref: () => void }).unref();
	}
	return () => clearInterval(timer);
}

export function registerTools(server: McpServer, ctx: ToolContext): void {
	const role = ctx.role;

	if (isToolAllowed(role, "gadget.list-gadgets")) {
		server.registerTool(
			"gadget.list-gadgets",
			{
				title: "List reusable prompt gadgets",
				description:
					"Browse the library of reusable prompt components (role, context, task, constraint, format, example, reasoning, tone, caveat). Each item includes the full `content` body so you can see the house shape before composing or authoring. Call this first when a user asks you to build or author a system prompt / persona / reviewer template. Keyset-paginated; filter by category to narrow.",
				inputSchema: {
					category: CategoryEnum.optional().describe(
						"Restrict the page to one canonical slot (role, context, task, constraint, format, example, reasoning, tone, caveat).",
					),
					limit: z
						.number()
						.int()
						.positive()
						.max(200)
						.optional()
						.describe("Page size, 1–200. Defaults to 50."),
					cursor: z
						.string()
						.optional()
						.describe("Opaque cursor from a prior response's `nextCursor` to continue pagination."),
				},
				outputSchema: {
					items: z.array(z.object(GadgetListItemOutput)),
					nextCursor: z
						.string()
						.nullable()
						.describe(
							"Pass this back as `cursor` to fetch the next page; null when the page is last.",
						),
				},
				annotations: {
					readOnlyHint: true,
					idempotentHint: true,
					openWorldHint: false,
				},
			},
			wrapHandler<{
				category?: z.infer<typeof CategoryEnum>;
				limit?: number;
				cursor?: string;
			}>(server, ctx, "gadget.list-gadgets", (args) => {
				const page = ctx.repo.list({
					...(args.category !== undefined ? { category: args.category } : {}),
					...(args.limit !== undefined ? { limit: args.limit } : {}),
					...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
				});
				return structured({
					items: page.items.map(toListItem),
					nextCursor: page.nextCursor,
				});
			}),
		);
	}

	if (isToolAllowed(role, "gadget.search-gadgets")) {
		server.registerTool(
			"gadget.search-gadgets",
			{
				title: "Search prompt gadgets by keyword",
				description:
					"Full-text search (BM25 over FTS5) across gadget id, title, description, content, and tags. Each hit includes the full `content` body. Use this to find relevant prompt components when the user's ask names a domain, persona, or workflow keyword.",
				inputSchema: {
					query: z
						.string()
						.min(1)
						.describe(
							"BM25 keyword query. Supports FTS5 syntax (terms, phrases in quotes, prefix with *, AND/OR).",
						),
					category: CategoryEnum.optional().describe("Restrict hits to one canonical slot."),
					limit: z
						.number()
						.int()
						.positive()
						.max(200)
						.optional()
						.describe("Page size, 1–200. Defaults to 50."),
					cursor: z
						.string()
						.optional()
						.describe("Opaque cursor from a prior response; must be paired with the same `query`."),
				},
				outputSchema: {
					items: z.array(z.object(GadgetListItemOutput)),
					nextCursor: z.string().nullable(),
				},
				annotations: {
					readOnlyHint: true,
					idempotentHint: true,
					openWorldHint: false,
				},
			},
			wrapHandler<{
				query: string;
				category?: z.infer<typeof CategoryEnum>;
				limit?: number;
				cursor?: string;
			}>(server, ctx, "gadget.search-gadgets", (args) => {
				const page = ctx.repo.search({
					query: args.query,
					...(args.category !== undefined ? { category: args.category } : {}),
					...(args.limit !== undefined ? { limit: args.limit } : {}),
					...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
				});
				return structured({
					items: page.items.map(toListItem),
					nextCursor: page.nextCursor,
				});
			}),
		);
	}

	if (isToolAllowed(role, "gadget.get-gadget")) {
		server.registerTool(
			"gadget.get-gadget",
			{
				title: "Get gadget",
				description:
					"Retrieve the full gadget (including the complete content body and aliases) by id or alias. Call this when you need the actual content of a specific gadget — list/search only return previews.",
				inputSchema: { id: GadgetIdParam },
				outputSchema: { gadget: z.object(GadgetFullOutput) },
				annotations: {
					readOnlyHint: true,
					idempotentHint: true,
					openWorldHint: false,
				},
			},
			wrapHandler<{ id: string }>(
				server,
				ctx,
				"gadget.get-gadget",
				(args) => {
					const g = ctx.repo.resolve(args.id);
					if (g === null) {
						throw gadgetMcpError({
							code: GADGET_ERROR_CODES.NotFound,
							message: `gadget not found: ${args.id}`,
							data: { id: args.id },
						});
					}
					const aliases = ctx.repo.aliasesOf(g.id);
					return structured({ gadget: { ...g, aliases } });
				},
				(args) => args.id,
			),
		);
	}

	const AddInputSchema = {
		id: GadgetIdParam,
		category: CategoryEnum.describe(
			"Canonical slot this gadget fills. Pick the most specific match — do not default to `context` for persona material (that is `role`).",
		),
		title: z
			.string()
			.min(1)
			.max(GADGET_TITLE_MAX)
			.describe(
				`Human-readable title, ≤${GADGET_TITLE_MAX} chars. Describes the gadget, not its content.`,
			),
		description: z
			.string()
			.min(1)
			.max(GADGET_DESCRIPTION_MAX)
			.describe(
				`One-line summary of what this gadget does, ≤${GADGET_DESCRIPTION_MAX} chars. Describes the gadget, not its content.`,
			),
		content: z
			.string()
			.min(1)
			.max(GADGET_CONTENT_MAX)
			.describe(
				`The gadget body. TARGET ~150 chars, ceiling ${GADGET_CONTENT_MAX}. One focused idea; split if longer than ~250.`,
			),
		tags: z
			.array(GadgetTagSchema)
			.optional()
			.describe("Lowercase kebab-case tags (e.g. `bun`, `low-power`). ≤40 chars each."),
	};

	const AddOutput = {
		id: z.string(),
		version: z.number().int().positive(),
	};
	const PutOutput = {
		id: z.string(),
		version: z.number().int().positive(),
		created: z.boolean().describe("True when this call created the gadget; false when it updated."),
	};

	const AUTHORING_RULES = [
		"Add a SINGLE-PURPOSE gadget — one focused rule, persona primer, pattern, or snippet.",
		`TARGET ~150 characters of content. HARD CEILING: ${GADGET_CONTENT_MAX}. If your draft runs past ~250 chars you are almost certainly packing multiple ideas — split.`,
		"House-style exemplars (curated library): 'Be maximally concise. Omit preamble, summaries, and filler. Every sentence must carry information.' (98 chars). 'You are an expert low-level AI embedded systems engineer. You specialize in firmware, RTOS, bare-metal C/C++, hardware interfacing, and microcontroller architectures (ARM Cortex-M, RISC-V, AVR). You think in cycles, memory maps, and interrupt vectors.' (251 chars). Match that density.",
		"Before writing, call `gadget.list-gadgets` (each item includes the full `content`) to see the shape; calibrate to it.",
		"Do NOT pack multiple rules, layout diagrams, examples, and reasoning into one gadget. Split them into separate gadgets, one per category.",
		"Prose only. ≤2 markdown headings, ≤1 fenced code block — and the server rejects more. Reserve the one fence for example/format gadgets.",
		`Keep title ≤${String(GADGET_TITLE_MAX)} chars and description ≤${String(GADGET_DESCRIPTION_MAX)} chars; both describe what the gadget IS, not what it says.`,
	].join(" ");

	if (isToolAllowed(role, "gadget.add-gadget")) {
		server.registerTool(
			"gadget.add-gadget",
			{
				title: "Add gadget",
				description: `Add a new single-purpose gadget. Fails if id already exists (use \`put-gadget\` to upsert). ${AUTHORING_RULES}`,
				inputSchema: AddInputSchema,
				outputSchema: AddOutput,
				annotations: {
					readOnlyHint: false,
					destructiveHint: false,
					idempotentHint: false,
					openWorldHint: false,
				},
			},
			wrapHandler<{
				id: string;
				category: z.infer<typeof CategoryEnum>;
				title: string;
				description: string;
				content: string;
				tags?: string[];
			}>(
				server,
				ctx,
				"gadget.add-gadget",
				(args) => {
					const input = GadgetInputSchema.parse({
						source: "generated",
						tags: [],
						...args,
					});
					assertGadgetShape(input.content);
					const res = ctx.repo.add(input);
					return structured({ id: res.gadget.id, version: res.version });
				},
				(args) => args.id,
			),
		);
	}

	if (isToolAllowed(role, "gadget.put-gadget")) {
		server.registerTool(
			"gadget.put-gadget",
			{
				title: "Put gadget",
				description: `Create-or-update a single-purpose gadget; always writes a new revision (old versions remain listed via \`list-revisions\` and are rollback-able). ${AUTHORING_RULES}`,
				inputSchema: AddInputSchema,
				outputSchema: PutOutput,
				annotations: {
					readOnlyHint: false,
					destructiveHint: false,
					idempotentHint: true,
					openWorldHint: false,
				},
			},
			wrapHandler<{
				id: string;
				category: z.infer<typeof CategoryEnum>;
				title: string;
				description: string;
				content: string;
				tags?: string[];
			}>(
				server,
				ctx,
				"gadget.put-gadget",
				(args) => {
					const input = GadgetInputSchema.parse({
						source: "generated",
						tags: [],
						...args,
					});
					assertGadgetShape(input.content);
					const res = ctx.repo.put(input);
					return structured({
						id: res.gadget.id,
						version: res.version,
						created: res.created,
					});
				},
				(args) => args.id,
			),
		);
	}

	if (isToolAllowed(role, "gadget.rename-gadget")) {
		server.registerTool(
			"gadget.rename-gadget",
			{
				title: "Rename gadget",
				description:
					"Rename a gadget. The old id is preserved as an alias so existing compose chains and saved prompts keep resolving. Fails if `newId` collides with another gadget or an existing alias.",
				inputSchema: {
					id: GadgetIdParam.describe("Current gadget id or alias to rename."),
					newId: z.string().min(1).describe("New id (lowercase kebab-case, unique, ≤64 chars)."),
				},
				outputSchema: {
					id: z.string(),
					previousName: z.string().describe("The id this gadget had before the rename."),
					aliases: z.array(z.string()).describe("All aliases currently resolving to this gadget."),
				},
				annotations: {
					readOnlyHint: false,
					destructiveHint: false,
					idempotentHint: false,
					openWorldHint: false,
				},
			},
			wrapHandler<{ id: string; newId: string }>(
				server,
				ctx,
				"gadget.rename-gadget",
				(args) => {
					const res = ctx.repo.rename(args.id, args.newId);
					return structured({
						id: res.gadget.id,
						previousName: res.previousName,
						aliases: ctx.repo.aliasesOf(res.gadget.id),
					});
				},
				(args) => args.id,
			),
		);
	}

	if (isToolAllowed(role, "gadget.rollback-gadget")) {
		server.registerTool(
			"gadget.rollback-gadget",
			{
				title: "Rollback gadget",
				description:
					"Roll the live gadget back to a prior revision by copying the older snapshot's content/title/description/tags forward as a brand-new revision. History is preserved — the rolled-past revisions stay listed.",
				inputSchema: {
					id: GadgetIdParam.describe("Gadget id or alias."),
					toVersion: z
						.number()
						.int()
						.positive()
						.describe(
							"Target revision number to restore. See `list-revisions` for available versions.",
						),
				},
				outputSchema: {
					id: z.string(),
					newVersion: z
						.number()
						.int()
						.positive()
						.describe("The version number assigned to the rollback revision."),
				},
				annotations: {
					readOnlyHint: false,
					destructiveHint: false,
					idempotentHint: false,
					openWorldHint: false,
				},
			},
			wrapHandler<{ id: string; toVersion: number }>(
				server,
				ctx,
				"gadget.rollback-gadget",
				(args) => {
					const res = ctx.repo.rollback(args.id, args.toVersion);
					return structured({ id: res.gadget.id, newVersion: res.newVersion });
				},
				(args) => args.id,
			),
		);
	}

	if (isToolAllowed(role, "gadget.list-revisions")) {
		server.registerTool(
			"gadget.list-revisions",
			{
				title: "List revisions",
				description:
					"List immutable revision snapshots for a gadget (newest first). Each revision captures title/description/content/tags at the time of the write; use `rollback-gadget` with one of these `version` numbers to restore.",
				inputSchema: { id: GadgetIdParam },
				outputSchema: { revisions: z.array(z.object(RevisionSummaryOutput)) },
				annotations: {
					readOnlyHint: true,
					idempotentHint: true,
					openWorldHint: false,
				},
			},
			wrapHandler<{ id: string }>(
				server,
				ctx,
				"gadget.list-revisions",
				(args) => {
					return structured({
						revisions: ctx.repo.listRevisions(args.id).map((r) => ({
							version: r.version,
							createdAt: r.createdAt,
							title: r.title,
							description: r.description,
						})),
					});
				},
				(args) => args.id,
			),
		);
	}

	if (isToolAllowed(role, "gadget.delete-gadget")) {
		server.registerTool(
			"gadget.delete-gadget",
			{
				title: "Delete gadget",
				description:
					"Delete a gadget and cascade its revisions and aliases. DESTRUCTIVE and NOT RECOVERABLE from within this server (you'd need an external NDJSON backup). Confirm intent before calling.",
				inputSchema: { id: GadgetIdParam },
				outputSchema: {
					deleted: z
						.boolean()
						.describe("Always true on success; failure surfaces as a `gadget.notFound` error."),
				},
				annotations: {
					readOnlyHint: false,
					destructiveHint: true,
					idempotentHint: true,
					openWorldHint: false,
				},
			},
			wrapHandler<{ id: string }>(
				server,
				ctx,
				"gadget.delete-gadget",
				(args) => {
					ctx.repo.delete(args.id);
					return structured({ deleted: true });
				},
				(args) => args.id,
			),
		);
	}

	if (isToolAllowed(role, "gadget.compose-prompt")) {
		server.registerTool(
			"gadget.compose-prompt",
			{
				title: "Compose a finished system prompt from gadget ids",
				description:
					"Stitch the chosen prompt gadgets into a single, paste-ready system prompt. This is the ANSWER tool when the user asks for 'a system prompt for X', 'a persona that Y', 'a reviewer template that Z', etc. Order of gadgetIds is load-bearing; pass them in canonical order (role \u2192 context \u2192 task \u2192 constraint \u2192 format \u2192 example \u2192 reasoning \u2192 tone \u2192 caveat) or set useCanonicalOrder=true to let the server reorder. Unknown ids surface as `gadget.composeMissingIds` with the bad ids.",
				inputSchema: {
					gadgetIds: z
						.array(z.string())
						.min(1)
						.describe(
							"Gadget ids or aliases to compose. Order is preserved unless `useCanonicalOrder` is true.",
						),
					separator: z
						.string()
						.optional()
						.describe("Joiner between gadget bodies. Defaults to a blank line (\\n\\n)."),
					useCanonicalOrder: z
						.boolean()
						.optional()
						.describe(
							"When true, the server groups ids by category and emits them in canonical order (role → context → task → constraint → format → example → reasoning → tone → caveat).",
						),
				},
				outputSchema: {
					prompt: z.string().describe("Final composed system prompt, ready to paste."),
					chain: z
						.array(z.object(ComposeChainItemOutput))
						.describe("The gadgets that contributed, in the final output order."),
				},
				annotations: {
					readOnlyHint: true,
					idempotentHint: true,
					openWorldHint: false,
				},
			},
			wrapHandler<{
				gadgetIds: string[];
				separator?: string;
				useCanonicalOrder?: boolean;
			}>(server, ctx, "gadget.compose-prompt", (args) => {
				let ids = args.gadgetIds;
				if (args.useCanonicalOrder === true) {
					const byCategory = new Map<string, string[]>();
					for (const id of ids) {
						const g = ctx.repo.resolve(id);
						if (g !== null) {
							const list = byCategory.get(g.category) ?? [];
							list.push(g.id);
							byCategory.set(g.category, list);
						}
					}
					ids = COMPOSE_ORDER.flatMap((cat) => byCategory.get(cat) ?? []);
				}
				const composed = ctx.repo.compose(ids, args.separator ?? "\n\n");
				return structured({
					prompt: composed.prompt,
					chain: composed.chain.map((g) => ({
						id: g.id,
						category: g.category,
						title: g.title,
					})),
				});
			}),
		);
	}

	if (isToolAllowed(role, "gadget.project-kickoff")) {
		server.registerTool(
			"gadget.project-kickoff",
			{
				title: "Interactive project kickoff wizard",
				description:
					"Drive a 5-step MCP elicitation flow (basics → type → runtime+quality → integrations → preview) to compose a paste-ready project kickoff prompt from the gadget library. Use this when the user says 'kick off a new project', 'help me start a new <tool>', or similar. Requires a client that supports MCP elicitation (Claude Code v2.1+). When `GADGET_KICKOFF_EXEC` is set, the `execute` action spawns that command in the target path with the composed prompt on stdin; otherwise 'execute' falls back to 'return'.",
				outputSchema: {
					prompt: z.string().describe("The composed kickoff paragraph, ready to paste."),
					chain: z
						.array(
							z.object({
								id: z.string(),
								category: CategoryEnum,
								title: z.string(),
							}),
						)
						.describe("Gadget ids that contributed to the chain, in canonical order."),
					action: z
						.enum(["returned", "dispatch-now", "plan-first", "sampled", "cancelled"])
						.describe(
							"`returned` = plain tool result (LLM reads + decides); `dispatch-now` = user approved Task dispatch at the wizard — LLM must call its Task tool now without re-confirming; `plan-first` = user approved a planning Task (blueprint only); `sampled` = server called sampling/createMessage and surfaces the host-model response; `cancelled` = user bailed.",
						),
					dispatchHint: z
						.string()
						.optional()
						.describe(
							"Present when action=dispatch-now or plan-first. Imperative instruction for the calling LLM — the user has already confirmed at the wizard's preview step, so the LLM should act without re-asking.",
						),
					sampled: z
						.object({ text: z.string() })
						.optional()
						.describe(
							"Present when action=sampled. Contains the host LLM's response to the composed prompt.",
						),
				},
				annotations: {
					readOnlyHint: false,
					destructiveHint: false,
					idempotentHint: false,
					openWorldHint: false,
				},
			},
			wrapHandler<Record<string, never>>(
				server,
				ctx,
				"gadget.project-kickoff",
				async (_args, extra) => {
					// Drip progress notifications so the caller's
					// `resetTimeoutOnProgress` doesn't kill the tool call while the
					// user fills the multi-step elicitation wizard.
					const stopHeartbeat = startProgressHeartbeat(extra);
					try {
						const timeoutMs = resolveElicitTimeoutMs(Bun.env.GADGET_KICKOFF_TIMEOUT_MS);
						const result = await runKickoff(
							mcpRunner(server, timeoutMs),
							ctx.repo,
							async (prompt) => {
								const res = await server.server.createMessage(
									{
										messages: [{ role: "user", content: { type: "text", text: prompt } }],
										maxTokens: 2048,
									},
									{ timeout: timeoutMs },
								);
								if (res.content.type === "text") return res.content.text;
								return "(non-text sampling response)";
							},
						);
						const structuredValue: Record<string, unknown> = {
							prompt: result.prompt,
							chain: result.chain,
							action: result.action,
							...(result.dispatchHint !== undefined ? { dispatchHint: result.dispatchHint } : {}),
							...(result.sampled !== undefined ? { sampled: result.sampled } : {}),
						};
						// Prefix an imperative top-line so the calling LLM reads the
						// user's confirmed-at-the-wizard intent before the JSON payload
						// — this suppresses the default ask-before-Task-dispatch safety
						// habit on dispatch-now / plan-first.
						const topLine = renderTopLineInstruction({
							action: result.action,
							...(result.path !== undefined ? { path: result.path } : {}),
						});
						return {
							content: [
								{ type: "text", text: topLine },
								{ type: "text", text: JSON.stringify(structuredValue, null, 2) },
							],
							structuredContent: structuredValue,
						};
					} catch (err) {
						throw gadgetMcpError({
							code: GADGET_ERROR_CODES.InvalidGadget,
							message: `project-kickoff failed: ${(err as Error).message}. If your client does not support MCP elicitation, the wizard cannot run here.`,
						});
					} finally {
						stopHeartbeat();
					}
				},
			),
		);
	}

	if (isToolAllowed(role, "gadget.export-gadgets")) {
		server.registerTool(
			"gadget.export-gadgets",
			{
				title: "Export gadgets (NDJSON)",
				description:
					"Export the live gadget library as newline-delimited JSON, one gadget per line. Useful for backups or porting to another workspace. Set `includeHistory` to also emit revision snapshots.",
				inputSchema: {
					includeHistory: z
						.boolean()
						.optional()
						.describe("When true, include all prior revisions (one extra line per revision)."),
					category: CategoryEnum.optional().describe("Limit export to gadgets in one slot."),
				},
				outputSchema: {
					ndjson: z.string().describe("The NDJSON payload (may be empty if no gadgets match)."),
					count: z.number().int().nonnegative().describe("Number of lines emitted."),
				},
				annotations: {
					readOnlyHint: true,
					idempotentHint: true,
					openWorldHint: false,
				},
			},
			wrapHandler<{ includeHistory?: boolean; category?: z.infer<typeof CategoryEnum> }>(
				server,
				ctx,
				"gadget.export-gadgets",
				async (args, extra) => {
					const ndjson = await exportNdjson(ctx.repo, {
						...(args.includeHistory !== undefined ? { includeHistory: args.includeHistory } : {}),
						...(args.category !== undefined ? { category: args.category } : {}),
						...(extra.signal !== undefined ? { signal: extra.signal } : {}),
					});
					const count = ndjson === "" ? 0 : ndjson.split("\n").length;
					return structured({ ndjson, count });
				},
			),
		);
	}

	if (isToolAllowed(role, "gadget.import-gadgets")) {
		server.registerTool(
			"gadget.import-gadgets",
			{
				title: "Import gadgets (NDJSON)",
				description:
					"Import gadgets from a newline-delimited JSON payload (the format `export-gadgets` emits). `conflict` controls id collisions.",
				inputSchema: {
					ndjson: z
						.string()
						.min(1)
						.describe("NDJSON payload; one gadget per line (same shape as the export output)."),
					conflict: z
						.enum(["skip", "overwrite", "error"])
						.optional()
						.describe(
							"`skip` (default) keeps existing gadgets; `overwrite` writes a new revision; `error` fails the whole import on the first collision.",
						),
				},
				outputSchema: {
					imported: z.number().int().nonnegative().describe("Newly created gadgets."),
					overwritten: z
						.number()
						.int()
						.nonnegative()
						.describe("Existing gadgets updated in place."),
					skipped: z.number().int().nonnegative(),
					errors: z
						.array(z.string())
						.describe(
							"Per-line errors (malformed JSON, id collisions under `error` policy, etc.).",
						),
				},
				annotations: {
					readOnlyHint: false,
					destructiveHint: false,
					idempotentHint: false,
					openWorldHint: false,
				},
			},
			wrapHandler<{ ndjson: string; conflict?: "skip" | "overwrite" | "error" }>(
				server,
				ctx,
				"gadget.import-gadgets",
				async (args, extra) => {
					const total = args.ndjson.split("\n").filter((l) => l.trim() !== "").length;
					await emitProgress(extra, 0, total);
					const res = importNdjson(ctx.repo, args.ndjson, args.conflict ?? "skip");
					await emitProgress(extra, total, total);
					return structured({
						imported: res.imported,
						overwritten: res.overwritten,
						skipped: res.skipped,
						errors: res.errors,
					});
				},
			),
		);
	}

	if (isToolAllowed(role, "gadget.list-runners")) {
		server.registerTool(
			"gadget.list-runners",
			{
				title: "List reviewer runners",
				description:
					"List configured reviewer runners (external review commands — claude, codex, gemini, or local scripts). Use alongside `run-reviewer` to feed a composed prompt through one of them.",
				outputSchema: { runners: z.array(z.object(RunnerOutput)) },
				annotations: {
					readOnlyHint: true,
					idempotentHint: true,
					openWorldHint: false,
				},
			},
			wrapHandler<Record<string, never>>(server, ctx, "gadget.list-runners", () =>
				structured({ runners: ctx.runnerRepo.list() }),
			),
		);
	}

	if (isToolAllowed(role, "gadget.list-client-roots")) {
		server.registerTool(
			"gadget.list-client-roots",
			{
				title: "List client-advertised filesystem roots",
				description:
					"Query the connected MCP client for its advertised filesystem roots (MCP `roots/list`). Returns an empty list when the client does not support roots. Used as an observability signal; gadget-mcp does not constrain its own storage based on the result.",
				outputSchema: {
					roots: z
						.array(z.unknown())
						.describe("Raw MCP Root entries as reported by the client, or [] if unsupported."),
					supported: z
						.boolean()
						.describe("True when the client responded to `roots/list`; false otherwise."),
				},
				annotations: {
					readOnlyHint: true,
					idempotentHint: true,
					openWorldHint: false,
				},
			},
			wrapHandler<Record<string, never>>(
				server,
				ctx,
				"gadget.list-client-roots",
				async (_args, extra) => {
					if (typeof extra.sendRequest !== "function") {
						return structured({ roots: [], supported: false });
					}
					try {
						const res = (await extra.sendRequest(
							{ method: "roots/list" },
							ListRootsResultSchema,
						)) as { roots: unknown };
						const roots = Array.isArray(res.roots) ? res.roots : [];
						return structured({ roots, supported: true });
					} catch {
						return structured({ roots: [], supported: false });
					}
				},
			),
		);
	}

	if (isToolAllowed(role, "gadget.upsert-runner")) {
		server.registerTool(
			"gadget.upsert-runner",
			{
				title: "Upsert reviewer runner",
				description:
					"Create or update a reviewer runner definition. A runner is an external process (argv array) the server can invoke via `run-reviewer` to review a prompt. `command[0]` must resolve on PATH.",
				inputSchema: {
					id: z
						.string()
						.min(1)
						.describe("Stable identifier for this runner (e.g. `claude`, `codex`, `gemini`)."),
					name: z.string().min(1).describe("Human-readable display name."),
					command: z
						.array(z.string())
						.min(1)
						.describe(
							"Argv for the reviewer process, first element is the executable (no shell expansion).",
						),
					enabled: z
						.boolean()
						.optional()
						.describe(
							"When false, `run-reviewer` refuses to execute this runner. Defaults to true.",
						),
					timeoutSeconds: z
						.number()
						.int()
						.positive()
						.optional()
						.describe("Max wall-clock seconds per run. Omit to use server default (180s)."),
				},
				outputSchema: { id: z.string() },
				annotations: {
					readOnlyHint: false,
					destructiveHint: false,
					idempotentHint: true,
					openWorldHint: false,
				},
			},
			wrapHandler<{
				id: string;
				name: string;
				command: string[];
				enabled?: boolean;
				timeoutSeconds?: number;
			}>(server, ctx, "gadget.upsert-runner", (args) => {
				ctx.runnerRepo.upsert({
					id: args.id,
					name: args.name,
					command: args.command,
					enabled: args.enabled ?? true,
					timeoutSeconds: args.timeoutSeconds ?? null,
				});
				return structured({ id: args.id });
			}),
		);
	}

	if (isToolAllowed(role, "gadget.delete-runner")) {
		server.registerTool(
			"gadget.delete-runner",
			{
				title: "Delete reviewer runner",
				description:
					"Delete a reviewer runner definition. Running reviews are not affected; future `run-reviewer` calls for this id will fail with `gadget.runnerMissing`.",
				inputSchema: {
					id: z.string().min(1).describe("Runner id to remove."),
				},
				outputSchema: {
					deleted: z
						.boolean()
						.describe("True when a row was removed; false if the id did not exist."),
				},
				annotations: {
					readOnlyHint: false,
					destructiveHint: true,
					idempotentHint: true,
					openWorldHint: false,
				},
			},
			wrapHandler<{ id: string }>(server, ctx, "gadget.delete-runner", (args) =>
				structured({ deleted: ctx.runnerRepo.delete(args.id) }),
			),
		);
	}

	if (isToolAllowed(role, "gadget.run-reviewer")) {
		server.registerTool(
			"gadget.run-reviewer",
			{
				title: "Run reviewer runner",
				description:
					"Execute a reviewer runner against a prompt. The runner subprocess receives `prompt` on stdin and its stdout/stderr are returned. Respects the caller's AbortSignal and enforces a wall-clock timeout.",
				inputSchema: {
					runnerId: z
						.string()
						.min(1)
						.describe("Id of a previously-upserted runner (see `list-runners`)."),
					prompt: z.string().min(1).describe("Prompt text to pipe into the runner's stdin."),
					timeoutSeconds: z
						.number()
						.int()
						.positive()
						.optional()
						.describe("Per-call override of the runner's configured timeout."),
				},
				outputSchema: {
					runnerId: z.string(),
					status: z
						.string()
						.describe("One of `ok`, `timeout`, `exited`, `error` — see docs for semantics."),
					exitCode: z.number().int().nullable().describe("Process exit code, or null on timeout."),
					output: z.string().describe("Captured stdout."),
					stderr: z.string().describe("Captured stderr."),
					durationMs: z.number().int().nonnegative(),
				},
				annotations: {
					readOnlyHint: false,
					destructiveHint: false,
					idempotentHint: false,
					openWorldHint: true,
				},
			},
			wrapHandler<{ runnerId: string; prompt: string; timeoutSeconds?: number }>(
				server,
				ctx,
				"gadget.run-reviewer",
				async (args, extra) => {
					const runner = ctx.runnerRepo.get(args.runnerId);
					if (runner === null) {
						throw gadgetMcpError({
							code: GADGET_ERROR_CODES.RunnerMissing,
							message: `reviewer runner not found: ${args.runnerId}`,
							data: { runnerId: args.runnerId },
						});
					}
					const res = await executeReviewerRun({
						runner,
						promptText: args.prompt,
						timeoutSeconds: args.timeoutSeconds ?? runner.timeoutSeconds ?? 180,
						...(extra.signal !== undefined ? { signal: extra.signal } : {}),
					});
					return structured({
						runnerId: res.runnerId,
						status: res.status,
						exitCode: res.exitCode,
						output: res.output,
						stderr: res.stderr,
						durationMs: res.durationMs,
					});
				},
			),
		);
	}
}
