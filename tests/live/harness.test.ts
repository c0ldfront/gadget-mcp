import { expect, test } from "bun:test";
import { mcpToolName } from "./harness.ts";
import { ALL_HARNESSES } from "./harnesses/index.ts";

test("mcpToolName parses Claude's mcp__server__tool pattern", () => {
	expect(mcpToolName("mcp__gadget-mcp__compose-prompt")).toEqual({
		server: "gadget-mcp",
		tool: "compose-prompt",
	});
	expect(mcpToolName("mcp__another__inner__sub")).toEqual({
		server: "another",
		tool: "inner__sub",
	});
});

test("mcpToolName leaves bare tool names untouched", () => {
	expect(mcpToolName("compose-prompt")).toEqual({ server: null, tool: "compose-prompt" });
	expect(mcpToolName("Read")).toEqual({ server: null, tool: "Read" });
});

test("ALL_HARNESSES registers both claude and codex", () => {
	expect(ALL_HARNESSES.map((h) => h.name).sort()).toEqual(["claude", "codex"]);
});
