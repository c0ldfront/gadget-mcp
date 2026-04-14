export type GenerateFormat = "claude-desktop" | "cursor" | "vscode" | "mcp-json" | "shell-env";

export const FORMATS: readonly GenerateFormat[] = [
	"claude-desktop",
	"cursor",
	"vscode",
	"mcp-json",
	"shell-env",
] as const;

export function isGenerateFormat(value: string): value is GenerateFormat {
	return (FORMATS as readonly string[]).includes(value);
}

export interface GenerateOptions {
	readonly format: GenerateFormat;
	readonly mode: "stdio" | "http";
	readonly url?: string;
	readonly token?: string;
	readonly workspace: string;
	readonly dbPath?: string;
	readonly binary?: string;
	readonly httpHost?: string;
	readonly httpPort?: number;
	readonly serverName?: string;
}

interface StdioEntry {
	readonly command: string;
	readonly args: string[];
	readonly env?: Record<string, string>;
}

interface HttpEntry {
	readonly type: "http";
	readonly url: string;
	readonly headers?: Record<string, string>;
}

function stdioEntry(opts: GenerateOptions): StdioEntry {
	const binary = opts.binary ?? "gadget-mcp";
	const args: string[] = [];
	if (opts.workspace !== "default") args.push(`--workspace=${opts.workspace}`);
	args.push("--stdio");
	const env: Record<string, string> = {};
	if (opts.dbPath !== undefined) env.GADGET_DB = opts.dbPath;
	return {
		command: binary,
		args,
		...(Object.keys(env).length > 0 ? { env } : {}),
	};
}

function httpEntry(opts: GenerateOptions): HttpEntry {
	if (opts.url === undefined) {
		throw new Error("--url is required for --http mode");
	}
	const separator = opts.url.includes("?") ? "&" : "?";
	const withWorkspace =
		opts.workspace === "default" ? opts.url : `${opts.url}${separator}workspace=${opts.workspace}`;
	const headers: Record<string, string> = {};
	if (opts.token !== undefined) headers.Authorization = `Bearer ${opts.token}`;
	return {
		type: "http",
		url: withWorkspace,
		...(Object.keys(headers).length > 0 ? { headers } : {}),
	};
}

export function generateConfig(opts: GenerateOptions): string {
	const name = opts.serverName ?? "gadget";
	if (opts.format === "shell-env") return renderShellEnv(opts);
	const entry = opts.mode === "stdio" ? stdioEntry(opts) : httpEntry(opts);
	switch (opts.format) {
		case "claude-desktop":
		case "cursor":
		case "mcp-json":
			return JSON.stringify({ mcpServers: { [name]: entry } }, null, 2);
		case "vscode":
			return JSON.stringify({ servers: { [name]: entry } }, null, 2);
		default: {
			const _exhaustive: never = opts.format;
			throw new Error(`unknown format: ${_exhaustive as string}`);
		}
	}
}

function renderShellEnv(opts: GenerateOptions): string {
	const lines: string[] = [];
	if (opts.dbPath !== undefined) lines.push(`export GADGET_DB='${opts.dbPath}'`);
	lines.push(`export GADGET_WORKSPACE='${opts.workspace}'`);
	if (opts.httpHost !== undefined) lines.push(`export GADGET_HTTP_HOST='${opts.httpHost}'`);
	if (opts.httpPort !== undefined) {
		lines.push(`export GADGET_HTTP_PORT='${opts.httpPort.toString()}'`);
	}
	if (opts.token !== undefined) {
		lines.push(`export GADGET_HTTP_TOKENS='${opts.token}:admin'`);
	}
	return `${lines.join("\n")}\n`;
}
