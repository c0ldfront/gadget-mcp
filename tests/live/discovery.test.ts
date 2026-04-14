import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { HarnessRunResult } from "./harness.ts";
import { availableHarnesses } from "./harnesses/index.ts";

const LIVE = Bun.env.GADGET_LIVE_TESTS === "1";
const TIMEOUT_MS = Number.parseInt(Bun.env.GADGET_LIVE_TIMEOUT_MS ?? "180000", 10);
const CLI = resolve("./packages/server/src/cli.ts");
const MCP_SERVER_NAME = "gadget-mcp";

let workdir: string;
beforeAll(() => {
	workdir = mkdtempSync(`${tmpdir()}/gadget-live-`);
});
afterAll(() => {
	rmSync(workdir, { recursive: true, force: true });
});

function gadgetInvoked(result: HarnessRunResult): boolean {
	return result.toolCalls.some((tc) => {
		if (tc.server === MCP_SERVER_NAME) return true;
		return tc.name.startsWith("gadget.") || tc.name.includes("compose-prompt");
	});
}

function normalizeToolName(name: string): string {
	// Claude rewrites `gadget.compose-prompt` to `gadget_compose_prompt`
	// (dots + hyphens → underscores) when exposing MCP tools through its own
	// tool registry. Compare on a normalized form so compose matches either.
	return name.replaceAll(/[-.]/g, "_");
}

function composeInvoked(result: HarnessRunResult): boolean {
	return result.toolCalls.some((tc) => {
		const n = normalizeToolName(tc.name);
		return n === "compose_prompt" || n === "gadget_compose_prompt";
	});
}

function finalTextHasContent(result: HarnessRunResult, minChars = 200): boolean {
	return result.finalText.trim().length >= minChars;
}

interface DiscoveryCase {
	readonly name: string;
	readonly prompt: string;
	readonly mustInvokeCompose: boolean;
	readonly mustHaveComposedContent?: boolean;
}

const CASES: readonly DiscoveryCase[] = [
	{
		// Explicit-ask baseline: if this fails, the MCP bridge itself is broken,
		// not the tool descriptions. Diagnostic separator between wiring and
		// discoverability failures.
		name: "explicit_wiring_check",
		prompt:
			"Use the gadget-mcp MCP server to call its `list-gadgets` tool with no arguments. " +
			"Then tell me how many items were returned. Do not answer from memory.",
		mustInvokeCompose: false,
	},
	{
		name: "vague_system_prompt_request",
		prompt:
			"I need a system prompt for an autonomous Bun-runtime engineer building an MCP server. " +
			"It should push for strict TypeScript, Biome, colocated tests, and commit-per-feature discipline. " +
			"Build it for me.",
		mustInvokeCompose: false,
	},
	{
		name: "reviewer_persona_request",
		prompt:
			"Give me a reusable prompt template I can paste into another AI to turn it into a careful " +
			"code reviewer. I want it to be anchored to specific lines and refuse to rubber-stamp.",
		mustInvokeCompose: false,
	},
	{
		// End-to-end assertion: the LLM must (a) call gadget.compose-prompt AND
		// (b) return substantive content in its final message. Guards against
		// regressions where the tool fires but the LLM summarizes instead of
		// emitting the composed prompt.
		name: "compose_end_to_end",
		prompt:
			"Use the gadget-mcp server to compose a finished system prompt for an autonomous Bun " +
			"engineer. Chain gadgets in canonical order and print the final prompt verbatim.",
		mustInvokeCompose: true,
		mustHaveComposedContent: true,
	},
];

if (!LIVE) {
	test.skip("live discovery suite (set GADGET_LIVE_TESTS=1 and install a harness to enable)", () =>
		undefined);
} else {
	const harnesses = await availableHarnesses();
	if (harnesses.length === 0) {
		test.skip("live discovery suite (no harness binary on PATH: install claude or codex)", () =>
			undefined);
	} else {
		for (const h of harnesses) {
			for (const c of CASES) {
				test(
					`${h.name} discovers gadget-mcp from "${c.name}"`,
					async () => {
						const result = await h.run({
							prompt: c.prompt,
							mcpServer: {
								command: "bun",
								args: ["run", CLI, "--stdio"],
								env: {
									GADGET_DB: `${workdir}/${h.name}-${c.name}.db`,
									GADGET_SEED: "auto",
								},
							},
							mcpServerName: MCP_SERVER_NAME,
							workdir,
							timeoutMs: TIMEOUT_MS,
							allowedToolGlobs: [`mcp__${MCP_SERVER_NAME}__*`],
						});
						process.stderr.write(
							`[${h.name}/${c.name}] exit=${result.exitCode} ` +
								`duration=${result.durationMs}ms tools=${result.toolCalls.length}\n`,
						);
						expect(gadgetInvoked(result)).toBe(true);
						if (c.mustInvokeCompose) {
							expect(composeInvoked(result)).toBe(true);
						}
						if (c.mustHaveComposedContent === true) {
							expect(finalTextHasContent(result, 200)).toBe(true);
						}
					},
					TIMEOUT_MS + 30_000,
				);
			}
		}
	}
}
