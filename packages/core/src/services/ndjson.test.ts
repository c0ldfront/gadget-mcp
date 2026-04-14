import { expect, test } from "bun:test";
import { openMemoryDb } from "../db/connection.ts";
import { GadgetRepo } from "../repo/gadget-repo.ts";
import { exportNdjson, importNdjson } from "./ndjson.ts";

const sample = (id: string): string =>
	JSON.stringify({
		id,
		category: "role",
		title: id,
		description: "desc",
		content: `content of ${id}`,
		tags: ["a"],
		source: "generated",
	});

test("import NDJSON happy path", () => {
	const db = openMemoryDb();
	const repo = new GadgetRepo(db);
	const res = importNdjson(repo, [sample("role-a"), sample("role-b")].join("\n"));
	expect(res.imported).toBe(2);
	expect(res.errors.length).toBe(0);
	expect(repo.count()).toBe(2);
	db.close();
});

test("import conflict=skip leaves existing untouched", () => {
	const db = openMemoryDb();
	const repo = new GadgetRepo(db);
	importNdjson(repo, sample("role-a"));
	const res = importNdjson(repo, sample("role-a"), "skip");
	expect(res.skipped).toBe(1);
	db.close();
});

test("import conflict=overwrite replaces", () => {
	const db = openMemoryDb();
	const repo = new GadgetRepo(db);
	importNdjson(repo, sample("role-a"));
	const res = importNdjson(repo, sample("role-a"), "overwrite");
	expect(res.overwritten).toBe(1);
	db.close();
});

test("import conflict=error collects errors", () => {
	const db = openMemoryDb();
	const repo = new GadgetRepo(db);
	importNdjson(repo, sample("role-a"));
	const res = importNdjson(repo, sample("role-a"), "error");
	expect(res.errors.length).toBe(1);
	db.close();
});

test("import collects per-line parse and validation errors", () => {
	const db = openMemoryDb();
	const repo = new GadgetRepo(db);
	const badJson = "{not json";
	const badShape = JSON.stringify({ id: "BAD" });
	const res = importNdjson(repo, [badJson, badShape, sample("role-ok")].join("\n"));
	expect(res.errors.length).toBe(2);
	expect(res.imported).toBe(1);
	db.close();
});

test("export round-trips with includeHistory", async () => {
	const db = openMemoryDb();
	const repo = new GadgetRepo(db);
	importNdjson(repo, sample("role-a"));
	const out = await exportNdjson(repo, { includeHistory: true });
	expect(out).toContain("role-a");
	expect(out).toContain("_revisions");
	db.close();
});

test("export honors AbortSignal and throws ExportCancelledError", async () => {
	const { ExportCancelledError } = await import("./ndjson.ts");
	const db = openMemoryDb();
	const repo = new GadgetRepo(db);
	importNdjson(repo, [sample("role-a"), sample("role-b")].join("\n"));
	const controller = new AbortController();
	controller.abort();
	await expect(exportNdjson(repo, { signal: controller.signal })).rejects.toThrow(
		ExportCancelledError,
	);
	db.close();
});
