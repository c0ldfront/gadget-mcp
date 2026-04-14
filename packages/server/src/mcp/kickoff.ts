import { COMPOSE_ORDER, type GadgetCategory, type GadgetRepo } from "@gadget/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// ── domain types ────────────────────────────────────────────────────────────

export const PROJECT_TYPES = [
	"cli",
	"web-service",
	"mcp-server",
	"library",
	"proxy",
	"daemon",
	"desktop-app",
] as const;
export type ProjectType = (typeof PROJECT_TYPES)[number];

export const RUNTIMES = ["bun", "node", "deno", "python", "rust", "go"] as const;
export type Runtime = (typeof RUNTIMES)[number];

export const QUALITY_BARS = ["enterprise", "prototype"] as const;
export type QualityBar = (typeof QUALITY_BARS)[number];

export interface KickoffAnswers {
	readonly name: string;
	readonly path: string;
	readonly goal: string;
	readonly projectType: ProjectType;
	readonly runtime: Runtime;
	readonly qualityBar: QualityBar;
	readonly integrations: readonly string[];
}

export interface ChainItem {
	readonly id: string;
	readonly category: GadgetCategory;
	readonly title: string;
}

export type KickoffAction = "returned" | "dispatch-now" | "plan-first" | "sampled" | "cancelled";

export interface KickoffResult {
	readonly prompt: string;
	readonly chain: readonly ChainItem[];
	readonly action: KickoffAction;
	readonly path?: string;
	readonly dispatchHint?: string;
	readonly sampled?: { readonly text: string };
}

/**
 * Imperative top-line instruction the calling LLM sees as its first line of
 * tool-result content. Phrased to suppress Claude Code's default
 * "ask-before-Task-dispatch" safety habit when the user has already
 * confirmed the action at the wizard's preview step.
 */
export function renderTopLineInstruction(
	result: Pick<KickoffResult, "action"> & { path?: string },
): string {
	switch (result.action) {
		case "dispatch-now":
			return `USER HAS APPROVED TASK DISPATCH at the wizard's preview step. Call your Task tool NOW with \`cwd\` set to \`${result.path ?? "<target path>"}\` and the composed \`prompt\` below as the subagent's task description. DO NOT re-confirm with the user — they already confirmed.`;
		case "plan-first":
			return `USER HAS APPROVED A PLAN-FIRST FLOW at the wizard's preview step. Dispatch a planning Task subagent NOW with \`cwd\` set to \`${result.path ?? "<target path>"}\` and the composed \`prompt\` below as the task — with an explicit additional instruction: "Produce an implementation blueprint only. Do not write any code, create files, or run tools that modify the filesystem." DO NOT re-confirm — user already chose plan-first.`;
		case "sampled":
			return "The host ran one LLM turn with the composed prompt on the server's behalf. The reply is in `sampled.text`. Surface it to the user.";
		case "cancelled":
			return "The user cancelled at the wizard. Stop here — do not take further action.";
		default:
			return "The wizard composed a kickoff prompt (below in `prompt`). Show it to the user and ask what they want to do with it.";
	}
}

// ── selection heuristic ─────────────────────────────────────────────────────

/**
 * Score a candidate gadget against the user's answers. Higher = better fit.
 * Pure tag/keyword matching — deterministic, testable, no LLM in the loop.
 */
export function scoreGadget(
	gadget: { id: string; tags: readonly string[]; title: string; description: string },
	answers: KickoffAnswers,
): number {
	const haystack =
		`${gadget.id} ${gadget.title} ${gadget.description} ${gadget.tags.join(" ")}`.toLowerCase();
	const needles = [
		answers.runtime,
		answers.projectType,
		...answers.integrations.map((s) => s.toLowerCase().trim()).filter((s) => s !== ""),
	];
	let score = 0;
	for (const n of needles) {
		if (n === "") continue;
		if (haystack.includes(n)) score += 1;
	}
	// Tiny tie-breaker: prefer shorter ids (house style = focused gadgets).
	return score * 100 - gadget.id.length;
}

/**
 * Pick the best-fit gadget per canonical slot. Slots with zero matches are
 * skipped; enterprise bar additionally pulls in ALL constraint gadgets that
 * scored > 0 so the prompt inherits the full guardrail set.
 */
