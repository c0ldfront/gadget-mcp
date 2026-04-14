import type { Db } from "../db/connection.ts";

interface CounterDef {
	readonly help: string;
	readonly values: Map<string, number>;
}
interface HistogramDef {
	readonly help: string;
	readonly buckets: readonly number[];
	readonly series: Map<string, { sum: number; count: number; bucketCounts: number[] }>;
}
interface GaugeDef {
	readonly help: string;
	readonly read: () => number;
}

export interface MetricKey {
	readonly name: string;
	readonly labels?: Readonly<Record<string, string>>;
}

const DEFAULT_BUCKETS: readonly number[] = [
	0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

function labelKey(labels?: Readonly<Record<string, string>>): string {
	if (labels === undefined) return "";
	const keys = Object.keys(labels).sort();
	return keys.map((k) => `${k}=${labels[k]}`).join("\u0001");
}

function escapeLabel(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
}

function formatLabels(labelsKey: string, extra?: Readonly<Record<string, string>>): string {
	const pairs: string[] = [];
	if (labelsKey !== "") {
		for (const part of labelsKey.split("\u0001")) {
			const idx = part.indexOf("=");
			if (idx <= 0) continue;
			pairs.push(`${part.slice(0, idx)}="${escapeLabel(part.slice(idx + 1))}"`);
		}
	}
	if (extra !== undefined) {
		for (const [k, v] of Object.entries(extra)) {
			pairs.push(`${k}="${escapeLabel(v)}"`);
		}
	}
	return pairs.length > 0 ? `{${pairs.join(",")}}` : "";
}

export class MetricsRegistry {
	readonly #counters = new Map<string, CounterDef>();
	readonly #histograms = new Map<string, HistogramDef>();
	readonly #gauges = new Map<string, GaugeDef>();

	registerCounter(name: string, help: string): void {
		if (!this.#counters.has(name)) this.#counters.set(name, { help, values: new Map() });
	}

	registerHistogram(
		name: string,
		help: string,
		buckets: readonly number[] = DEFAULT_BUCKETS,
	): void {
		if (!this.#histograms.has(name)) {
			this.#histograms.set(name, { help, buckets, series: new Map() });
		}
	}

	registerGauge(name: string, help: string, read: () => number): void {
		this.#gauges.set(name, { help, read });
	}

	incrementCounter(key: MetricKey, by = 1): void {
		const def = this.#counters.get(key.name);
		if (def === undefined) return;
		const k = labelKey(key.labels);
		def.values.set(k, (def.values.get(k) ?? 0) + by);
	}

	observeHistogram(key: MetricKey, valueSeconds: number): void {
		const def = this.#histograms.get(key.name);
		if (def === undefined) return;
		const k = labelKey(key.labels);
		let series = def.series.get(k);
		if (series === undefined) {
			series = { sum: 0, count: 0, bucketCounts: def.buckets.map(() => 0) };
			def.series.set(k, series);
		}
		series.sum += valueSeconds;
		series.count += 1;
		for (let i = 0; i < def.buckets.length; i++) {
			const b = def.buckets[i];
			if (b !== undefined && valueSeconds <= b)
				series.bucketCounts[i] = (series.bucketCounts[i] ?? 0) + 1;
		}
	}

	render(): string {
		const lines: string[] = [];
		for (const [name, def] of this.#counters) {
			lines.push(`# HELP ${name} ${def.help}`);
			lines.push(`# TYPE ${name} counter`);
			for (const [k, v] of def.values) lines.push(`${name}${formatLabels(k)} ${v}`);
		}
		for (const [name, def] of this.#histograms) {
			lines.push(`# HELP ${name} ${def.help}`);
			lines.push(`# TYPE ${name} histogram`);
			for (const [k, s] of def.series) {
				let cumulative = 0;
				for (let i = 0; i < def.buckets.length; i++) {
					const upper = def.buckets[i];
					if (upper === undefined) continue;
					cumulative += s.bucketCounts[i] ?? 0;
					lines.push(`${name}_bucket${formatLabels(k, { le: upper.toString() })} ${cumulative}`);
				}
				lines.push(`${name}_bucket${formatLabels(k, { le: "+Inf" })} ${s.count}`);
				lines.push(`${name}_sum${formatLabels(k)} ${s.sum}`);
				lines.push(`${name}_count${formatLabels(k)} ${s.count}`);
			}
		}
		for (const [name, def] of this.#gauges) {
			lines.push(`# HELP ${name} ${def.help}`);
			lines.push(`# TYPE ${name} gauge`);
			let val = 0;
			try {
				val = def.read();
			} catch {
				val = 0;
			}
			lines.push(`${name} ${val}`);
		}
		return `${lines.join("\n")}\n`;
	}
}

export interface GadgetMetrics {
	readonly registry: MetricsRegistry;
	recordToolCall(tool: string, resultCode: string, durationSeconds: number): void;
	recordGadgetContentChars(tool: string, chars: number): void;
}

const CONTENT_CHARS_BUCKETS: readonly number[] = [50, 100, 200, 400, 800, 1200, 2000, 4000, 8000];

function count(db: Db, table: string): number {
	try {
		const row = db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number } | null;
		return row?.n ?? 0;
	} catch {
		return 0;
	}
}

export function buildGadgetMetrics(db: Db): GadgetMetrics {
	const registry = new MetricsRegistry();
	registry.registerCounter(
		"gadget_tool_calls_total",
		"Total tool invocations by tool and result code.",
	);
	registry.registerHistogram(
		"gadget_tool_call_duration_seconds",
		"Tool invocation latency in seconds.",
	);
	registry.registerHistogram(
		"gadget_content_chars",
		"Character length of gadget content on mutating writes.",
		CONTENT_CHARS_BUCKETS,
	);
	registry.registerGauge("gadget_gadgets_total", "Live gadgets in store.", () =>
		count(db, "gadgets"),
	);
	registry.registerGauge("gadget_revisions_total", "Stored gadget revisions.", () =>
		count(db, "gadget_revisions"),
	);
	registry.registerGauge("gadget_aliases_total", "Stored aliases.", () => count(db, "aliases"));
	registry.registerGauge("gadget_audit_rows_total", "Persistent audit rows.", () =>
		count(db, "audit_log"),
	);
	registry.registerGauge("gadget_fts_rows_total", "Rows in the FTS5 index.", () =>
		count(db, "gadgets_fts"),
	);
	return {
		registry,
		recordToolCall(tool, resultCode, durationSeconds): void {
			registry.incrementCounter({
				name: "gadget_tool_calls_total",
				labels: { tool, result: resultCode },
			});
			registry.observeHistogram(
				{ name: "gadget_tool_call_duration_seconds", labels: { tool } },
				durationSeconds,
			);
		},
		recordGadgetContentChars(tool, chars): void {
			if (!Number.isFinite(chars) || chars < 0) return;
			registry.observeHistogram({ name: "gadget_content_chars", labels: { tool } }, chars);
		},
	};
}
