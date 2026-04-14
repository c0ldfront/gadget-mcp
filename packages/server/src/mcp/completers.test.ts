import { expect, test } from "bun:test";
import { GadgetRepo, openMemoryDb, ReviewerRunnerRepo } from "@gadget/core";
import {
	completeCategory,
	completeGadgetId,
	completeRunnerId,
	completeTag,
	DEFAULT_COMPLETION_LIMIT,
} from "./completers.ts";

function seed(): { repo: GadgetRepo; runners: ReviewerRunnerRepo } {
	const db = openMemoryDb();
	const repo = new GadgetRepo(db);
	repo.add({
		id: "role-bun",
		category: "role",
		title: "Bun",
		description: "d",
		content: "c",
		tags: ["bun", "runtime"],
		source: "curated",
	});
	repo.add({
		id: "role-mcp",
		category: "role",
		title: "MCP",
		description: "d",
		content: "c",
		tags: ["mcp", "sdk"],
		source: "curated",
	});
	repo.add({
		id: "tone-terse",
		category: "tone",
		title: "Terse",
		description: "d",
		content: "c",
		tags: ["voice"],
		source: "curated",
	});
	repo.rename("role-mcp", "role-mcp-protocol-expert");
	const runners = new ReviewerRunnerRepo(db);
	runners.upsert({
		id: "claude",
		name: "C",
		command: ["claude"],
		enabled: true,
		timeoutSeconds: 60,
	});
	runners.upsert({
		id: "codex",
		name: "C2",
		command: ["codex"],
		enabled: true,
		timeoutSeconds: 60,
	});
	return { repo, runners };
}

test("completeGadgetId prefix-matches live ids", () => {
	const { repo } = seed();
	const hits = completeGadgetId(repo, "role");
	expect(hits).toContain("role-bun");
	expect(hits).toContain("role-mcp-protocol-expert");
});

test("completeGadgetId also surfaces aliases", () => {
	const { repo } = seed();
	const hits = completeGadgetId(repo, "role-mcp");
	expect(hits).toContain("role-mcp-protocol-expert");
	expect(hits).toContain("role-mcp"); // alias
});

test("completeGadgetId caps to limit", () => {
	const { repo } = seed();
	expect(completeGadgetId(repo, "", 1).length).toBe(1);
	expect(completeGadgetId(repo, "", DEFAULT_COMPLETION_LIMIT).length).toBeLessThanOrEqual(
		DEFAULT_COMPLETION_LIMIT,
	);
});

test("completeCategory filters to the nine canonical categories", () => {
	expect(completeCategory("r")).toEqual(["role", "reasoning"]);
	expect(completeCategory("tone")).toEqual(["tone"]);
	expect(completeCategory("nope")).toEqual([]);
	expect(completeCategory("").length).toBe(9);
});

test("completeRunnerId matches id prefix/substring", () => {
	const { runners } = seed();
	expect(completeRunnerId(runners, "cl")).toEqual(["claude"]);
	expect(completeRunnerId(runners, "")).toEqual(["claude", "codex"]);
});

test("completeTag dedupes across gadgets", () => {
	const { repo } = seed();
	const hits = completeTag(repo, "");
	expect(new Set(hits).size).toBe(hits.length);
	expect(hits).toContain("bun");
	expect(hits).toContain("voice");
});