export function selectChain(repo: GadgetRepo, answers: KickoffAnswers): readonly ChainItem[] {
	const chain: ChainItem[] = [];
	for (const category of COMPOSE_ORDER) {
		const page = repo.list({ category, limit: 200 });
		if (page.items.length === 0) continue;
		const scored = page.items
			.map((summary) => ({ summary, score: scoreGadget(summary, answers) }))
			.filter((s) => s.score > 0)
			.sort((a, b) => b.score - a.score);
		if (scored.length === 0) continue;
		const takeAll = category === "constraint" && answers.qualityBar === "enterprise";
		const picks = takeAll ? scored : scored.slice(0, 1);
		for (const s of picks) {
			chain.push({
				id: s.summary.id,
				category: s.summary.category,
				title: s.summary.title,
			});
		}
	}
	return chain;
}

// ── built-in directive blocks ───────────────────────────────────────────────

/**
 * Per-answer directive blocks baked into the tool so the output is always
 * useful — even when the gadget library has no matches. Library-selected
 * gadgets stack on top of this baseline as extra flavor.
 */

const RUNTIME_DIRECTIVES: Record<Runtime, string> = {
	bun: "Runtime: Bun-native only. Use `Bun.file`, `Bun.write`, `Bun.$` (array form), `Bun.spawn` (shell:false), native `fetch`, `Bun.CryptoHasher`, `bun:sqlite`, `bun:test`. Forbidden in source: express, better-sqlite3, execa, ws, ioredis, pg, postgres.js, axios, node-fetch, dotenv, ts-node, jest, vitest. `node:fs` read/writeFile is forbidden; `node:path` and `node:os` (tmpdir only in tests) are allowed. Zero deprecated APIs.",
	node: "Runtime: Node.js on the active LTS. Prefer the standard library (`node:fs/promises`, `node:http`, `node:crypto`) over third-party shims. Promises only — no legacy callback APIs. TypeScript via tsc with strict mode; Vitest or `node:test` for tests. Zero deprecated APIs.",
	deno: "Runtime: Deno. Use the standard library under `@std/*` and JSR imports. `deno test` for tests, `deno fmt` + `deno lint`. Leverage top-level permissions (`--allow-net`, `--allow-read`) — do not request broader perms than needed.",
	python:
		"Runtime: Python 3.12+. Use `uv` for dependency and venv management. Strict typing with `ty`/`mypy`; formatter+linter is `ruff`; tests with `pytest`. Async-first for I/O; stdlib `pathlib` over `os.path`.",
	rust: "Runtime: Rust stable. Cargo workspaces; `clippy -- -D warnings` and `cargo fmt --check` gate every commit. Unit tests inline (`#[cfg(test)]`), integration tests under `tests/`. No `unwrap()` in production paths — propagate errors via `?` into a typed `thiserror` enum.",
	go: "Runtime: Go on the current stable. `gofmt` + `goimports` + `staticcheck` all clean. `go test ./...` green. Errors wrapped with `%w` for unwrap support. Contexts threaded through every I/O call site.",
};

const QUALITY_BAR_DIRECTIVES: Record<QualityBar, string> = {
	enterprise:
		"Quality bar: enterprise. Strict typechecking with explicit public API return types and zero `any`/untyped escapes. Sibling `*.test.ts` (or equivalent) for every function-level source file. A single `*_ERROR_CODES` registry funneled through one domain-error factory — no bare `throw new Error(...)` in library code. Observability is first-class: `/healthz`, `/readyz`, `/metrics` (Prometheus text v0.0.4), append-only audit log, structured JSON logs. Release ships per-triple compiled binaries with `SHA256SUMS.txt` and a CycloneDX 1.5 SBOM. Commit per feature only when lint + typecheck + tests are all green.",
	prototype:
		"Quality bar: prototype. Keep it tight but pragmatic — working code over exhaustive coverage. A happy-path test per module is enough; defer property tests and exhaustive edge cases until the shape settles. Skip heavy linter configs until the domain stabilizes. Ship, observe, then harden.",
};

