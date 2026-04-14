import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { parseOriginAllowlist, parseTokens } from "../packages/server/src/mcp/auth.ts";
import {
	type HttpLogEvent,
	parseAllowedHosts,
	type RunningHttpServer,
	startHttpServer,
} from "../packages/server/src/transport/http.ts";
import { parseWorkspaces, WorkspaceRegistry } from "../packages/server/src/workspace.ts";

let tmp: string;
let running: RunningHttpServer | null = null;
const logs: HttpLogEvent[] = [];

beforeAll(() => {
	tmp = mkdtempSync(`${tmpdir()}/gadget-e2e-http-`);
});
afterAll(async () => {
	if (running !== null) await running.close();
	rmSync(tmp, { recursive: true, force: true });
});

function start(): { url: string } {
	const registry = new WorkspaceRegistry(parseWorkspaces(undefined, `${tmp}/http.db`));
	running = startHttpServer({
		host: "127.0.0.1",
		port: 0,
		tokens: parseTokens(undefined),
		originAllowlist: parseOriginAllowlist(undefined),
		allowedHosts: parseAllowedHosts(undefined),
		registry,
		defaultWorkspace: "default",
		logger: {
			log(event): void {
				logs.push(event);
			},
		},
	});
	return { url: running.server.url.toString().replace(/\/$/, "") };
}

test("HTTP lifecycle: initialize → tool call → explicit DELETE closes session", async () => {
	const { url } = start();

	const client = new Client({ name: "e2e-http-lifecycle", version: "0.0.1" });
	const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`));
	await client.connect(transport);
	let sessionId: string | undefined;
	try {
		const tools = await client.listTools();
		expect(tools.tools.map((t) => t.name)).toContain("gadget.list-gadgets");

		const res = await client.callTool({
			name: "gadget.list-gadgets",
			arguments: { limit: 1 },
		});
		expect(res.isError).not.toBe(true);

		// StreamableHTTPClientTransport exposes the negotiated session id after
		// initialize returns; cache it for the explicit DELETE below.
		sessionId = (transport as { sessionId?: string }).sessionId;
	} finally {
		await client.close();
	}

	// session_opened must have fired during initialize.
	const opened = logs.filter((e) => e.event === "session_opened");
	expect(opened.length).toBeGreaterThanOrEqual(1);
	expect(opened[0]?.data.workspace).toBe("default");
	expect(opened[0]?.data.role).toBe("admin");

	// Explicit DELETE /mcp with the session id exercises the onsessionclosed
	// path. Some client versions of the SDK don't send DELETE on close; this
	// asserts the server-side lifecycle contract directly.
	if (sessionId !== undefined) {
		const del = await fetch(`${url}/mcp`, {
			method: "DELETE",
			headers: { "mcp-session-id": sessionId },
		});
		expect([200, 202, 204]).toContain(del.status);
		for (let i = 0; i < 50; i++) {
			if (logs.some((e) => e.event === "session_closed")) break;
			await Bun.sleep(20);
		}
		const closed = logs.filter((e) => e.event === "session_closed");
		expect(closed.length).toBeGreaterThanOrEqual(1);
	}
});

test("HTTP /healthz, /readyz, /metrics respond even without auth", async () => {
	const { url } = running?.server.url.toString().replace(/\/$/, "")
		? { url: running.server.url.toString().replace(/\/$/, "") }
		: start();
	const [h, r, m] = await Promise.all([
		fetch(`${url}/healthz`),
		fetch(`${url}/readyz`),
		fetch(`${url}/metrics`),
	]);
	expect(h.status).toBe(200);
	expect(r.status).toBe(200);
	expect(m.status).toBe(200);
	expect((await m.text()).includes("gadget_gadgets_total")).toBe(true);
});
