import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Server } from "bun";
import {
	lookupRole,
	type OriginAllowlist,
	originAllowed,
	type Role,
	type TokenMap,
} from "../mcp/auth.ts";
import { buildServer } from "../mcp/server.ts";
import type { WorkspaceRegistry } from "../workspace.ts";

type BunServer = Server<undefined>;

export const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB

export interface HttpServerOptions {
	readonly host: string;
	readonly port: number;
	readonly tokens: TokenMap;
	readonly originAllowlist: OriginAllowlist;
	readonly registry: WorkspaceRegistry;
	readonly defaultWorkspace: string;
	readonly allowedHosts?: ReadonlySet<string>;
	readonly maxBodyBytes?: number;
	readonly logger?: HttpLogger;
}

export interface HttpLogEvent {
	readonly level: "info" | "warn" | "error";
	readonly event: string;
	readonly requestId: string;
	readonly data: Readonly<Record<string, unknown>>;
}

export interface HttpLogger {
	log(event: HttpLogEvent): void;
}

export interface RunningHttpServer {
	readonly server: BunServer;
	close(): Promise<void>;
}

interface Session {
	readonly transport: WebStandardStreamableHTTPServerTransport;
	readonly mcpServer: McpServer;
	readonly role: Role;
	readonly workspace: string;
}

function jsonResponse(
	body: Record<string, unknown>,
	init: { status: number; extraHeaders?: Record<string, string> },
): Response {
	const headers: Record<string, string> = {
		"content-type": "application/json",
		...(init.extraHeaders ?? {}),
	};
	return new Response(JSON.stringify(body), { status: init.status, headers });
}

function textResponse(body: string, status: number): Response {
	return new Response(body, { status, headers: { "content-type": "text/plain" } });
}

function hostAllowed(allowedHosts: ReadonlySet<string> | undefined, host: string | null): boolean {
	if (allowedHosts === undefined || allowedHosts.size === 0) return true;
	if (host === null) return false;
	return allowedHosts.has(host) || allowedHosts.has(host.split(":")[0] ?? host);
}

function makeRequestId(): string {
	return crypto.randomUUID();
}

const defaultLogger: HttpLogger = {
	log(event): void {
		const line = JSON.stringify({ ...event, ts: new Date().toISOString() });
		process.stderr.write(`${line}\n`);
	},
};