const PROJECT_TYPE_DIRECTIVES: Record<ProjectType, string> = {
	cli: "Shape: single-binary CLI. Ship `--help`, `--version`, and a config stanza in `package.json` (or equivalent) that the build script reads. Parse argv by hand — no heavy arg library. Exit codes: 0 OK, 1 domain error, 2 CLI usage error. Respect `NO_COLOR` and `CI` env vars.",
	"web-service":
		"Shape: HTTP service. Expose `/healthz` (liveness, always 200), `/readyz` (probes dependencies), `/metrics` (Prometheus text v0.0.4). Graceful shutdown on SIGINT/SIGTERM — drain in-flight requests, close pools, then exit. Request body size limit, origin allowlist, bearer-token RBAC. Every request gets a correlation id.",
	"mcp-server":
		"Shape: MCP server. Use `@modelcontextprotocol/sdk`'s `McpServer` with `registerTool` (zod `inputSchema` + `outputSchema` + per-arg `.describe()` + annotations: `readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint`), `registerResource` (URI templates with completion), `registerPrompt` (argsSchema with `completable`). Handle `notifications/message` + `notifications/progress` and `AbortSignal` cancellation. Ship both stdio and Streamable HTTP transports. Role-gate tools at registration time so unauthorized tools never appear in `tools/list`.",
	library:
		"Shape: library / npm package. Public API surface is the export barrel only; internal modules stay unexported. Ship types (`.d.ts`) alongside runtime. Never call `process.exit`. Zero side effects at import time. Publish-ready with `files` whitelist and an `exports` map.",
	proxy:
		"Shape: proxy. Stream request and response bodies — do not buffer unless semantically required. Propagate client cancellation via `AbortSignal` to the upstream request so abandoned calls free upstream resources. Map upstream failure modes: 5xx → retry with jittered backoff (bounded attempts), 429 → pass through `Retry-After`, timeouts → surface as 504. Configurable origin/host allowlists and bearer-token RBAC. Schema-validate every request at the boundary.",
	daemon:
		"Shape: long-running daemon. systemd unit / launchd plist in the release artifacts. Log rotation aware — don't hold file handles across rotations. Signal handling: SIGHUP reloads config, SIGTERM drains and exits 0, SIGUSR1 dumps diagnostics. State lives under `XDG_STATE_HOME` (Linux) or `~/Library/Application Support` (macOS).",
	"desktop-app":
		"Shape: desktop app. OS-native packaging (.dmg, .msi, .AppImage). Code-signed on macOS and Windows. Auto-update channel with signed manifests. No privileged install steps without explicit user consent.",
};

const INTEGRATION_DIRECTIVES: Record<string, string> = {
	mcp: "MCP: use the official `@modelcontextprotocol/sdk` client or server. `registerTool` with both `inputSchema` and `outputSchema`, per-arg `.describe()`, and standardized annotations. Never advertise tools the caller's role can't invoke.",
	sqlite:
		"SQLite: `bun:sqlite` with WAL journal and `PRAGMA foreign_keys=ON`. Parameterize every value via `$name` bindings — no string interpolation of untrusted input. Migrations are hand-rolled and idempotent; FTS5 virtual tables stay consistent via insert/delete/update triggers.",
	openai:
		"OpenAI-compat: implement `POST /v1/chat/completions` and `/v1/models` faithfully — `messages[]` (system, user, assistant, tool, multimodal `content` parts), `tools[]` + `tool_choice`, `stream:true` with SSE framing (`data: {...}\\n\\n`, terminal `data: [DONE]\\n\\n`), `response_format`, `temperature`/`top_p`/`stop`/`max_tokens`/`seed`/`user`, bearer `Authorization` passthrough.",
	"openai-compat":
		"OpenAI-compat: implement `POST /v1/chat/completions` and `/v1/models` faithfully — `messages[]` (system, user, assistant, tool, multimodal `content` parts), `tools[]` + `tool_choice`, `stream:true` with SSE framing (`data: {...}\\n\\n`, terminal `data: [DONE]\\n\\n`), `response_format`, `temperature`/`top_p`/`stop`/`max_tokens`/`seed`/`user`, bearer `Authorization` passthrough.",
	sse: "SSE: strict framing (`data: {...}\\n\\n`). Flush per frame. Handle partial frames at the transport boundary. Send a heartbeat comment (`:ping\\n\\n`) every 15 s on idle connections so proxies don't drop the stream.",
	github:
		"GitHub: prefer the `gh` CLI over raw REST where it covers the use case. Release tags `v*` trigger the release workflow. Use `actions/attest-build-provenance` for OIDC-signed provenance on artifacts.",
	prometheus:
		"Prometheus: emit hand-rolled text v0.0.4 from `/metrics`. Canonical series: `*_calls_total{…,result=}` (counter), `*_duration_seconds{…}` (histogram with sensible buckets), `*_<resource>_total` (gauge). No client library dependency.",
};

