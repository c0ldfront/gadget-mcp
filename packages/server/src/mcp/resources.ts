import {
	GADGET_CATEGORIES,
	type GadgetRepo,
	type ReviewerRunnerRepo,
	toListItem,
} from "@gadget/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { completeCategory, completeGadgetId, completeRunnerId, completeTag } from "./completers.ts";

export interface ResourceContext {
	readonly repo: GadgetRepo;
	readonly runnerRepo: ReviewerRunnerRepo;
}

function jsonResource(
	uri: URL | string,
	data: unknown,
): {
	contents: { uri: string; mimeType: string; text: string }[];
} {
	const asString = typeof uri === "string" ? uri : uri.toString();
	return {
		contents: [
			{
				uri: asString,
				mimeType: "application/json",
				text: JSON.stringify(data, null, 2),
			},
		],
	};
}

function firstVar(vars: Record<string, string | string[]>, key: string): string | undefined {
	const raw = vars[key];
	if (raw === undefined) return undefined;
	return Array.isArray(raw) ? raw[0] : raw;
}

export function registerResources(server: McpServer, ctx: ResourceContext): void {
	server.registerResource(
		"all-gadgets",
		"gadget://gadgets/all",
		{
			title: "All gadgets",
			description: "Summary of every gadget in the library (no content payload).",
			mimeType: "application/json",
		},
		(uri) => jsonResource(uri, { items: ctx.repo.list({ limit: 200 }).items.map(toListItem) }),
	);

	server.registerResource(
		"categories",
		"gadget://categories",
		{
			title: "Gadget categories",
			description: "The canonical nine prompt categories.",
			mimeType: "application/json",
		},
		(uri) => jsonResource(uri, { categories: GADGET_CATEGORIES }),
	);

	server.registerResource(
		"canonical-chain",
		"gadget://compose/canonical",
		{
			title: "Canonical gadget chain",
			description:
				"Most-recently-updated gadget per category, ordered by the canonical compose order.",
			mimeType: "application/json",
		},
		(uri) =>
			jsonResource(uri, {
				chain: ctx.repo.canonicalChain().map((g) => ({
					id: g.id,
					category: g.category,
					title: g.title,
				})),
			}),
	);

	server.registerResource(
		"gadget",
		new ResourceTemplate("gadget://gadget/{id}", {
			list: () => ({
				resources: ctx.repo.list({ limit: 200 }).items.map((s) => ({
					uri: `gadget://gadget/${s.id}`,
					name: s.id,
					description: s.title,
					mimeType: "application/json",
				})),
			}),
			complete: {
				id: (value) => completeGadgetId(ctx.repo, value),
			},
		}),
		{
			title: "Single gadget",
			description: "Full JSON for one gadget, resolvable via id or alias.",
			mimeType: "application/json",
		},
		(uri, vars) => {
			const id = firstVar(vars, "id");
			const g = id === undefined ? null : ctx.repo.resolve(id);
			return jsonResource(uri, { gadget: g });
		},
	);

	server.registerResource(
		"gadgets-by-category",
		new ResourceTemplate("gadget://gadgets/category/{category}", {
			list: () => ({
				resources: GADGET_CATEGORIES.map((c) => ({
					uri: `gadget://gadgets/category/${c}`,
					name: c,
					description: `All gadgets in category ${c}`,
					mimeType: "application/json",
				})),
			}),
			complete: {
				category: (value) => completeCategory(value),
			},
		}),
		{
			title: "Gadgets by category",
			description: "Summaries of all gadgets in a category.",
			mimeType: "application/json",
		},
		(uri, vars) => {
			const raw = firstVar(vars, "category");
			const cat =
				raw !== undefined && (GADGET_CATEGORIES as readonly string[]).includes(raw) ? raw : null;
			if (cat === null) return jsonResource(uri, { items: [] });
			return jsonResource(uri, {
				items: ctx.repo
					.list({ limit: 200, category: cat as (typeof GADGET_CATEGORIES)[number] })
					.items.map(toListItem),
			});
		},
	);

	server.registerResource(
		"gadgets-by-tag",
		new ResourceTemplate("gadget://gadgets/tag/{tag}", {
			list: () => ({
				resources: [],
			}),
			complete: {
				tag: (value) => completeTag(ctx.repo, value),
			},
		}),
		{
			title: "Gadgets by tag",
			description: "Gadgets whose tag list contains the given tag.",
			mimeType: "application/json",
		},
		(uri, vars) => {
			const tag = firstVar(vars, "tag");
			if (tag === undefined) return jsonResource(uri, { items: [] });
			const all = ctx.repo
				.list({ limit: 500 })
				.items.filter((s) => s.tags.includes(tag))
				.map(toListItem);
			return jsonResource(uri, { items: all });
		},
	);

	server.registerResource(
		"runner",
		new ResourceTemplate("gadget://runner/{id}", {
			list: () => ({
				resources: ctx.runnerRepo.list().map((r) => ({
					uri: `gadget://runner/${r.id}`,
					name: r.id,
					description: r.name,
					mimeType: "application/json",
				})),
			}),
			complete: {
				id: (value) => completeRunnerId(ctx.runnerRepo, value),
			},
		}),
		{
			title: "Reviewer runner",
			description: "Full JSON for a configured reviewer runner.",
			mimeType: "application/json",
		},
		(uri, vars) => {
			const id = firstVar(vars, "id");
			const runner = id === undefined ? null : ctx.runnerRepo.get(id);
			return jsonResource(uri, { runner });
		},
	);
}
