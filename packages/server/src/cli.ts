#!/usr/bin/env bun
import { mkdir, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { resolveRetentionMs, seedFromFiles } from "@gadget/core";
import { FORMATS, type GenerateFormat, generateConfig, isGenerateFormat } from "./cli-generate.ts";
import { parseOriginAllowlist, parseTokens } from "./mcp/auth.ts";
import { SERVER_NAME, SERVER_VERSION } from "./mcp/server.ts";
import { parseAllowedHosts, startHttpServer } from "./transport/http.ts";
import { runStdio } from "./transport/stdio.ts";
import { parseWorkspaces, WorkspaceRegistry } from "./workspace.ts";

interface ParsedCli {
	readonly command: "serve" | "backup" | "restore" | "generate" | "audit-tail" | "help" | "version";
	readonly stdio?: boolean;
	readonly http?: boolean;
	readonly workspace?: string;
	readonly host?: string;
	readonly port?: number;
	readonly out?: string;
	readonly in?: string;
	readonly format?: GenerateFormat;
	readonly url?: string;
	readonly token?: string;
	readonly dbPath?: string;
	readonly limit?: number;
	readonly help?: boolean;
}

const HELP_TEXT = `gadget-mcp — return-prompt MCP server

USAGE
  gadget-mcp [serve] [--stdio | --http] [--workspace=NAME] [--host=HOST] [--port=N]
  gadget-mcp backup  --out PATH [--workspace=NAME]
  gadget-mcp restore --in PATH [--workspace=NAME]
  gadget-mcp audit tail [N]
  gadget-mcp generate <${FORMATS.join("|")}> [--stdio|--http] [--url URL] [--token T] [--workspace NAME] [--out PATH]
  gadget-mcp --version
  gadget-mcp --help

ENVIRONMENT
  GADGET_DB                Default SQLite path (default: ./artifacts/gadget.db)
  GADGET_WORKSPACES        JSON {name: dbPath} for multi-workspace mode
  GADGET_HTTP_HOST         HTTP bind host (default 127.0.0.1)
  GADGET_HTTP_PORT         HTTP bind port (default 7878)
  GADGET_HTTP_TOKENS       CSV of token:role pairs (reader|writer|admin)
  GADGET_ORIGIN_ALLOWLIST  CSV of allowed Origin values
  GADGET_SEED              'auto' (default) to seed from data/ at startup, or 'off'
  GADGET_AUDIT_DAYS        Audit retention in days (default 90)
`;

function takeFlag(args: readonly string[], from: number, key: string): string | null {
	const arg = args[from];
	if (arg === undefined) return null;
	if (arg === key || arg === `--${key}`) {
		const next = args[from + 1];
		return next ?? null;
	}
	if (arg.startsWith(`${key}=`)) return arg.slice(key.length + 1);
	if (arg.startsWith(`--${key}=`)) return arg.slice(key.length + 3);
	return null;
}

export function parseCli(args: readonly string[]): ParsedCli {
	let command: ParsedCli["command"] = "serve";
	let stdio = false;
	let http = false;
	let workspace: string | undefined;
	let host: string | undefined;
	let port: number | undefined;
	let out: string | undefined;
	let inPath: string | undefined;
	let format: GenerateFormat | undefined;
	let url: string | undefined;
	let token: string | undefined;
	let limit: number | undefined;
	let help = false;

	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === undefined) continue;
		if (a === "serve" || a === "backup" || a === "restore") {
			command = a;
			continue;
		}
		if (a === "audit") {
			const sub = args[i + 1];
			if (sub === "tail") {
				command = "audit-tail";
				i++;
				const n = args[i + 1];
				if (n !== undefined && /^\d+$/.test(n)) {
					limit = Number.parseInt(n, 10);
					i++;
				}
			}
			continue;
		}
		if (a === "generate") {
			command = "generate";
			const sub = args[i + 1];
			if (sub !== undefined && isGenerateFormat(sub)) {
				format = sub;
				i++;
			}
			continue;
		}
		if (a === "--help" || a === "-h") help = true;
		if (a === "--version" || a === "-v") command = "version";
		if (a === "--stdio") stdio = true;
		if (a === "--http") http = true;
		const w = takeFlag(args, i, "workspace");
		if (w !== null) workspace = w;
		const h = takeFlag(args, i, "host");
		if (h !== null) host = h;
		const p = takeFlag(args, i, "port");
		if (p !== null) port = Number.parseInt(p, 10);
		const o = takeFlag(args, i, "out");
		if (o !== null) out = o;
		const ip = takeFlag(args, i, "in");
		if (ip !== null) inPath = ip;
		const u = takeFlag(args, i, "url");
		if (u !== null) url = u;
		const t = takeFlag(args, i, "token");
		if (t !== null) token = t;
	}

	if (help) command = "help";
	return {
		command,
		stdio,
		http,
		...(workspace !== undefined ? { workspace } : {}),
		...(host !== undefined ? { host } : {}),
		...(port !== undefined ? { port } : {}),
		...(out !== undefined ? { out } : {}),
		...(inPath !== undefined ? { in: inPath } : {}),
		...(format !== undefined ? { format } : {}),
		...(url !== undefined ? { url } : {}),
		...(token !== undefined ? { token } : {}),
		...(limit !== undefined ? { limit } : {}),
		help,
	};
}

