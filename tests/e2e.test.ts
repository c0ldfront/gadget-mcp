import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Subprocess } from "bun";

const CLI = resolve("./packages/server/src/cli.ts");
let workdir: string;

beforeAll(() => {
	workdir = mkdtempSync(`${tmpdir()}/gadget-e2e-`);
});
afterAll(() => {
	rmSync(workdir, { recursive: true, force: true });
});

test("stdio e2e: initialize, list tools, add + compose gadget", async () => {
	const transport = new StdioClientTransport({
		command: "bun",
		args: ["run", CLI, "--stdio"],
		env: {
			...Bun.env,
			GADGET_DB: `${workdir}/stdio.db`,
			GADGET_SEED: "off",
		},
	});
	const client = new Client({ name: "e2e-stdio", version: "0.0.1" });
	try {
		await client.connect(transport);
		const tools = await client.listTools();
		const toolNames = tools.tools.map((t) => t.name);
		expect(toolNames).toContain("gadget.compose-prompt");

		await client.callTool({
			name: "gadget.add-gadget",
			arguments: {
				id: "role-e2e",
				category: "role",
				title: "E2E role",
				description: "e2e",
				content: "ROLE CONTENT",
			},
		});
		await client.callTool({
			name: "gadget.add-gadget",
			arguments: {
				id: "task-e2e",
				category: "task",
				title: "E2E task",
				description: "e2e",
				content: "TASK CONTENT",
			},
		});
		const res = await client.callTool({
			name: "gadget.compose-prompt",
			arguments: { gadgetIds: ["role-e2e", "task-e2e"] },
		});
		const payload = res.structuredContent as { prompt: string };
		expect(payload.prompt).toBe("ROLE CONTENT\n\nTASK CONTENT");
	} finally {
		await client.close();
	}
}, 30_000);

test("http e2e: /healthz /readyz /metrics and full /mcp round-trip", async () => {
	const port = 18780 + Math.floor(Math.random() * 1000);
	const proc: Subprocess = Bun.spawn(
		["bun", "run", CLI, "--http", "--host=127.0.0.1", `--port=${port}`],
		{
			env: {
				...Bun.env,
				GADGET_DB: `${workdir}/http.db`,
				GADGET_SEED: "off",
				GADGET_HTTP_TOKENS: "",
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	try {
		// Wait for /healthz
		const ready = await waitForReady(`http://127.0.0.1:${port}/healthz`, 10_000);
		expect(ready).toBe(true);
		expect((await fetch(`http://127.0.0.1:${port}/readyz`)).status).toBe(200);
		const metrics = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
		expect(metrics).toContain("gadget_gadgets_total");

		const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
		const client = new Client({ name: "e2e-http", version: "0.0.1" });
		await client.connect(transport);
		try {
			const tools = await client.listTools();
			expect(tools.tools.map((t) => t.name)).toContain("gadget.compose-prompt");
			await client.callTool({
				name: "gadget.add-gadget",
				arguments: {
					id: "role-http",
					category: "role",
					title: "HTTP role",
					description: "e2e",
					content: "HTTP ROLE",
				},
			});
			const res = await client.callTool({
				name: "gadget.compose-prompt",
				arguments: { gadgetIds: ["role-http"] },
			});
			const payload = res.structuredContent as { prompt: string };
			expect(payload.prompt).toBe("HTTP ROLE");
		} finally {
			await client.close();
		}
	} finally {
		proc.kill("SIGTERM");
		await proc.exited;
	}
}, 60_000);

async function waitForReady(url: string, timeoutMs: number): Promise<boolean> {
	const until = Date.now() + timeoutMs;
	while (Date.now() < until) {
		try {
			const res = await fetch(url);
			if (res.status === 200) return true;
		} catch {
			// retry
		}
		await Bun.sleep(100);
	}
	return false;
}
