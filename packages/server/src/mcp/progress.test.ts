import { describe, expect, test } from "bun:test";
import { type HandlerExtra, startProgressHeartbeat } from "./tools.ts";

describe("startProgressHeartbeat", () => {
	test("no-ops when the caller didn't supply a progressToken", () => {
		const calls: unknown[] = [];
		const stop = startProgressHeartbeat(
			{
				sendNotification: async (n) => {
					calls.push(n);
				},
			} satisfies HandlerExtra,
			10,
		);
		stop();
		expect(calls).toHaveLength(0);
	});

	test("no-ops when sendNotification is missing", () => {
		const stop = startProgressHeartbeat({ _meta: { progressToken: 1 } } satisfies HandlerExtra, 10);
		// No throw, and calling stop must be safe.
		stop();
	});

	test("drips notifications/progress at the configured cadence", async () => {
		const calls: Array<{ method: string; params?: unknown }> = [];
		const extra: HandlerExtra = {
			_meta: { progressToken: 42 },
			sendNotification: async (n) => {
				calls.push(n);
			},
		};
		const stop = startProgressHeartbeat(extra, 20);
		try {
			await new Promise((r) => setTimeout(r, 75));
		} finally {
			stop();
		}
		// At least 2 beats in 75ms (20ms cadence gives us ~3).
		expect(calls.length).toBeGreaterThanOrEqual(2);
		for (const call of calls) {
			expect(call.method).toBe("notifications/progress");
			const params = call.params as {
				progressToken: number | string;
				progress: number;
			};
			expect(params.progressToken).toBe(42);
			expect(params.progress).toBeGreaterThan(0);
		}
	});

	test("stop() halts the interval (no new beats after return)", async () => {
		const calls: unknown[] = [];
		const stop = startProgressHeartbeat(
			{
				_meta: { progressToken: "x" },
				sendNotification: async (n) => {
					calls.push(n);
				},
			} satisfies HandlerExtra,
			10,
		);
		await new Promise((r) => setTimeout(r, 35));
		const after = calls.length;
		stop();
		await new Promise((r) => setTimeout(r, 40));
		expect(calls.length).toBe(after);
	});
});
