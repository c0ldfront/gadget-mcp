import {
	type Harness,
	type HarnessRunInput,
	type HarnessRunResult,
	readAllStreams,
} from "../harness.ts";
import { parseCodexFinalTextForTest, parseCodexToolCallsForTest } from "./codex-parser.ts";

const CODEX_BIN = "codex";

async function codexInstalled(): Promise<boolean> {
	return Bun.which(CODEX_BIN) !== null;
}

function toTomlArray(values: readonly string[]): string {
	return `[${values.map((v) => JSON.stringify(v)).join(", ")}]`;
}

function toTomlTable(env: Readonly<Record<string, string>> | undefined): string {
	if (env === undefined || Object.keys(env).length === 0) return "{}";
	const pairs = Object.entries(env).map(([k, v]) => `${JSON.stringify(k)} = ${JSON.stringify(v)}`);
	return `{ ${pairs.join(", ")} }`;
}

export const codexHarness: Harness = {
	name: "codex",

	async isAvailable(): Promise<boolean> {
		return codexInstalled();
	},

	async run(input: HarnessRunInput): Promise<HarnessRunResult> {
		const sanitizedName = input.mcpServerName.replace(/[^a-z0-9_-]/gi, "_");
		const overrides: string[] = [
			"-c",
			`mcp_servers.${sanitizedName}.command=${JSON.stringify(input.mcpServer.command)}`,
			"-c",
			`mcp_servers.${sanitizedName}.args=${toTomlArray(input.mcpServer.args)}`,
			"-c",
			`mcp_servers.${sanitizedName}.env=${toTomlTable(input.mcpServer.env)}`,
		];
		const args: string[] = [
			"exec",
			"--json",
			"--color",
			"never",
			"--skip-git-repo-check",
			"--sandbox",
			"workspace-write",
			...overrides,
		];
		if (input.systemPrompt !== undefined) {
			args.push("-c", `base_instructions=${JSON.stringify(input.systemPrompt)}`);
		}
		args.push(input.prompt);

		const started = performance.now();
		const proc = Bun.spawn([CODEX_BIN, ...args], {
			cwd: input.workdir,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env },
		});
		const { stdout, stderr, exitCode } = await readAllStreams(proc, input.timeoutMs);
		const durationMs = Math.round(performance.now() - started);

		const toolCalls = parseCodexToolCallsForTest(stdout);
		const finalText = parseCodexFinalTextForTest(stdout);

		return {
			harness: "codex",
			exitCode,
			durationMs,
			toolCalls,
			finalText,
			stderr,
		};
	},
};
