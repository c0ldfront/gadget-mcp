import { expect, test } from "bun:test";
import { openMemoryDb } from "../db/connection.ts";
import { buildGadgetMetrics, MetricsRegistry } from "./metrics.ts";

test("MetricsRegistry renders counters, histograms, gauges", () => {
	const r = new MetricsRegistry();
	r.registerCounter("c_total", "counter help");
	r.registerHistogram("h_seconds", "hist help", [0.1, 1, 10]);
	r.registerGauge("g_total", "gauge help", () => 42);
	r.incrementCounter({ name: "c_total", labels: { x: "a" } }, 2);
	r.observeHistogram({ name: "h_seconds", labels: { x: "a" } }, 0.2);
	const out = r.render();
	expect(out).toContain("# TYPE c_total counter");
	expect(out).toContain('c_total{x="a"} 2');
	expect(out).toContain("# TYPE h_seconds histogram");
	expect(out).toContain('h_seconds_bucket{x="a",le="+Inf"} 1');
	expect(out).toContain('h_seconds_sum{x="a"} 0.2');
	expect(out).toContain("g_total 42");
});

test("buildGadgetMetrics records tool calls", () => {
	const db = openMemoryDb();
	const m = buildGadgetMetrics(db);
	m.recordToolCall("gadget.add", "ok", 0.05);
	const out = m.registry.render();
	expect(out).toContain('gadget_tool_calls_total{result="ok",tool="gadget.add"} 1');
	expect(out).toContain("gadget_gadgets_total 0");
	db.close();
});
