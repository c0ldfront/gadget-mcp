import type { Harness } from "../harness.ts";
import { claudeHarness } from "./claude.ts";
import { codexHarness } from "./codex.ts";

export const ALL_HARNESSES: readonly Harness[] = [claudeHarness, codexHarness];

export async function availableHarnesses(): Promise<readonly Harness[]> {
	const checks = await Promise.all(
		ALL_HARNESSES.map(async (h) => ({ h, ok: await h.isAvailable() })),
	);
	return checks.filter((r) => r.ok).map((r) => r.h);
}