export function startHttpServer(opts: HttpServerOptions): RunningHttpServer {
	const sessions = new Map<string, Session>();
	const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
	const logger = opts.logger ?? defaultLogger;

	const handleHealth = (): Response => textResponse("ok", 200);

	const handleReady = (requestId: string): Response => {
		try {
			const ws = opts.registry.get(opts.defaultWorkspace);
			ws.db.query("SELECT 1").get();
			return textResponse("ready", 200);
		} catch (err) {
			logger.log({
				level: "error",
				event: "readyz_failed",
				requestId,
				data: { message: (err as Error).message },
			});
			return textResponse(`not ready: ${(err as Error).message}`, 503);
		}
	};

	const handleMetrics = (): Response => {
		const ws = opts.registry.get(opts.defaultWorkspace);
		return new Response(ws.metrics.registry.render(), {
			status: 200,
			headers: { "content-type": "text/plain; version=0.0.4" },
		});
	};

	const handleMcp = async (req: Request, requestId: string): Promise<Response> => {
		const url = new URL(req.url);
		const origin = req.headers.get("origin");
		if (!originAllowed(opts.originAllowlist, origin)) {
			logger.log({
				level: "warn",
				event: "origin_denied",
				requestId,
				data: { origin },
			});
			return jsonResponse(
				{ error: "origin not allowed" },
				{ status: 403, extraHeaders: { "x-request-id": requestId } },
			);
		}
		if (!hostAllowed(opts.allowedHosts, req.headers.get("host"))) {
			logger.log({
				level: "warn",
				event: "host_denied",
				requestId,
				data: { host: req.headers.get("host") },
			});
			return jsonResponse(
				{ error: "host not allowed" },
				{ status: 400, extraHeaders: { "x-request-id": requestId } },
			);
		}

		const contentLengthRaw = req.headers.get("content-length");
		if (contentLengthRaw !== null) {
			const cl = Number.parseInt(contentLengthRaw, 10);
			if (Number.isFinite(cl) && cl > maxBodyBytes) {
				logger.log({
					level: "warn",
					event: "body_too_large",
					requestId,
					data: { declared: cl, max: maxBodyBytes },
				});
				return jsonResponse(
					{ error: "request body too large" },
					{ status: 413, extraHeaders: { "x-request-id": requestId } },
				);
			}
		}

		const role = lookupRole(opts.tokens, req.headers.get("authorization"));
		if (role === null) {
			logger.log({ level: "warn", event: "auth_failed", requestId, data: {} });
			return jsonResponse(
				{ error: "missing or invalid bearer token" },
				{
					status: 401,
					extraHeaders: {
						"x-request-id": requestId,
						"www-authenticate": 'Bearer realm="gadget-mcp"',
					},
				},
			);
		}

		const requestedWs = url.searchParams.get("workspace") ?? opts.defaultWorkspace;
		if (!opts.registry.has(requestedWs)) {
			return jsonResponse(
				{ error: `unknown workspace: ${requestedWs}` },
				{ status: 404, extraHeaders: { "x-request-id": requestId } },
			);
		}

		const sessionHeader = req.headers.get("mcp-session-id");
		if (sessionHeader !== null) {
			const session = sessions.get(sessionHeader);
			if (session === undefined) {
				return jsonResponse(
					{ error: `session not found: ${sessionHeader}` },
					{ status: 404, extraHeaders: { "x-request-id": requestId } },
				);
			}
			return session.transport.handleRequest(req);
		}

		const ws = opts.registry.get(requestedWs);
		const transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: () => crypto.randomUUID(),
			onsessioninitialized: (sid): void => {
				sessions.set(sid, { transport, mcpServer: server, role, workspace: requestedWs });
				logger.log({
					level: "info",
					event: "session_opened",
					requestId,
					data: { sessionId: sid, workspace: requestedWs, role },
				});
			},
			onsessionclosed: (sid): void => {
				sessions.delete(sid);
				logger.log({
					level: "info",
					event: "session_closed",
					requestId,
					data: { sessionId: sid },
				});
			},
		});
		const server = buildServer({
			repo: ws.repo,
			runnerRepo: ws.runnerRepo,
			role,
			actor: `http:${role}`,
			audit: ws.audit,
			metrics: ws.metrics,
			workspace: ws.name,
			db: ws.db,
		});
		await server.connect(transport);
		return transport.handleRequest(req);
	};

	const bun = Bun.serve({
		hostname: opts.host,
		port: opts.port,
		fetch(req): Response | Promise<Response> {
			const requestId = req.headers.get("x-request-id") ?? makeRequestId();
			const url = new URL(req.url);
			if (url.pathname === "/healthz") return handleHealth();
			if (url.pathname === "/readyz") return handleReady(requestId);
			if (url.pathname === "/metrics") return handleMetrics();
			if (url.pathname === "/mcp") return handleMcp(req, requestId);
			return jsonResponse(
				{ error: "route not found" },
				{ status: 404, extraHeaders: { "x-request-id": requestId } },
			);
		},
	});

	return {
		server: bun,
		async close(): Promise<void> {
			for (const s of sessions.values()) {
				try {
					await s.transport.close();
				} catch {
					// ignore
				}
				try {
					await s.mcpServer.close();
				} catch {
					// ignore
				}
			}
			sessions.clear();
			bun.stop(true);
		},
	};
}

export function parseAllowedHosts(raw: string | undefined): ReadonlySet<string> {
	if (raw === undefined || raw.trim() === "") return new Set();
	const set = new Set<string>();
	for (const part of raw.split(",")) {
		const v = part.trim();
		if (v !== "") set.add(v);
	}
	return set;
}
