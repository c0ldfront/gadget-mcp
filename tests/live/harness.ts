import type { Subprocess } from "bun";

export interface McpServerSpec {
	readonly command: string;
	readonly args: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
}

export interface HarnessRunInput {
	readonly prompt: string;
	readonly systemPrompt?: string;
	readonly mcpServer: McpServerSpec;
	readonly mcpServerName: string;
	readonly workdir: string;
	readonly timeoutMs: number;
	readonly allowedToolGlobs?: readonly string[];
}

export interface ToolInvocation {
	readonly name: string;
	readonly server: string | null;
	readonly raw: unknown;
}

export interface HarnessRunResult {
	readonly harness: string;
	readonly exitCode: number;
	readonly durationMs: number;
	readonly toolCalls: readonly ToolInvocation[];
	readonly finalText: string;
	readonly stderr: string;
}

export interface Harness {
	readonly name: string;
	isAvailable(): Promise<boolean>;
	run(input: HarnessRunInput): Promise<HarnessRunResult>;
}

export interface SpawnedHarness {
	readonly proc: Subprocess<"ignore", "pipe", "pipe">;
	readonly started: number;
}

export async function readAllStreams(
	proc: Subprocess<"ignore", "pipe", "pipe">,
	timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		proc.kill("SIGKILL");
	}, timeoutMs);
	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { stdout, stderr, exitCode, timedOut };
	} finally {
		clearTimeout(timeout);
	}
}

export function mcpToolName(raw: string): { server: string | null; tool: string } {
	// Claude Code advertises MCP tools as `mcp__<serverName>__<toolName>`.
	const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(raw);
	if (m !== null && m[1] !== undefined && m[2] !== undefined) {
		return { server: m[1], tool: m[2] };
	}
	return { server: null, tool: raw };
}
