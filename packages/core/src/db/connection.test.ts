import { expect, test } from "bun:test";
import { openMemoryDb } from "./connection.ts";

test("openMemoryDb enables foreign keys and creates expected tables", () => {
	const db = openMemoryDb();
	const fk = db.query("PRAGMA foreign_keys").get() as { foreign_keys: number };
	expect(fk.foreign_keys).toBe(1);
	const rows = db.query("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as {
		name: string;
	}[];
	const names = new Set(rows.map((r) => r.name));
	expect(names.has("gadgets")).toBe(true);
	expect(names.has("gadget_revisions")).toBe(true);
	expect(names.has("aliases")).toBe(true);
	expect(names.has("audit_log")).toBe(true);
	expect(names.has("gadgets_fts")).toBe(true);
	db.close();
});
