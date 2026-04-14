import { GadgetInputSchema, GadgetSchema } from "../domain/gadget.ts";
import type { GadgetRepo } from "../repo/gadget-repo.ts";

export type ConflictPolicy = "skip" | "overwrite" | "error";

export interface ExportOptions {
	readonly includeHistory?: boolean;
	readonly category?: string;
	readonly signal?: AbortSignal;
}

export class ExportCancelledError extends Error {
	override readonly name = "ExportCancelledError";
	constructor() {
		super("export cancelled by caller");
	}
}

export async function exportNdjson(repo: GadgetRepo, opts: ExportOptions = {}): Promise<string> {
	const lines: string[] = [];
	let cursor: string | null = null;
	do {
		if (opts.signal?.aborted) throw new ExportCancelledError();
		const input: Parameters<GadgetRepo["list"]>[0] = {
			limit: 100,
			...(cursor !== null ? { cursor } : {}),
		};
		if (opts.category !== undefined) {
			(input as Record<string, unknown>).category = opts.category;
		}
		const page = repo.list(input);
		for (const summary of page.items) {
			if (opts.signal?.aborted) throw new ExportCancelledError();
			const full = repo.getById(summary.id);
			if (full === null) continue;
			const out: Record<string, unknown> = {
				id: full.id,
				category: full.category,
				title: full.title,
				description: full.description,
				content: full.content,
				tags: full.tags,
				source: full.source,
				createdAt: full.createdAt,
				updatedAt: full.updatedAt,
			};
			if (opts.includeHistory === true) {
				out._revisions = repo.listRevisions(full.id);
			}
			lines.push(JSON.stringify(out));
		}
		cursor = page.nextCursor;
	} while (cursor !== null);
	return lines.join("\n");
}

export interface ImportResult {
	readonly imported: number;
	readonly overwritten: number;
	readonly skipped: number;
	readonly errors: readonly { line: number; message: string }[];
}

export function importNdjson(
	repo: GadgetRepo,
	ndjson: string,
	conflict: ConflictPolicy = "skip",
): ImportResult {
	let imported = 0;
	let overwritten = 0;
	let skipped = 0;
	const errors: { line: number; message: string }[] = [];
	const lines = ndjson.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i]?.trim() ?? "";
		if (raw === "") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (err) {
			errors.push({ line: i + 1, message: (err as Error).message });
			continue;
		}
		const result = GadgetInputSchema.safeParse(parsed);
		if (!result.success) {
			errors.push({ line: i + 1, message: result.error.message });
			continue;
		}
		const input = result.data;
		const existing = repo.getById(input.id);
		if (existing !== null) {
			if (conflict === "skip") {
				skipped++;
				continue;
			}
			if (conflict === "error") {
				errors.push({ line: i + 1, message: `conflict: gadget ${input.id} already exists` });
				continue;
			}
		}
		try {
			repo.put(input);
			if (existing !== null) overwritten++;
			else imported++;
		} catch (err) {
			errors.push({ line: i + 1, message: (err as Error).message });
		}
	}
	return { imported, overwritten, skipped, errors };
}

export function _roundtripCheck(payload: unknown): boolean {
	return GadgetSchema.safeParse(payload).success;
}
