import { expect, test } from "bun:test";
import {
	AuditWriter,
	buildGadgetMetrics,
	GadgetRepo,
	openMemoryDb,
	ReviewerRunnerRepo,
} from "@gadget/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "./server.ts";

async function makeConnectedClient(role: "admin" | "writer" | "reader" = "admin"): Promise<{
	client: Client;
	dispose: () => Promise<void>;
}> {
	const db = openMemoryDb();
	const repo = new GadgetRepo(db);
	const runnerRepo = new ReviewerRunnerRepo(db);
	const audit = new AuditWriter(db);
	const metrics = buildGadgetMetrics(db);
	const server = buildServer({
		repo,
		runnerRepo,
		role,
		actor: `test:${role}`,
		audit,
		metrics,
		workspace: "default",
		db,
	});
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	const client = new Client({ name: "test-client", version: "0.0.1" });
	await client.connect(clientTransport);
	return {
		client,
		dispose: async () => {
			await client.close();
			await server.close();
			db.close();
		},
	};
}

test("tools/list advertises gadget.* tools", async () => {
	const { client, dispose } = await makeConnectedClient("admin");
	try {
		const tools = await client.listTools();
		const names = tools.tools.map((t) => t.name).sort();
		expect(names).toContain("gadget.list-gadgets");
		expect(names).toContain("gadget.get-gadget");
		expect(names).toContain("gadget.add-gadget");
		expect(names).toContain("gadget.compose-prompt");
	} finally {
		await dispose();
	}
});

test("RBAC: reader role hides writer-only tools", async () => {
	const { client, dispose } = await makeConnectedClient("reader");
	try {
		const tools = await client.listTools();
		const names = tools.tools.map((t) => t.name);
		expect(names).toContain("gadget.list-gadgets");
		expect(names).not.toContain("gadget.add-gadget");
		expect(names).not.toContain("gadget.delete-gadget");
	} finally {
		await dispose();
	}
});

test("add then compose round-trip via protocol", async () => {
	const { client, dispose } = await makeConnectedClient("admin");
	try {
		await client.callTool({
			name: "gadget.add-gadget",
			arguments: {
				id: "role-test",
				category: "role",
				title: "T",
				description: "d",
				content: "ROLE CONTENT",
			},
		});
		await client.callTool({
			name: "gadget.add-gadget",
			arguments: {
				id: "task-test",
				category: "task",
				title: "T",
				description: "d",
				content: "TASK CONTENT",
			},
		});
		const res = await client.callTool({
			name: "gadget.compose-prompt",
			arguments: { gadgetIds: ["role-test", "task-test"] },
		});
		const payload = res.structuredContent as { prompt: string };
		expect(payload.prompt).toBe("ROLE CONTENT\n\nTASK CONTENT");
	} finally {
		await dispose();
	}
});

test("compose with missing ids surfaces gadget error", async () => {
	const { client, dispose } = await makeConnectedClient("admin");
	try {
		const res = await client.callTool({
			name: "gadget.compose-prompt",
			arguments: { gadgetIds: ["does-not-exist"] },
		});
		expect(res.isError).toBe(true);
		const contents = Array.isArray(res.content) ? res.content : [];
		const text = contents.map((c) => (c.type === "text" ? c.text : "")).join(" ");
		expect(text).toContain("does-not-exist");
	} finally {
		await dispose();
	}
});

test("resources/list includes canonical resources", async () => {
	const { client, dispose } = await makeConnectedClient("admin");
	try {
		const list = await client.listResources();
		const uris = list.resources.map((r) => r.uri);
		expect(uris).toContain("gadget://gadgets/all");
		expect(uris).toContain("gadget://categories");
		expect(uris).toContain("gadget://compose/canonical");
	} finally {
		await dispose();
	}
});

test("prompts/list exposes gadget-build-chain", async () => {
	const { client, dispose } = await makeConnectedClient("admin");
	try {
		const prompts = await client.listPrompts();
		expect(prompts.prompts.map((p) => p.name)).toContain("gadget-build-chain");
	} finally {
		await dispose();
	}
});

test("mutating tool emits notifications/message; reader tool does not", async () => {
	const db = openMemoryDb();
	const repo = new GadgetRepo(db);
	const runnerRepo = new ReviewerRunnerRepo(db);
	const audit = new AuditWriter(db);
	const metrics = buildGadgetMetrics(db);
	const server = buildServer({
		repo,
		runnerRepo,
		role: "admin",
		actor: "test:notify",
		audit,
		metrics,
		workspace: "default",
		db,
	});
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	const client = new Client({ name: "notify-client", version: "0.0.1" });
	const logs: { data?: { tool?: string } }[] = [];
	const notifs: string[] = [];
	client.fallbackNotificationHandler = async (n): Promise<void> => {
		notifs.push(n.method);
		if (n.method === "notifications/message") {
			logs.push(n.params as { data?: { tool?: string } });
		}
	};
	await client.connect(clientTransport);
	try {
		await client.callTool({
			name: "gadget.add-gadget",
			arguments: {
				id: "role-notify",
				category: "role",
				title: "T",
				description: "d",
				content: "C",
			},
		});
		await client.callTool({ name: "gadget.list-gadgets", arguments: {} });
		await Bun.sleep(20);
		const mutatingLogs = logs.filter((p) => p.data?.tool === "gadget.add-gadget");
		expect(mutatingLogs.length).toBeGreaterThanOrEqual(1);
		const readerLogs = logs.filter((p) => p.data?.tool === "gadget.list-gadgets");
		expect(readerLogs.length).toBe(0);
		expect(notifs).toContain("notifications/resources/list_changed");
	} finally {
		await client.close();
		await server.close();
		db.close();
	}
});

test("completion/complete returns live gadget ids for the gadget://gadget/{id} template", async () => {
	const { client, dispose } = await makeConnectedClient("admin");
	try {
		await client.callTool({
			name: "gadget.add-gadget",
			arguments: {
				id: "role-alpha",
				category: "role",
				title: "A",
				description: "a",
				content: "a",
			},
		});
		await client.callTool({
			name: "gadget.add-gadget",
			arguments: {
				id: "role-beta",
				category: "role",
				title: "B",
				description: "b",
				content: "b",
			},
		});
		const res = await client.complete({
			ref: { type: "ref/resource", uri: "gadget://gadget/{id}" },
			argument: { name: "id", value: "role-" },
		});
		expect(res.completion.values).toContain("role-alpha");
		expect(res.completion.values).toContain("role-beta");
	} finally {
		await dispose();
	}
});

test("completion/complete serves category values for the compose-prompt-builder prompt", async () => {
	const { client, dispose } = await makeConnectedClient("admin");
	try {
		const res = await client.complete({
			ref: { type: "ref/prompt", name: "gadget-build-system-prompt" },
			argument: { name: "category", value: "r" },
		});
		expect(res.completion.values).toEqual(["role", "reasoning"]);
	} finally {
		await dispose();
	}
});

test("gadget.list-client-roots: returns supported=false when client has no roots", async () => {
	const { client, dispose } = await makeConnectedClient("reader");
	try {
		const res = await client.callTool({
			name: "gadget.list-client-roots",
			arguments: {},
		});
		const payload = res.structuredContent as { roots: unknown[]; supported: boolean };
		expect(payload.supported).toBe(false);
		expect(payload.roots).toEqual([]);
	} finally {
		await dispose();
	}
});
