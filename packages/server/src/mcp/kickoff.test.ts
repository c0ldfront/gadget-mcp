import { describe, expect, test } from "bun:test";
import {
	AuditWriter,
	buildGadgetMetrics,
	GadgetRepo,
	openMemoryDb,
	ReviewerRunnerRepo,
	seedFromContent,
} from "@gadget/core";
import embeddedGadgetsNdjson from "../../../../data/gadgets.ndjson" with { type: "text" };
import {
	assemblePrompt,
	DEFAULT_KICKOFF_ELICIT_TIMEOUT_MS,
	type KickoffAnswers,
	type KickoffRunner,
	resolveElicitTimeoutMs,
	runKickoff,
	scoreGadget,
	selectChain,
} from "./kickoff.ts";

function seededRepo(): GadgetRepo {
	const db = openMemoryDb();
	const repo = new GadgetRepo(db);
	const runnerRepo = new ReviewerRunnerRepo(db);
	seedFromContent(repo, runnerRepo, { gadgetsNdjson: embeddedGadgetsNdjson });
	return repo;
}

const baseAnswers: KickoffAnswers = {
	name: "demo",
	path: "/tmp/demo",
	goal: "Build a demo tool for testing.",
	projectType: "cli",
	runtime: "bun",
	qualityBar: "enterprise",
	integrations: [],
};

describe("scoreGadget", () => {
	test("returns > 0 when a needle matches id/title/description/tag", () => {
		const s = scoreGadget(
			{
				id: "role-embedded",
				tags: ["firmware", "rtos"],
				title: "Low-level embedded systems engineer",
				description: "persona primer",
			},
			{ ...baseAnswers, projectType: "cli", runtime: "bun", integrations: ["rtos"] },
		);
		expect(s).toBeGreaterThan(0);
	});

	test("returns negative when nothing matches (tiebreak dominates)", () => {
		const s = scoreGadget(
			{
				id: "role-kernel",
				tags: ["kernel"],
				title: "Kernel engineer",
				description: "systems",
			},
			{ ...baseAnswers, runtime: "python", projectType: "library", integrations: [] },
		);
		expect(s).toBeLessThan(0);
	});
});

describe("selectChain", () => {
	test("picks one gadget per slot when qualityBar=prototype", () => {
		const repo = seededRepo();
		const chain = selectChain(repo, { ...baseAnswers, qualityBar: "prototype" });
		const constraintCount = chain.filter((c) => c.category === "constraint").length;
		expect(constraintCount).toBeLessThanOrEqual(1);
	});

	test("pulls all scoring constraint gadgets when qualityBar=enterprise", () => {
		const repo = seededRepo();
		const loose: KickoffAnswers = {
			...baseAnswers,
			qualityBar: "enterprise",
			integrations: ["style"],
		};
		const chain = selectChain(repo, loose);
		const constraintCount = chain.filter((c) => c.category === "constraint").length;
		expect(constraintCount).toBeGreaterThanOrEqual(1);
	});
});

describe("assemblePrompt", () => {
	test("embeds name, path, goal, and integrations verbatim in the header", () => {
		const repo = seededRepo();
		const answers: KickoffAnswers = {
			...baseAnswers,
			integrations: ["MCP", "SQLite"],
		};
		const chain = selectChain(repo, answers);
		const prompt = assemblePrompt(repo, answers, chain);
		expect(prompt).toContain("`demo`");
		expect(prompt).toContain("`/tmp/demo`");
		expect(prompt).toContain("Build a demo tool for testing.");
		expect(prompt).toContain("MCP, SQLite");
	});

	test("emits a placeholder note when no gadgets match", () => {
		const repo = seededRepo();
		const answers: KickoffAnswers = { ...baseAnswers, runtime: "rust", integrations: [] };
		// Force an empty chain by passing []
		const prompt = assemblePrompt(repo, answers, []);
		expect(prompt).toContain("No matching gadgets");
	});
});

