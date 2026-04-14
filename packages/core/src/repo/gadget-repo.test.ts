import { beforeEach, describe, expect, test } from "bun:test";
import { openMemoryDb } from "../db/connection.ts";
import {
	AliasConflictError,
	ComposeMissingIdsError,
	GadgetAlreadyExistsError,
	GadgetNotFoundError,
	RevisionMissingError,
} from "../domain/errors.ts";
import type { GadgetInput } from "../domain/gadget.ts";
import { GadgetRepo } from "./gadget-repo.ts";

function makeRepo(now = 1_700_000_000_000): GadgetRepo {
	const db = openMemoryDb();
	let t = now;
	return new GadgetRepo(db, { now: () => t++ });
}

const sample = (over: Partial<GadgetInput> = {}): GadgetInput => ({
	id: "role-bun",
	category: "role",
	title: "Bun Runtime Engineer",
	description: "Bun engineer persona",
	content: "You are a Bun engineer.",
	tags: ["bun", "runtime"],
	source: "curated",
	...over,
});

describe("GadgetRepo core ops", () => {
	let repo: GadgetRepo;
	beforeEach(() => {
		repo = makeRepo();
	});

	test("add creates gadget and returns v1", () => {
		const r = repo.add(sample());
		expect(r.created).toBe(true);
		expect(r.version).toBe(1);
		expect(repo.getById("role-bun")?.title).toBe("Bun Runtime Engineer");
	});

	test("add twice throws GadgetAlreadyExistsError", () => {
		repo.add(sample());
		expect(() => repo.add(sample())).toThrow(GadgetAlreadyExistsError);
	});

	test("put updates and creates new revision", () => {
		repo.add(sample());
		const r = repo.put(sample({ title: "Updated Title" }));
		expect(r.created).toBe(false);
		expect(r.version).toBe(2);
		expect(repo.getById("role-bun")?.title).toBe("Updated Title");
		const revs = repo.listRevisions("role-bun");
		expect(revs.map((r) => r.version)).toEqual([2, 1]);
	});

	test("delete removes gadget and cascades revisions/aliases", () => {
		repo.add(sample());
		repo.rename("role-bun", "role-bun-runtime");
		repo.delete("role-bun-runtime");
		expect(repo.getById("role-bun-runtime")).toBeNull();
		expect(repo.resolve("role-bun")).toBeNull();
		expect(repo.listRevisions("role-bun-runtime").length).toBe(0);
	});
});

describe("GadgetRepo list/search", () => {
	test("list pages with cursor", () => {
		const repo = makeRepo();
		for (let i = 0; i < 5; i++) {
			repo.add(sample({ id: `role-${i}`, title: `T${i}` }));
		}
		const first = repo.list({ limit: 2 });
		expect(first.items.length).toBe(2);
		expect(first.nextCursor).not.toBeNull();
		const second = repo.list({ limit: 2, cursor: first.nextCursor ?? undefined });
		expect(second.items.length).toBe(2);
		expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
	});

	test("list filters by category", () => {
		const repo = makeRepo();
		repo.add(sample({ id: "role-a", category: "role" }));
		repo.add(sample({ id: "tone-a", category: "tone" }));
		const res = repo.list({ category: "tone" });
		expect(res.items.length).toBe(1);
		expect(res.items[0]?.id).toBe("tone-a");
	});

	test("search returns matches by content tokens", () => {
		const repo = makeRepo();
		repo.add(sample({ id: "role-a", content: "deeply understands golang concurrency" }));
		repo.add(sample({ id: "role-b", content: "expert in rust memory safety" }));
		const res = repo.search({ query: "golang" });
		expect(res.items.map((i) => i.id)).toContain("role-a");
	});
});

describe("GadgetRepo rename + alias", () => {
	test("rename preserves old id as alias", () => {
		const repo = makeRepo();
		repo.add(sample());
		const r = repo.rename("role-bun", "role-bun-runtime");
		expect(r.previousName).toBe("role-bun");
		expect(repo.resolve("role-bun")?.id).toBe("role-bun-runtime");
		expect(repo.aliasesOf("role-bun-runtime")).toEqual(["role-bun"]);
	});

	test("rename collision throws AliasConflictError", () => {
		const repo = makeRepo();
		repo.add(sample({ id: "role-a" }));
		repo.add(sample({ id: "role-b" }));
		expect(() => repo.rename("role-a", "role-b")).toThrow(AliasConflictError);
	});
});

describe("GadgetRepo rollback", () => {
	test("rollback restores snapshot as a new revision", () => {
		const repo = makeRepo();
		repo.add(sample({ title: "v1 title" }));
		repo.put(sample({ title: "v2 title" }));
		const res = repo.rollback("role-bun", 1);
		expect(res.newVersion).toBe(3);
		expect(repo.getById("role-bun")?.title).toBe("v1 title");
	});

	test("rollback to unknown version throws RevisionMissingError", () => {
		const repo = makeRepo();
		repo.add(sample());
		expect(() => repo.rollback("role-bun", 999)).toThrow(RevisionMissingError);
	});

	test("rollback unknown gadget throws GadgetNotFoundError", () => {
		const repo = makeRepo();
		expect(() => repo.rollback("nope", 1)).toThrow(GadgetNotFoundError);
	});
});

describe("GadgetRepo compose", () => {
	test("compose concatenates in provided order", () => {
		const repo = makeRepo();
		repo.add(sample({ id: "role-x", content: "ROLE" }));
		repo.add(sample({ id: "task-x", category: "task", content: "TASK" }));
		const res = repo.compose(["role-x", "task-x"]);
		expect(res.prompt).toBe("ROLE\n\nTASK");
		expect(res.chain.map((g) => g.id)).toEqual(["role-x", "task-x"]);
	});

	test("compose missing ids throws ComposeMissingIdsError", () => {
		const repo = makeRepo();
		repo.add(sample());
		try {
			repo.compose(["role-bun", "does-not-exist"]);
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(ComposeMissingIdsError);
			if (err instanceof ComposeMissingIdsError) {
				expect(err.missing).toEqual(["does-not-exist"]);
			}
		}
	});

	test("compose resolves via alias", () => {
		const repo = makeRepo();
		repo.add(sample());
		repo.rename("role-bun", "role-bun-runtime");
		const res = repo.compose(["role-bun"]);
		expect(res.chain[0]?.id).toBe("role-bun-runtime");
	});
});
