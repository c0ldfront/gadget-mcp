import { expect, test } from "bun:test";
import { bench, detectRegressions } from "./_harness.ts";

test("bench returns percentiles and respects iteration count", async () => {
	const res = await bench("noop", () => undefined, { iterations: 32, warmup: 4 });
	expect(res.name).toBe("noop");
	expect(res.iterations).toBe(32);
	expect(res.p50Ms).toBeGreaterThanOrEqual(0);
	expect(res.p95Ms).toBeGreaterThanOrEqual(res.p50Ms);
});

test("detectRegressions flags p50 and p95 breaches", () => {
	const findings = detectRegressions(
		[
			{ name: "a", p50Ms: 2, p95Ms: 3, p99Ms: 3, meanMs: 2, iterations: 10 },
			{ name: "b", p50Ms: 1, p95Ms: 1, p99Ms: 1, meanMs: 1, iterations: 10 },
		],
		{ a: { p50Ms: 1, p95Ms: 1.5 }, b: { p50Ms: 1, p95Ms: 1 } },
	);
	expect(findings.some((f) => f.name === "a" && f.metric === "p50")).toBe(true);
	expect(findings.some((f) => f.name === "a" && f.metric === "p95")).toBe(true);
	expect(findings.every((f) => f.name === "a")).toBe(true);
});
