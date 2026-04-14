import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { openMemoryDb } from "../db/connection.ts";
import { GadgetRepo } from "../repo/gadget-repo.ts";
import { ReviewerRunnerRepo } from "./reviewer-runner.ts";
import { seedFromFiles } from "./seed.ts";

test("seedFromFiles loads gadgets NDJSON and reviewer runners JSON", async () => {
	const dir = mkdtempSync(`${tmpdir()}/gadget-seed-`);
	try {
		await Bun.write(
			`${dir}/gadgets.ndjson`,
			[
				JSON.stringify({
					id: "role-a",
					category: "role",
					title: "A",
					description: "d",
					content: "hi",
					tags: ["a"],
					source: "curated",
				}),
				JSON.stringify({
					id: "tone-a",
					category: "tone",
					title: "B",
					description: "d",
					content: "hi2",
					tags: [],
					source: "curated",
				}),
			].join("\n"),
		);
		await Bun.write(
			`${dir}/runners.json`,
			JSON.stringify([{ id: "echo", name: "Echo", command: ["echo"], enabled: true }]),
		);
		const db = openMemoryDb();
		const repo = new GadgetRepo(db);
		const runnerRepo = new ReviewerRunnerRepo(db);
		const res = await seedFromFiles(repo, runnerRepo, {
			gadgetsNdjsonPath: `${dir}/gadgets.ndjson`,
			reviewerRunnersJsonPath: `${dir}/runners.json`,
		});
		expect(res.gadgetsSeeded).toBe(2);
		expect(res.runnersSeeded).toBe(1);
		const again = await seedFromFiles(repo, runnerRepo, {
			gadgetsNdjsonPath: `${dir}/gadgets.ndjson`,
			reviewerRunnersJsonPath: `${dir}/runners.json`,
		});
		expect(again.gadgetsSeeded).toBe(0);
		expect(again.runnersSeeded).toBe(0);
		db.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
