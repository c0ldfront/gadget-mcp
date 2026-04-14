import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { parseWorkspaces, WorkspaceRegistry } from "./workspace.ts";

test("parseWorkspaces defaults to single 'default' workspace", () => {
	const defs = parseWorkspaces(undefined, "/tmp/x.db");
	expect(defs.size).toBe(1);
	expect(defs.get("default")?.dbPath).toBe("/tmp/x.db");
});

test("parseWorkspaces parses JSON map", () => {
	const defs = parseWorkspaces('{"a":"/tmp/a.db","b":"/tmp/b.db"}', "/tmp/x.db");
	expect(defs.size).toBe(2);
	expect(defs.get("a")?.dbPath).toBe("/tmp/a.db");
});

test("parseWorkspaces rejects bad names", () => {
	expect(() => parseWorkspaces('{"BAD NAME":"/x"}', "/x")).toThrow();
	expect(() => parseWorkspaces('"string"', "/x")).toThrow();
	expect(() => parseWorkspaces('{"a":123}', "/x")).toThrow();
});

test("WorkspaceRegistry lazy-opens and caches", () => {
	const dir = mkdtempSync(`${tmpdir()}/gadget-ws-`);
	try {
		const reg = new WorkspaceRegistry(parseWorkspaces(undefined, `${dir}/x.db`));
		expect(reg.names()).toEqual(["default"]);
		expect(reg.has("default")).toBe(true);
		const ws = reg.get("default");
		expect(ws.repo).toBeDefined();
		expect(reg.get("default")).toBe(ws);
		reg.closeAll();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
