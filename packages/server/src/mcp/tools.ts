import {
	type AuditWriter,
	COMPOSE_ORDER,
	executeReviewerRun,
	exportNdjson,
	GadgetCategorySchema,
	GadgetInputSchema,
	type GadgetMetrics,
	type GadgetRepo,
	importNdjson,
	type ReviewerRunnerRepo,
} from "@gadget/core";
import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type CallToolResult, ListRootsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { type Role, roleAllows, TOOL_REQUIRED_ROLES } from "./auth.ts";
import { GADGET_ERROR_CODES, gadgetMcpError, resultCodeOf, toMcpError } from "./errors.ts";

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

function jsonContent(value: unknown): CallToolResult["content"] {
	return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}

function structured(value: Record<string, unknown>): CallToolResult {
	return { content: jsonContent(value), structuredContent: value };
}

const GadgetIdParam = z.string().min(1);
const CategoryEnum = GadgetCategorySchema;

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

export function registerTools(server: McpServer, ctx: ToolContext): void {
	const role = ctx.role;

	if (isToolAllowed(role, "gadget.list-gadgets")) {
		server.registerTool(
			"gadget.list-gadgets",
			{
				title: "List reusable prompt gadgets",
				description:
					"Browse the library of reusable prompt components (role, context, task, constraint, format, example, reasoning, tone, caveat). Call this first when a user asks you to build or author a system prompt / persona / reviewer template. Keyset-paginated; filter by category to narrow.",
				inputSchema: {
					category: CategoryEnum.optional(),
					limit: z.number().int().positive().max(200).optional(),
					cursor: z.string().optional(),
				},
				annotations: { readOnlyHint: true, idempotentHint: true },
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
					items: page.items,
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
					"Full-text search (BM25 over FTS5) across gadget id, title, description, content, and tags. Use this to find relevant prompt components when the user's ask names a domain, persona, or workflow keyword.",
				inputSchema: {
					query: z.string().min(1),
					category: CategoryEnum.optional(),
					limit: z.number().int().positive().max(200).optional(),
					cursor: z.string().optional(),
				},
				annotations: { readOnlyHint: true, idempotentHint: true },
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
				return structured({ items: page.items, nextCursor: page.nextCursor });
			}),
		);
	}

	if (isToolAllowed(role, "gadget.get-gadget")) {
		server.registerTool(
			"gadget.get-gadget",
			{
				title: "Get gadget",
				description: "Retrieve the full gadget (including content) by id or alias.",
				inputSchema: { id: GadgetIdParam },
				annotations: { readOnlyHint: true, idempotentHint: true },
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
		category: CategoryEnum,
		title: z.string().min(1).max(200),
		description: z.string().min(1).max(500),
		content: z.string().min(1),
		tags: z.array(z.string()).optional(),
	};

	if (isToolAllowed(role, "gadget.add-gadget")) {
		server.registerTool(
			"gadget.add-gadget",
			{
				title: "Add gadget",
				description: "Add a new gadget. Fails if id already exists.",
				inputSchema: AddInputSchema,
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
				description: "Create or update a gadget; always writes a new revision.",
				inputSchema: AddInputSchema,
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
				description: "Rename a gadget; the old id is preserved as an alias.",
				inputSchema: { id: GadgetIdParam, newId: GadgetIdParam },
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
				description: "Roll the live gadget back to a prior revision (creates a new revision).",
				inputSchema: { id: GadgetIdParam, toVersion: z.number().int().positive() },
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
				description: "List immutable revision snapshots for a gadget, newest first.",
				inputSchema: { id: GadgetIdParam },
				annotations: { readOnlyHint: true },
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
				description: "Delete a gadget and cascade revisions and aliases.",
				inputSchema: { id: GadgetIdParam },
				annotations: { destructiveHint: true },
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
					gadgetIds: z.array(z.string()).min(1),
					separator: z.string().optional(),
					useCanonicalOrder: z.boolean().optional(),
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

	if (isToolAllowed(role, "gadget.export-gadgets")) {
		server.registerTool(
			"gadget.export-gadgets",
			{
				title: "Export gadgets (NDJSON)",
				description: "Export library as NDJSON with optional revision history.",
				inputSchema: {
					includeHistory: z.boolean().optional(),
					category: CategoryEnum.optional(),
				},
				annotations: { readOnlyHint: true },
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
				description: "Import from NDJSON with conflict policy skip|overwrite|error.",
				inputSchema: {
					ndjson: z.string().min(1),
					conflict: z.enum(["skip", "overwrite", "error"]).optional(),
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
				description: "List configured reviewer runners.",
				annotations: { readOnlyHint: true, idempotentHint: true },
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
				annotations: { readOnlyHint: true, idempotentHint: true },
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
				description: "Create or update a reviewer runner definition.",
				inputSchema: {
					id: z.string().min(1),
					name: z.string().min(1),
					command: z.array(z.string()).min(1),
					enabled: z.boolean().optional(),
					timeoutSeconds: z.number().int().positive().optional(),
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
				description: "Delete a reviewer runner definition.",
				inputSchema: { id: z.string() },
				annotations: { destructiveHint: true },
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
				description: "Execute a reviewer runner against a prompt.",
				inputSchema: {
					runnerId: z.string(),
					prompt: z.string().min(1),
					timeoutSeconds: z.number().int().positive().optional(),
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
