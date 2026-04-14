import { expect, test } from "bun:test";
import { openMemoryDb } from "../db/connection.ts";
import { AuditWriter, resolveRetentionMs } from "./audit.ts";

test("record + tail + count round-trip", () => {
	const db = openMemoryDb();
	const w = new AuditWriter(db);
	w.record({ actor: "stdio", tool: "gadget.add", args: { id: "x" }, resultCode: "ok" });
	w.record({ actor: "stdio", tool: "gadget.list", args: {}, resultCode: "ok" });
	expect(w.count()).toBe(2);
	const t = w.tail(10);
	expect(t.length).toBe(2);
	const tools = new Set(t.map((e) => e.tool));
	expect(tools.has("gadget.add")).toBe(true);
	expect(tools.has("gadget.list")).toBe(true);
	db.close();
});

test("resolveRetentionMs defaults to 90 days when invalid", () => {
	expect(resolveRetentionMs(undefined)).toBe(90 * 86_400_000);
	expect(resolveRetentionMs("notanumber")).toBe(90 * 86_400_000);
	expect(resolveRetentionMs("30")).toBe(30 * 86_400_000);
	expect(resolveRetentionMs("-5")).toBe(90 * 86_400_000);
});

test("pruneOlderThan removes old rows", () => {
	const db = openMemoryDb();
	const w = new AuditWriter(db);
	w.record({ actor: "a", tool: "b", args: {}, resultCode: "ok" });
	expect(w.pruneOlderThan(-1)).toBe(0);
	expect(w.count()).toBe(1);
	db.close();
});
