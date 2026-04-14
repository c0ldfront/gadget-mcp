import { expect, test } from "bun:test";
import { FORMATS, generateConfig, isGenerateFormat } from "./cli-generate.ts";

test("FORMATS covers all five generators", () => {
	expect(FORMATS.length).toBe(5);
	expect(isGenerateFormat("claude-desktop")).toBe(true);
	expect(isGenerateFormat("cursor")).toBe(true);
	expect(isGenerateFormat("vscode")).toBe(true);
	expect(isGenerateFormat("mcp-json")).toBe(true);
	expect(isGenerateFormat("shell-env")).toBe(true);
	expect(isGenerateFormat("foo")).toBe(false);
});

test("claude-desktop stdio shape", () => {
	const out = generateConfig({
		format: "claude-desktop",
		mode: "stdio",
		workspace: "default",
		dbPath: "/data/gadget.db",
	});
	const parsed = JSON.parse(out);
	expect(parsed.mcpServers.gadget.command).toBe("gadget-mcp");
	expect(parsed.mcpServers.gadget.args).toContain("--stdio");
	expect(parsed.mcpServers.gadget.env.GADGET_DB).toBe("/data/gadget.db");
});

test("vscode http shape includes bearer header", () => {
	const out = generateConfig({
		format: "vscode",
		mode: "http",
		workspace: "default",
		url: "http://localhost:7878/mcp",
		token: "secret",
	});
	const parsed = JSON.parse(out);
	expect(parsed.servers.gadget.type).toBe("http");
	expect(parsed.servers.gadget.headers.Authorization).toBe("Bearer secret");
});

test("http workspace appends query param when non-default", () => {
	const out = generateConfig({
		format: "mcp-json",
		mode: "http",
		workspace: "team",
		url: "http://localhost:7878/mcp",
	});
	expect(out).toContain("workspace=team");
});

test("shell-env renders export lines", () => {
	const out = generateConfig({
		format: "shell-env",
		mode: "http",
		workspace: "team",
		dbPath: "/db",
		token: "tok",
		httpHost: "0.0.0.0",
		httpPort: 7878,
	});
	expect(out).toContain("export GADGET_DB='/db'");
	expect(out).toContain("export GADGET_WORKSPACE='team'");
	expect(out).toContain("export GADGET_HTTP_TOKENS='tok:admin'");
});
