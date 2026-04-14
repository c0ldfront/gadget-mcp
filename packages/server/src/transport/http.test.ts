import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { parseOriginAllowlist, parseTokens } from "../mcp/auth.ts";
import { parseWorkspaces, WorkspaceRegistry } from "../workspace.ts";
import { parseAllowedHosts, type RunningHttpServer, startHttpServer } from "./http.ts";

let tmp: string;
let running: RunningHttpServer | null = null;

beforeEach(() => {
	tmp = mkdtempSync(`${tmpdir()}/gadget-http-`);
});

afterEach(async () => {
	if (running !== null) {
		await running.close();
		running = null;
	}
	rmSync(tmp, { recursive: true, force: true });
});

function start(opts: { tokens?: string; allowedHosts?: string; maxBodyBytes?: number } = {}): {
	url: string;
} {
	const registry = new WorkspaceRegistry(parseWorkspaces(undefined, `${tmp}/c.db`));
	const loggerSilent = { log: (): void => undefined };
	running = startHttpServer({
		host: "127.0.0.1",
		port: 0,
		tokens: parseTokens(opts.tokens),
		originAllowlist: parseOriginAllowlist(undefined),
		registry,
		defaultWorkspace: "default",
		allowedHosts: parseAllowedHosts(opts.allowedHosts),
		...(opts.maxBodyBytes !== undefined ? { maxBodyBytes: opts.maxBodyBytes } : {}),
		logger: loggerSilent,
	});
	return { url: running.server.url.toString().replace(/\/$/, "") };
}

test("/healthz returns ok", async () => {
	const { url } = start();
	const res = await fetch(`${url}/healthz`);
	expect(res.status).toBe(200);
	expect(await res.text()).toBe("ok");
});

test("/readyz returns ready", async () => {
	const { url } = start();
	const res = await fetch(`${url}/readyz`);
	expect(res.status).toBe(200);
	expect(await res.text()).toBe("ready");
});

test("/metrics returns prometheus text", async () => {
	const { url } = start();
	const res = await fetch(`${url}/metrics`);
	expect(res.status).toBe(200);
	expect(res.headers.get("content-type")).toContain("text/plain");
	const body = await res.text();
	expect(body).toContain("gadget_gadgets_total");
});

test("/mcp without token when auth enabled returns 401 JSON with www-authenticate", async () => {
	const { url } = start({ tokens: "secret:admin" });
	const res = await fetch(`${url}/mcp`, {
		method: "POST",
		body: JSON.stringify({}),
		headers: { "content-type": "application/json" },
	});
	expect(res.status).toBe(401);
	expect(res.headers.get("www-authenticate")).toContain("Bearer");
	expect(res.headers.get("content-type")).toContain("application/json");
	const body = (await res.json()) as { error: string };
	expect(body.error).toContain("bearer");
});

test("/mcp over body-size limit returns 413", async () => {
	const { url } = start({ maxBodyBytes: 100 });
	const res = await fetch(`${url}/mcp`, {
		method: "POST",
		headers: { "content-type": "application/json", "content-length": "1000000" },
		body: "x".repeat(200),
	});
	expect(res.status).toBe(413);
});

test("/mcp disallowed host returns 400", async () => {
	const { url } = start({ allowedHosts: "only-this.example.com" });
	const res = await fetch(`${url}/mcp`, {
		method: "POST",
		headers: { host: "attacker.test" },
	});
	expect(res.status).toBe(400);
});

test("unknown workspace returns 404 with flat error shape", async () => {
	const { url } = start();
	const res = await fetch(`${url}/mcp?workspace=nonexistent`, { method: "POST" });
	expect(res.status).toBe(404);
	const body = (await res.json()) as { error: string };
	expect(body.error).toContain("nonexistent");
});

test("unknown route returns 404 JSON with x-request-id", async () => {
	const { url } = start();
	const res = await fetch(`${url}/whatever`);
	expect(res.status).toBe(404);
	expect(res.headers.get("x-request-id")).not.toBeNull();
});

test("parseAllowedHosts trims and dedupes", () => {
	const set = parseAllowedHosts(" a, b , ,a ");
	expect(set.has("a")).toBe(true);
	expect(set.has("b")).toBe(true);
	expect(set.size).toBe(2);
});
