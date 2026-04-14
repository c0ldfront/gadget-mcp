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

export async function seedFromFiles(
	repo: GadgetRepo,
	runnerRepo: ReviewerRunnerRepo,
	opts: { gadgetsNdjsonPath: string; reviewerRunnersJsonPath: string },
): Promise<SeedSummary> {
	let gadgetsSeeded = 0;
	let runnersSeeded = 0;
	const gadgetsFile = Bun.file(opts.gadgetsNdjsonPath);
	if (await gadgetsFile.exists()) {
		const text = await gadgetsFile.text();
		for (const line of text.split("\n")) {
			const trimmed = line.trim();
			if (trimmed === "") continue;
			const raw: unknown = JSON.parse(trimmed);
			const parsed = GadgetInputSchema.parse(raw);
			if (repo.getById(parsed.id) === null) {
				repo.add(parsed);
				gadgetsSeeded++;
			}
		}
	}
	const runnersFile = Bun.file(opts.reviewerRunnersJsonPath);
	if (await runnersFile.exists()) {
		const raw: unknown = JSON.parse(await runnersFile.text());
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
				runnersSeeded++;
			}
		}
	}
	return { gadgetsSeeded, runnersSeeded };
}
