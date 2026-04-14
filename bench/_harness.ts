export interface BenchResult {
	readonly name: string;
	readonly p50Ms: number;
	readonly p95Ms: number;
	readonly p99Ms: number;
	readonly meanMs: number;
	readonly iterations: number;
}

export interface BenchOptions {
	readonly warmup?: number;
	readonly iterations: number;
}

export async function bench(
	name: string,
	fn: () => void | Promise<void>,
	opts: BenchOptions,
): Promise<BenchResult> {
	const warmup = opts.warmup ?? Math.min(50, Math.max(10, Math.floor(opts.iterations / 10)));
	for (let i = 0; i < warmup; i++) await fn();
	const samples = new Float64Array(opts.iterations);
	for (let i = 0; i < opts.iterations; i++) {
		const t0 = performance.now();
		await fn();
		samples[i] = performance.now() - t0;
	}
	samples.sort();
	const p50 = percentile(samples, 0.5);
	const p95 = percentile(samples, 0.95);
	const p99 = percentile(samples, 0.99);
	let sum = 0;
	for (let i = 0; i < samples.length; i++) sum += samples[i] ?? 0;
	const mean = sum / samples.length;
	return {
		name,
		p50Ms: round(p50),
		p95Ms: round(p95),
		p99Ms: round(p99),
		meanMs: round(mean),
		iterations: opts.iterations,
	};
}

function percentile(sorted: Float64Array, q: number): number {
	if (sorted.length === 0) return 0;
	const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
	return sorted[idx] ?? 0;
}

function round(v: number): number {
	return Math.round(v * 1000) / 1000;
}

export interface Baseline {
	readonly [name: string]: { readonly p50Ms: number; readonly p95Ms: number };
}

export interface RegressionFinding {
	readonly name: string;
	readonly metric: "p50" | "p95";
	readonly baseline: number;
	readonly current: number;
	readonly ratio: number;
}

export function detectRegressions(
	current: readonly BenchResult[],
	baseline: Baseline,
	thresholds: { readonly p50: number; readonly p95: number } = { p50: 1.2, p95: 1.5 },
): RegressionFinding[] {
	const findings: RegressionFinding[] = [];
	for (const r of current) {
		const base = baseline[r.name];
		if (base === undefined) continue;
		if (base.p50Ms > 0 && r.p50Ms / base.p50Ms > thresholds.p50) {
			findings.push({
				name: r.name,
				metric: "p50",
				baseline: base.p50Ms,
				current: r.p50Ms,
				ratio: r.p50Ms / base.p50Ms,
			});
		}
		if (base.p95Ms > 0 && r.p95Ms / base.p95Ms > thresholds.p95) {
			findings.push({
				name: r.name,
				metric: "p95",
				baseline: base.p95Ms,
				current: r.p95Ms,
				ratio: r.p95Ms / base.p95Ms,
			});
		}
	}
	return findings;
}
