import { expect, test } from "bun:test";
import { codexHarness } from "./codex.ts";
import { parseCodexFinalTextForTest, parseCodexToolCallsForTest } from "./codex-parser.ts";

// Captured verbatim from `codex exec --json` version 0.120.0 running against
// gadget-mcp. Guards against regressions when the event envelope changes.
const CODEX_FIXTURE = [
	'{"type":"thread.started","thread_id":"019d8b0f-fd54-7ef2-9179-4f48a12f32a1"}',
	'{"type":"turn.started"}',
	'{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Calling gtest..."}}',
	'{"type":"item.started","item":{"id":"item_1","type":"mcp_tool_call","server":"gtest","tool":"gadget.list-gadgets","status":"in_progress"}}',
	'{"type":"item.completed","item":{"id":"item_1","type":"mcp_tool_call","server":"gtest","tool":"gadget.list-gadgets","status":"completed"}}',
	'{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"```json\\n{\\"items\\":[],\\"nextCursor\\":null}\\n```"}}',
	'{"type":"turn.completed","usage":{"input_tokens":47627,"cached_input_tokens":27264,"output_tokens":220}}',
].join("\n");

// A synthetic payload in the legacy `msg`-enveloped shape for forward-compat
// coverage — the adapter still accepts it if older codex builds surface it.
const LEGACY_FIXTURE = [
	'{"msg":{"type":"mcp_tool_call_begin","server":"gtest","tool":"gadget.compose-prompt"}}',
	'{"msg":{"type":"mcp_tool_call","server":"gtest","tool":"gadget.compose-prompt"}}',
	'{"msg":{"type":"agent_message","message":"Done."}}',
].join("\n");

test("codexHarness is registered and callable", () => {
	expect(codexHarness.name).toBe("codex");
	expect(typeof codexHarness.isAvailable).toBe("function");
	expect(typeof codexHarness.run).toBe("function");
});

test("parseCodexToolCalls dedupes start + completion of one mcp_tool_call", () => {
	const calls = parseCodexToolCallsForTest(CODEX_FIXTURE);
	expect(calls.length).toBe(1);
	expect(calls[0]?.name).toBe("gadget.list-gadgets");
	expect(calls[0]?.server).toBe("gtest");
});

test("parseCodexToolCalls still accepts the legacy msg envelope", () => {
	const calls = parseCodexToolCallsForTest(LEGACY_FIXTURE);
	expect(calls.length).toBe(1);
	expect(calls[0]?.name).toBe("gadget.compose-prompt");
	expect(calls[0]?.server).toBe("gtest");
});

test("parseCodexFinalText returns the last agent_message text", () => {
	const text = parseCodexFinalTextForTest(CODEX_FIXTURE);
	expect(text).toContain("items");
	expect(text).toContain("nextCursor");
});

test("parseCodexFinalText falls back to legacy msg.message", () => {
	expect(parseCodexFinalTextForTest(LEGACY_FIXTURE)).toBe("Done.");
});