function renderIntegrationBlock(integrations: readonly string[]): string | null {
	if (integrations.length === 0) return null;
	const blocks: string[] = [];
	for (const raw of integrations) {
		const key = raw.toLowerCase().trim();
		const directive = INTEGRATION_DIRECTIVES[key];
		if (directive !== undefined) {
			blocks.push(directive);
		} else {
			blocks.push(
				`${raw}: external integration — research the current API surface before touching it.`,
			);
		}
	}
	return blocks.join("\n\n");
}

function renderCommitFooter(bar: QualityBar): string {
	if (bar === "enterprise") {
		return "Commit discipline: conventional commits (`feat(scope):`, `fix(scope):`, `chore:`, `docs:`), one feature per commit, all gates green before commit. Never `--amend` published history; never `--no-verify`.";
	}
	return "Commit discipline: conventional-commit format encouraged but not enforced. Land coherent chunks; rebase-squash messy history before merging.";
}

/**
 * Scope directive — keeps the downstream build agent from scanning sibling
 * projects for reference implementations. Placed right after the header so
 * it frames every subsequent directive.
 */
export function renderScopeDirective(path: string): string {
	return `Scope: every read and write target MUST be inside \`${path}\`. Do NOT consult, read, or copy from analogous projects elsewhere on the filesystem — derive every design decision from the spec in this prompt alone. If a pattern or library choice is not specified here, pick a reasonable default and note the rationale in the commit message rather than scanning sibling directories. The only reads outside \`${path}\` that are acceptable are the host language/runtime's own stdlib or package metadata (e.g. \`node_modules\`, \`~/.bun\`).`;
}

// ── prompt assembly ─────────────────────────────────────────────────────────

/**
 * Render a paragraph-style kickoff prompt. Always produces a useful body
 * regardless of library state:
 *
 *   1. Header   — name / path / goal / type / runtime / quality bar / integrations
 *   2. Scope    — read/write boundary (stay within the target path)
 *   3. Runtime  — Bun-native / Node LTS / Deno / Python uv / Rust stable / Go stdlib
 *   4. Quality  — enterprise guardrails vs. prototype velocity
 *   5. Type     — per-project-type shape directives (proxy, mcp-server, etc.)
 *   6. Integrations — per-named-integration directives, or a generic stub
 *   7. Library  — any gadget bodies selected by the scoring heuristic
 *   8. Commits  — commit / amend / --no-verify discipline
 */
export function assemblePrompt(
	repo: GadgetRepo,
	answers: KickoffAnswers,
	chain: readonly ChainItem[],
): string {
	const header = [
		`Build \`${answers.name}\` at \`${answers.path}\`.`,
		`Goal: ${answers.goal.trim()}`,
		`Project type: ${answers.projectType}. Runtime: ${answers.runtime}. Quality bar: ${answers.qualityBar}.`,
		answers.integrations.length > 0
			? `Integrations: ${answers.integrations.join(", ")}.`
			: "Integrations: (none specified).",
	].join("\n");

	const parts: string[] = [header];
	parts.push(renderScopeDirective(answers.path));
	parts.push(RUNTIME_DIRECTIVES[answers.runtime]);
	parts.push(QUALITY_BAR_DIRECTIVES[answers.qualityBar]);
	parts.push(PROJECT_TYPE_DIRECTIVES[answers.projectType]);
	const integrationBlock = renderIntegrationBlock(answers.integrations);
	if (integrationBlock !== null) parts.push(integrationBlock);
	for (const item of chain) {
		const g = repo.resolve(item.id);
		if (g === null) continue;
		parts.push(g.content);
	}
	parts.push(renderCommitFooter(answers.qualityBar));
	return parts.join("\n\n");
}

// ── elicitation orchestration ───────────────────────────────────────────────

export interface KickoffRunner {
	elicit<T>(args: { message: string; requestedSchema: ElicitSchema }): Promise<ElicitOutcome<T>>;
}

export interface ElicitSchema {
	readonly type: "object";
	readonly properties: Record<string, ElicitField>;
	readonly required?: readonly string[];
}

export type ElicitField =
	| { type: "string"; title?: string; description?: string; default?: string }
	| {
			type: "string";
			title?: string;
			description?: string;
			enum: readonly string[];
			enumNames?: readonly string[];
			default?: string;
	  }
	| { type: "boolean"; title?: string; description?: string; default?: boolean }
	| { type: "number"; title?: string; description?: string; default?: number };

