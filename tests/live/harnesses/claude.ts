import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Harness,
	type HarnessRunInput,
	type HarnessRunResult,
	mcpToolName,
	readAllStreams,
	type ToolInvocation,
} from "../harness.ts";

const CLAUDE_BIN = "claude";

async function claudeInstalled(): Promise<boolean> {
	const path = Bun.which(CLAUDE_BIN);
	return path !== null;
}

export const claudeHarness: Harness = {
	name: "claude",

	async isAvailable(): Promise<boolean> {
		return claudeInstalled();
	},

	async run(input: HarnessRunInput): Promise<HarnessRunResult> {
		const configDir = mkdtempSync(join(tmpdir(), "gadget-live-claude-"));
		const mcpConfigPath = join(configDir, "mcp.json");
		const mcpConfig = {
			mcpServers: {
				[input.mcpServerName]: {
					command: input.mcpServer.command,
					args: input.mcpServer.args,
					env: input.mcpServer.env ?? {},
				},
			},
		};
		await Bun.write(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));

		const args: string[] = [
			"-p",
			input.prompt,
			"--mcp-config",
			mcpConfigPath,
			"--output-format",
			"stream-json",
			"--verbose",
			"--dangerously-skip-permissions",
			"--no-session-persistence",
		];
		if (input.allowedToolGlobs !== undefined && input.allowedToolGlobs.length > 0) {
			args.push("--allowedTools", input.allowedToolGlobs.join(" "));
		}
		if (input.systemPrompt !== undefined) {
			args.push("--append-system-prompt", input.systemPrompt);
		}

		const started = performance.now();
		const proc = Bun.spawn([CLAUDE_BIN, ...args], {
			cwd: input.workdir,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env },
		});
		const { stdout, stderr, exitCode } = await readAllStreams(proc, input.timeoutMs);
		const durationMs = Math.round(performance.now() - started);

		const toolCalls = parseStreamJsonToolCalls(stdout);
		const finalText = parseStreamJsonFinalText(stdout);

		return {
			harness: "claude",
			exitCode,
			durationMs,
			toolCalls,
			finalText,
			stderr,
		};
	},
};

interface ClaudeStreamEvent {
	readonly type?: string;
	readonly message?: { readonly content?: unknown };
	readonly result?: string;
}

function parseStreamJsonToolCalls(stdout: string): ToolInvocation[] {
	const out: ToolInvocation[] = [];
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		let evt: ClaudeStreamEvent;
		try {
			evt = JSON.parse(trimmed) as ClaudeStreamEvent;
		} catch {
			continue;
		}
		const content = evt.message?.content;
		if (!Array.isArray(content)) continue;
		for (const item of content) {
			if (
				typeof item === "object" &&
				item !== null &&
				(item as { type?: string }).type === "tool_use" &&
				typeof (item as { name?: string }).name === "string"
			) {
				const name = (item as { name: string }).name;
				const { server, tool } = mcpToolName(name);
				out.push({ name: tool, server, raw: item });
			}
		}
	}
	return out;
}

function parseStreamJsonFinalText(stdout: string): string {
	for (const line of stdout.split("\n").reverse()) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		try {
			const evt = JSON.parse(trimmed) as ClaudeStreamEvent;
			if (evt.type === "result" && typeof evt.result === "string") return evt.result;
		} catch {
			// keep scanning
		}
	}
	return "";
}
