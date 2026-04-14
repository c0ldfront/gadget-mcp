#!/usr/bin/env bun
import { readFile, writeFile } from "node:fs/promises";
import { buildGadgetMetrics, GadgetRepo, openMemoryDb } from "@gadget/core";
import { type Baseline, type BenchResult, bench, detectRegressions } from "./_harness.ts";

const BASELINE_PATH = "bench/baseline.json";

function seedRepo(repo: GadgetRepo, count: number): void {
	for (let i = 0; i < count; i++) {
		repo.add({
			id: `role-bench-${i.toString(16).padStart(6, "0")}`,
			category: "role",
			title: `Bench ${i}`,
			description: `bench seed ${i}`,
			content: `Content ${i} lorem ipsum dolor sit amet ${i % 7 === 0 ? "needle" : "haystack"}`,
			tags: ["bench", `shard-${i % 16}`],
			source: "generated",
		});
	}
}

async function main(): Promise<void> {
	const writeBaseline = process.argv.includes("--write-baseline");
	const db = openMemoryDb();
	const repo = new GadgetRepo(db);
	const metrics = buildGadgetMetrics(db);

	const putCount = 500;
	const put = await bench(
		"put@1k",
		() => {
			const i = Math.floor(Math.random() * 1e9);
			repo.put({
				id: `role-put-${i.toString(16)}`,
				category: "role",
				title: `T${i}`,
				description: "x",
				content: "lorem ipsum",
				tags: [],
				source: "generated",
			});
		},
		{ iterations: putCount },
	);

	seedRepo(repo, 10_000);

	const list = await bench(
		"list@10k_first_page",
		() => {
			repo.list({ limit: 25 });
		},
		{ iterations: 500 },
	);

	const search = await bench(
		"search@10k_needle",
		() => {
			repo.search({ query: "needle", limit: 25 });
		},
		{ iterations: 500 },
	);

	const metricsRender = await bench(
		"metrics_render",
		() => {
			metrics.registry.render();
		},
		{ iterations: 500 },
	);

	const results: BenchResult[] = [put, list, search, metricsRender];
	const report = Object.fromEntries(
		results.map((r) => [r.name, { p50Ms: r.p50Ms, p95Ms: r.p95Ms }]),
	);

	if (writeBaseline) {
		await writeFile(BASELINE_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
		process.stderr.write(`baseline written: ${BASELINE_PATH}\n`);
		return;
	}

	process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);

	let baseline: Baseline | null = null;
	try {
		baseline = JSON.parse(await readFile(BASELINE_PATH, "utf8")) as Baseline;
	} catch {
		process.stderr.write(`no baseline at ${BASELINE_PATH} (skipping regression gate)\n`);
	}
	if (baseline !== null) {
		const entryCount = Object.keys(baseline).length;
		if (entryCount === 0) {
			process.stderr.write(
				`baseline is empty — regression gate disabled until seeded from CI. ` +
					`See docs/benchmarks.md.\n`,
			);
		} else {
			const findings = detectRegressions(results, baseline);
			if (findings.length > 0) {
				process.stderr.write("regressions detected:\n");
				for (const f of findings) {
					process.stderr.write(
						`  ${f.name} ${f.metric}: ${f.current.toFixed(3)}ms vs ${f.baseline.toFixed(3)}ms (${f.ratio.toFixed(2)}x)\n`,
					);
				}
				process.exit(1);
			}
		}
	}
	db.close();
}

if (import.meta.main === true) {
	main().catch((err) => {
		process.stderr.write(`bench: ${(err as Error).message}\n`);
		process.exit(1);
	});
}