async function ensureDirFor(path: string): Promise<void> {
	await mkdir(dirname(resolve(path)), { recursive: true });
}

async function runBackup(
	registry: WorkspaceRegistry,
	workspace: string,
	out: string,
): Promise<void> {
	if (!registry.has(workspace)) throw new Error(`unknown workspace: ${workspace}`);
	const ws = registry.get(workspace);
	await ensureDirFor(out);
	await unlink(out).catch(() => undefined);
	ws.db.prepare("VACUUM INTO ?").run(out);
	process.stderr.write(`backup written: ${out}\n`);
}

async function runRestore(
	registry: WorkspaceRegistry,
	workspace: string,
	src: string,
): Promise<void> {
	if (!registry.has(workspace)) throw new Error(`unknown workspace: ${workspace}`);
	const srcFile = Bun.file(src);
	if (!(await srcFile.exists())) throw new Error(`backup not found: ${src}`);
	const ws = registry.get(workspace);
	const rows = ws.db.query("PRAGMA database_list").all() as { file: string }[];
	const target = rows.find((r) => r.file !== "")?.file;
	if (target === undefined) throw new Error("could not resolve backing db path");
	ws.db.close();
	registry.closeAll();
	await Promise.all(
		[target, `${target}-wal`, `${target}-shm`].map((p) => unlink(p).catch(() => undefined)),
	);
	await Bun.write(target, srcFile);
	process.stderr.write(`restore applied: ${target} <- ${src}\n`);
}

async function runAuditTail(
	registry: WorkspaceRegistry,
	workspace: string,
	limit: number,
): Promise<void> {
	const ws = registry.get(workspace);
	for (const e of ws.audit.tail(limit)) {
		const iso = new Date(e.ts).toISOString();
		process.stdout.write(
			`${iso} ${workspace} ${e.actor} ${e.tool} ${e.resultCode} ${e.gadgetId ?? "-"}\n`,
		);
	}
}

async function maybeSeed(registry: WorkspaceRegistry, workspace: string): Promise<void> {
	if (Bun.env.GADGET_SEED === "off") return;
	const here = new URL(".", import.meta.url).pathname;
	const repoRoot = resolve(here, "../../..");
	const gadgetsPath = resolve(repoRoot, "data/gadgets.ndjson");
	const runnersPath = resolve(repoRoot, "data/reviewer_runners.json");
	const ws = registry.get(workspace);
	try {
		await seedFromFiles(ws.repo, ws.runnerRepo, {
			gadgetsNdjsonPath: gadgetsPath,
			reviewerRunnersJsonPath: runnersPath,
		});
	} catch (err) {
		process.stderr.write(`seed skipped: ${(err as Error).message}\n`);
	}
}

async function pruneAudit(registry: WorkspaceRegistry): Promise<void> {
	const retention = resolveRetentionMs(Bun.env.GADGET_AUDIT_DAYS);
	for (const name of registry.names()) {
		try {
			const ws = registry.get(name);
			ws.audit.pruneOlderThan(retention);
		} catch {
			// ignore
		}
	}
}

