import { GADGET_CATEGORIES, type GadgetRepo, type ReviewerRunnerRepo } from "@gadget/core";

/**
 * Centralized completion helpers wired into both resource templates and
 * prompt arguments. The MCP spec caps a single completion response at 100
 * values; we intentionally keep our cap tighter so the UI stays snappy.
 */
export const DEFAULT_COMPLETION_LIMIT = 20;

function asLower(value: string | undefined): string {
	return typeof value === "string" ? value.toLowerCase() : "";
}

function prefixOrSubstring(haystack: string, needle: string): boolean {
	if (needle === "") return true;
	const h = haystack.toLowerCase();
	const n = needle.toLowerCase();
	return h.startsWith(n) || h.includes(n);
}

export function completeGadgetId(
	repo: GadgetRepo,
	value: string,
	limit: number = DEFAULT_COMPLETION_LIMIT,
): string[] {
	const needle = asLower(value);
	const out: string[] = [];
	for (const item of repo.list({ limit: 200 }).items) {
		if (prefixOrSubstring(item.id, needle)) out.push(item.id);
		if (out.length >= limit) break;
	}
	if (out.length < limit) {
		for (const alias of repo.list({ limit: 200 }).items.flatMap((s) => repo.aliasesOf(s.id))) {
			if (out.includes(alias)) continue;
			if (prefixOrSubstring(alias, needle)) out.push(alias);
			if (out.length >= limit) break;
		}
	}
	return out;
}

export function completeCategory(value: string): string[] {
	const needle = asLower(value);
	return GADGET_CATEGORIES.filter((c) => c.startsWith(needle));
}

export function completeRunnerId(
	runners: ReviewerRunnerRepo,
	value: string,
	limit: number = DEFAULT_COMPLETION_LIMIT,
): string[] {
	const needle = asLower(value);
	const ids = runners.list().map((r) => r.id);
	return ids.filter((id) => prefixOrSubstring(id, needle)).slice(0, limit);
}

export function completeTag(
	repo: GadgetRepo,
	value: string,
	limit: number = DEFAULT_COMPLETION_LIMIT,
): string[] {
	const needle = asLower(value);
	const seen = new Set<string>();
	for (const item of repo.list({ limit: 500 }).items) {
		for (const tag of item.tags) {
			if (seen.has(tag)) continue;
			if (prefixOrSubstring(tag, needle)) {
				seen.add(tag);
				if (seen.size >= limit) return [...seen];
			}
		}
	}
	return [...seen];
}
