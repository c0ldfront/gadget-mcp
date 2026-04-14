import { GadgetInputSchema } from "../domain/gadget.ts";
import type { GadgetRepo } from "../repo/gadget-repo.ts";
import type { ReviewerRunnerRepo } from "./reviewer-runner.ts";

export interface SeedSummary {
	readonly gadgetsSeeded: number;
	readonly runnersSeeded: number;
}

interface ReviewerRunnerSeed {
	readonly id: string;
	readonly name: string;
	readonly command: readonly string[];
	readonly enabled: boolean;
	readonly timeoutSeconds?: number | null;
}

export interface SeedContent {
	readonly gadgetsNdjson?: string;
	readonly reviewerRunnersJson?: string;
}

export function seedGadgetsFromNdjson(repo: GadgetRepo, ndjson: string): number {
	let seeded = 0;
	for (const line of ndjson.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		const raw: unknown = JSON.parse(trimmed);
		const parsed = GadgetInputSchema.parse(raw);
		if (repo.getById(parsed.id) === null) {
			repo.add(parsed);
			seeded++;
		}
	}
	return seeded;
}

export function seedRunnersFromJson(runnerRepo: ReviewerRunnerRepo, json: string): number {
	let seeded = 0;
	const raw: unknown = JSON.parse(json);
	const list = Array.isArray(raw) ? (raw as ReviewerRunnerSeed[]) : [];
	for (const r of list) {
		if (runnerRepo.get(r.id) === null) {
			runnerRepo.upsert({
				id: r.id,
				name: r.name,
				command: r.command,
				enabled: r.enabled,
				timeoutSeconds: r.timeoutSeconds ?? null,
			});
			seeded++;
		}
	}
	return seeded;
}

export function seedFromContent(
	repo: GadgetRepo,
	runnerRepo: ReviewerRunnerRepo,
	content: SeedContent,
): SeedSummary {
	const gadgetsSeeded =
		content.gadgetsNdjson !== undefined && content.gadgetsNdjson.trim() !== ""
			? seedGadgetsFromNdjson(repo, content.gadgetsNdjson)
			: 0;
	const runnersSeeded =
		content.reviewerRunnersJson !== undefined && content.reviewerRunnersJson.trim() !== ""
			? seedRunnersFromJson(runnerRepo, content.reviewerRunnersJson)
			: 0;
	return { gadgetsSeeded, runnersSeeded };
}

export async function seedFromFiles(
	repo: GadgetRepo,
	runnerRepo: ReviewerRunnerRepo,
	opts: { gadgetsNdjsonPath: string; reviewerRunnersJsonPath: string },
): Promise<SeedSummary> {
	const content: { gadgetsNdjson?: string; reviewerRunnersJson?: string } = {};
	const gadgetsFile = Bun.file(opts.gadgetsNdjsonPath);
	if (await gadgetsFile.exists()) {
		content.gadgetsNdjson = await gadgetsFile.text();
	}
	const runnersFile = Bun.file(opts.reviewerRunnersJsonPath);
	if (await runnersFile.exists()) {
		content.reviewerRunnersJson = await runnersFile.text();
	}
	return seedFromContent(repo, runnerRepo, content);
}