async function runServe(cli: ParsedCli): Promise<void> {
	const defaultDb = Bun.env.GADGET_DB ?? "./artifacts/gadget.db";
	await ensureDirFor(defaultDb);
	const registry = new WorkspaceRegistry(parseWorkspaces(Bun.env.GADGET_WORKSPACES, defaultDb));
	const workspace = cli.workspace ?? registry.defaultName();
	await maybeSeed(registry, workspace);
	await pruneAudit(registry);

	// Auto-detect stdio mode when a parent process has piped stdin (no TTY).
	// Claude Desktop / Cursor / Codex / other MCP hosts all spawn the server
	// with a piped stdin and expect JSON-RPC framing there — they won't pass
	// `--stdio` explicitly. If the user wants HTTP inside a script that pipes
	// stdin, `--http` is explicit and wins.
	const stdinIsPipe = !process.stdin.isTTY;
	const stdioExplicit = cli.stdio === true;
	const httpExplicit = cli.http === true;
	const stdioAuto = stdinIsPipe && !httpExplicit;
	const stdio = stdioExplicit || stdioAuto;
	// HTTP runs when asked for explicitly, or when we're on a real TTY with no
	// stdio flag (interactive `crimson-mcp serve`).
	const http = httpExplicit || (!stdio && cli.http !== false && !stdinIsPipe);

	const stoppers: Array<() => Promise<void>> = [];
	if (http) {
		const host = cli.host ?? Bun.env.GADGET_HTTP_HOST ?? "127.0.0.1";
		const port = cli.port ?? Number.parseInt(Bun.env.GADGET_HTTP_PORT ?? "7878", 10);
		const maxBodyEnv = Bun.env.GADGET_HTTP_MAX_BODY_BYTES;
		const maxBodyBytes =
			maxBodyEnv !== undefined && maxBodyEnv !== "" ? Number.parseInt(maxBodyEnv, 10) : undefined;
		const running = startHttpServer({
			host,
			port,
			tokens: parseTokens(Bun.env.GADGET_HTTP_TOKENS),
			originAllowlist: parseOriginAllowlist(Bun.env.GADGET_ORIGIN_ALLOWLIST),
			allowedHosts: parseAllowedHosts(Bun.env.GADGET_HTTP_ALLOWED_HOSTS),
			...(maxBodyBytes !== undefined && Number.isFinite(maxBodyBytes) ? { maxBodyBytes } : {}),
			registry,
			defaultWorkspace: workspace,
		});
		process.stderr.write(
			`gadget-mcp: http transport listening on ${running.server.url.toString()}\n`,
		);
		stoppers.push(() => running.close());
	}
	if (stdio) {
		const stop = await runStdio({ registry, workspace });
		stoppers.push(stop);
	}

	const shutdown = async (): Promise<void> => {
		for (const stop of stoppers) {
			try {
				await stop();
			} catch {
				// ignore
			}
		}
		registry.closeAll();
		process.exit(0);
	};
	process.on("SIGINT", () => {
		void shutdown();
	});
	process.on("SIGTERM", () => {
		void shutdown();
	});
}

async function runGenerate(cli: ParsedCli): Promise<void> {
	if (cli.format === undefined) {
		process.stderr.write(`format required — one of ${FORMATS.join(", ")}\n`);
		process.exit(2);
	}
	const mode = cli.stdio === true ? "stdio" : "http";
	const workspace = cli.workspace ?? "default";
	const out = generateConfig({
		format: cli.format,
		mode,
		workspace,
		...(cli.url !== undefined ? { url: cli.url } : {}),
		...(cli.token !== undefined ? { token: cli.token } : {}),
		...(Bun.env.GADGET_DB !== undefined ? { dbPath: Bun.env.GADGET_DB } : {}),
		...(Bun.env.GADGET_HTTP_HOST !== undefined ? { httpHost: Bun.env.GADGET_HTTP_HOST } : {}),
		...(Bun.env.GADGET_HTTP_PORT !== undefined
			? { httpPort: Number.parseInt(Bun.env.GADGET_HTTP_PORT, 10) }
			: {}),
	});
	if (cli.out !== undefined) {
		await ensureDirFor(cli.out);
		await Bun.write(cli.out, out);
		process.stderr.write(`wrote ${cli.out}\n`);
	} else {
		process.stdout.write(out);
		if (!out.endsWith("\n")) process.stdout.write("\n");
	}
}

export async function main(argv: readonly string[]): Promise<void> {
	const cli = parseCli(argv);
	if (cli.command === "version") {
		process.stdout.write(`${SERVER_NAME} ${SERVER_VERSION}\n`);
		return;
	}
	if (cli.command === "help") {
		process.stdout.write(HELP_TEXT);
		return;
	}
	const defaultDb = Bun.env.GADGET_DB ?? "./artifacts/gadget.db";
	const registry = new WorkspaceRegistry(parseWorkspaces(Bun.env.GADGET_WORKSPACES, defaultDb));
	const workspace = cli.workspace ?? registry.defaultName();

	if (cli.command === "backup") {
		if (cli.out === undefined) throw new Error("--out required");
		await runBackup(registry, workspace, cli.out);
		registry.closeAll();
		return;
	}
	if (cli.command === "restore") {
		if (cli.in === undefined) throw new Error("--in required");
		await runRestore(registry, workspace, cli.in);
		return;
	}
	if (cli.command === "audit-tail") {
		await runAuditTail(registry, workspace, cli.limit ?? 50);
		registry.closeAll();
		return;
	}
	if (cli.command === "generate") {
		await runGenerate(cli);
		registry.closeAll();
		return;
	}
	// serve
	await runServe(cli);
}

if (import.meta.main === true) {
	main(process.argv.slice(2)).catch((err) => {
		process.stderr.write(`gadget-mcp: ${(err as Error).message}\n`);
		process.exit(1);
	});
}