export interface ElicitOutcome<T> {
	readonly action: "accept" | "decline" | "cancel";
	readonly content?: T;
}

/**
 * Default per-step elicitation timeout — 10 minutes. The SDK's
 * `DEFAULT_REQUEST_TIMEOUT_MSEC` is 60 seconds, which isn't enough for a
 * human filling a multi-step wizard. Overridable per-process via
 * `GADGET_KICKOFF_TIMEOUT_MS`.
 */
export const DEFAULT_KICKOFF_ELICIT_TIMEOUT_MS = 10 * 60_000;

export function resolveElicitTimeoutMs(raw: string | undefined): number {
	if (raw === undefined || raw.trim() === "") return DEFAULT_KICKOFF_ELICIT_TIMEOUT_MS;
	const parsed = Number.parseInt(raw.trim(), 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_KICKOFF_ELICIT_TIMEOUT_MS;
	return parsed;
}

/**
 * Wrap `McpServer.server.elicitInput` so tests can inject a stub runner.
 * `timeoutMs` overrides the SDK's 60-second default per step.
 */
export function mcpRunner(mcp: McpServer, timeoutMs: number): KickoffRunner {
	return {
		async elicit<T>(args: {
			message: string;
			requestedSchema: ElicitSchema;
		}): Promise<ElicitOutcome<T>> {
			// The SDK's elicitInput parameter type is an overloaded union with
			// mutable arrays and enumerations; our domain `ElicitSchema` is
			// `readonly`. A JSON round-trip produces a structurally equivalent
			// mutable copy the SDK accepts.
			const mutableSchema = JSON.parse(JSON.stringify(args.requestedSchema));
			const res = await mcp.server.elicitInput(
				{
					message: args.message,
					requestedSchema: mutableSchema,
				},
				{ timeout: timeoutMs },
			);
			return { action: res.action, content: res.content as T | undefined };
		},
	};
}

interface BasicsPayload {
	name: string;
	path: string;
	goal: string;
}

interface TypePayload {
	projectType: ProjectType;
}

interface StackPayload {
	runtime: Runtime;
	qualityBar: QualityBar;
}

interface IntegrationsPayload {
	integrations: string;
}

interface PreviewPayload {
	action: "return" | "dispatch-now" | "plan-first" | "sample" | "cancel";
}

/**
 * Run the interview, compose the prompt, and dispatch according to the
 * user's preview-step pick. Three mutually-exclusive dispatch modes
 * demonstrate the three MCP server-driven continuation primitives:
 *
 *  - `return` — plain tool result. LLM reads the prompt and decides.
 *  - `task`   — tool result + explicit `dispatchHint` asking the LLM
 *               to use its Task subagent in the target path.
 *  - `sample` — server calls `sampling/createMessage` with the prompt
 *               and returns whatever the host model produced.
 *
 * Graceful fallback: if any elicitation throws (client lacks support),
 * the outer caller catches and surfaces a helpful error.
 */
export async function runKickoff(
	runner: KickoffRunner,
	repo: GadgetRepo,
	sample: (prompt: string) => Promise<string>,
): Promise<KickoffResult> {
	const basics = await runner.elicit<BasicsPayload>({
		message: "Project basics — what are you building, and where?",
		requestedSchema: {
			type: "object",
			properties: {
				name: {
					type: "string",
					title: "Project name",
					description: "e.g. opencode-openai-compat",
				},
				path: {
					type: "string",
					title: "Absolute path",
					description: "Target directory, e.g. /home/you/apps/opencode-openai-compat",
				},
				goal: {
					type: "string",
					title: "Goal (free-form paragraph)",
					description:
						"Prose description of what the thing does. Gets embedded verbatim in the kickoff prompt.",
				},
			},
			required: ["name", "path", "goal"],
		},
	});
	if (basics.action !== "accept" || basics.content === undefined) {
		return { prompt: "", chain: [], action: "cancelled" };
	}

	const type = await runner.elicit<TypePayload>({
		message: "Project type?",
		requestedSchema: {
			type: "object",
			properties: {
				projectType: {
					type: "string",
					title: "Project type",
					description: "Drives which role + context gadgets get chained.",
					enum: [...PROJECT_TYPES],
				},
			},
			required: ["projectType"],
		},
	});
	if (type.action !== "accept" || type.content === undefined) {
		return { prompt: "", chain: [], action: "cancelled" };
	}

	const stack = await runner.elicit<StackPayload>({
		message: "Runtime and quality bar?",
		requestedSchema: {
			type: "object",
			properties: {
				runtime: {
					type: "string",
					title: "Runtime",
					description: "Drives which language/runtime constraint gadgets chain in.",
					enum: [...RUNTIMES],
				},
				qualityBar: {
					type: "string",
					title: "Quality bar",
					description:
						"enterprise pulls in the full guardrail constraint set; prototype keeps only best-fit constraints.",
					enum: [...QUALITY_BARS],
				},
			},
			required: ["runtime", "qualityBar"],
		},
	});
	if (stack.action !== "accept" || stack.content === undefined) {
		return { prompt: "", chain: [], action: "cancelled" };
	}

	const integrations = await runner.elicit<IntegrationsPayload>({
		message: "External integrations / APIs?",
		requestedSchema: {
			type: "object",
			properties: {
				integrations: {
					type: "string",
					title: "Integrations (comma-separated, optional)",
					description: "e.g. OpenAI SDK, MCP, SQLite, GitHub — used to pick context gadgets.",
				},
			},
		},
	});
	// The integrations field is optional, so the client is free to return an
	// empty object (or a non-string value) when the user submits with the field
	// blank. Guard against both instead of blindly calling `.split`.
	const rawIntegrations =
		integrations.action === "accept" ? integrations.content?.integrations : undefined;
	const integrationList =
		typeof rawIntegrations === "string"
			? rawIntegrations
					.split(",")
					.map((s) => s.trim())
					.filter((s) => s !== "")
			: [];

	const answers: KickoffAnswers = {
		name: basics.content.name.trim(),
		path: basics.content.path.trim(),
		goal: basics.content.goal,
		projectType: type.content.projectType,
		runtime: stack.content.runtime,
		qualityBar: stack.content.qualityBar,
		integrations: integrationList,
	};

	const chain = selectChain(repo, answers);
	const prompt = assemblePrompt(repo, answers, chain);

	const preview = await runner.elicit<PreviewPayload>({
		message: `Preview (${prompt.length} chars, ${chain.length} gadgets):\n\n${prompt}\n\nPick a dispatch mode.`,
		requestedSchema: {
			type: "object",
			properties: {
				action: {
					type: "string",
					title: "Dispatch mode",
					description:
						"Pick one: `return` hands the paragraph back without dispatching; `dispatch-now` tells the calling LLM to spawn a Task subagent IMMEDIATELY in the target path (you have already confirmed — it will not re-ask); `plan-first` dispatches a planning Task that produces a blueprint only, no code; `sample` asks the host to run one LLM turn with the prompt and surfaces the response; `cancel` aborts.",
					enum: ["return", "dispatch-now", "plan-first", "sample", "cancel"],
					enumNames: [
						"return — plain tool result (I'll decide later)",
						"dispatch-now — spawn a Task subagent NOW in the target path",
						"plan-first — dispatch a planning Task (blueprint only, no code)",
						"sample — server asks host model to run one LLM turn",
						"cancel",
					],
					default: "return",
				},
			},
			required: ["action"],
		},
	});
	if (preview.action !== "accept" || preview.content === undefined) {
		return { prompt, chain, path: answers.path, action: "cancelled" };
	}
	const base = { prompt, chain, path: answers.path } as const;
	switch (preview.content.action) {
		case "cancel":
			return { ...base, action: "cancelled" };
		case "dispatch-now":
			return {
				...base,
				action: "dispatch-now",
				dispatchHint: `User has approved. Call your Task tool NOW with cwd=\`${answers.path}\` and the composed prompt as the subagent's task. Do not re-confirm.`,
			};
		case "plan-first":
			return {
				...base,
				action: "plan-first",
				dispatchHint: `User has approved a plan-first flow. Dispatch a planning Task subagent NOW with cwd=\`${answers.path}\`, the composed prompt, and an added constraint: "Produce an implementation blueprint only. Do not write code, create files, or run tools that modify the filesystem." Do not re-confirm.`,
			};
		case "sample": {
			try {
				const sampledText = await sample(prompt);
				return { ...base, action: "sampled", sampled: { text: sampledText } };
			} catch {
				return { ...base, action: "returned" };
			}
		}
		default:
			return { ...base, action: "returned" };
	}
}