describe("runKickoff (elicitation orchestration)", () => {
	function stubRunner(replies: readonly { action: "accept" | "cancel"; content?: unknown }[]): {
		runner: KickoffRunner;
		calls: { message: string }[];
	} {
		const calls: { message: string }[] = [];
		let i = 0;
		const runner: KickoffRunner = {
			async elicit<T>(args: { message: string }): Promise<{
				action: "accept" | "cancel";
				content?: T;
			}> {
				calls.push({ message: args.message });
				const reply = replies[i++];
				if (reply === undefined) return { action: "cancel" };
				return { action: reply.action, content: reply.content as T | undefined };
			},
		};
		return { runner, calls };
	}

	test("returns `cancelled` when the first step is declined", async () => {
		const repo = seededRepo();
		const { runner } = stubRunner([{ action: "cancel" }]);
		const res = await runKickoff(runner, repo, {}, async () => 0);
		expect(res.action).toBe("cancelled");
	});

	test("returns `returned` with a non-empty prompt on the happy path", async () => {
		const repo = seededRepo();
		const { runner } = stubRunner([
			{
				action: "accept",
				content: { name: "demo", path: "/tmp/demo", goal: "Demo." },
			},
			{ action: "accept", content: { projectType: "cli" } },
			{ action: "accept", content: { runtime: "bun", qualityBar: "enterprise" } },
			{ action: "accept", content: { integrations: "" } },
			{ action: "accept", content: { action: "return" } },
		]);
		const res = await runKickoff(runner, repo, {}, async () => 0);
		expect(res.action).toBe("returned");
		expect(res.prompt.length).toBeGreaterThan(0);
	});

	test("returns `executed` when action=execute and GADGET_KICKOFF_EXEC is set", async () => {
		const repo = seededRepo();
		const { runner } = stubRunner([
			{
				action: "accept",
				content: { name: "demo", path: "/tmp/demo", goal: "Demo." },
			},
			{ action: "accept", content: { projectType: "cli" } },
			{ action: "accept", content: { runtime: "bun", qualityBar: "prototype" } },
			{ action: "accept", content: { integrations: "" } },
			{ action: "accept", content: { action: "execute" } },
		]);
		type Spawn = { command: string; cwd: string; stdin: string };
		let spawned: Spawn | null = null;
		const res = await runKickoff(
			runner,
			repo,
			{ GADGET_KICKOFF_EXEC: "echo" },
			async (c, cwd, stdin): Promise<number> => {
				spawned = { command: c, cwd, stdin } satisfies Spawn;
				return 0;
			},
		);
		expect(res.action).toBe("executed");
		const captured = spawned as Spawn | null;
		expect(captured).not.toBeNull();
		expect(captured?.command).toBe("echo");
	});

	test("falls back to `returned` when action=execute but GADGET_KICKOFF_EXEC is unset", async () => {
		const repo = seededRepo();
		const { runner } = stubRunner([
			{ action: "accept", content: { name: "demo", path: "/tmp/demo", goal: "Demo." } },
			{ action: "accept", content: { projectType: "cli" } },
			{ action: "accept", content: { runtime: "bun", qualityBar: "prototype" } },
			{ action: "accept", content: { integrations: "" } },
			{ action: "accept", content: { action: "execute" } },
		]);
		const res = await runKickoff(runner, repo, {}, async () => 0);
		expect(res.action).toBe("returned");
	});
});

// Shim to silence unused import warning when AuditWriter / buildGadgetMetrics
// get dropped by a future refactor — this file intentionally touches the
// full seed path so keep them reachable.
void AuditWriter;
void buildGadgetMetrics;

describe("resolveElicitTimeoutMs", () => {
	test("returns the default when unset or empty", () => {
		expect(resolveElicitTimeoutMs(undefined)).toBe(DEFAULT_KICKOFF_ELICIT_TIMEOUT_MS);
		expect(resolveElicitTimeoutMs("")).toBe(DEFAULT_KICKOFF_ELICIT_TIMEOUT_MS);
		expect(resolveElicitTimeoutMs("   ")).toBe(DEFAULT_KICKOFF_ELICIT_TIMEOUT_MS);
	});

	test("parses positive integers verbatim", () => {
		expect(resolveElicitTimeoutMs("30000")).toBe(30000);
		expect(resolveElicitTimeoutMs(" 120000 ")).toBe(120000);
	});

	test("falls back to the default on garbage / non-positive input", () => {
		expect(resolveElicitTimeoutMs("nope")).toBe(DEFAULT_KICKOFF_ELICIT_TIMEOUT_MS);
		expect(resolveElicitTimeoutMs("-5")).toBe(DEFAULT_KICKOFF_ELICIT_TIMEOUT_MS);
		expect(resolveElicitTimeoutMs("0")).toBe(DEFAULT_KICKOFF_ELICIT_TIMEOUT_MS);
	});
});
