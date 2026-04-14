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

export interface KickoffResult {
	readonly prompt: string;
	readonly chain: readonly ChainItem[];
	readonly action: "returned" | "executed" | "cancelled";
	readonly executedCommand?: string;
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

// ── prompt assembly ─────────────────────────────────────────────────────────

/**
 * Render a paragraph-style kickoff prompt from the interview answers and the
 * gadget chain. The user's `goal` stays verbatim; the chain's content is
 * fetched from the repo and appended slot-by-slot.
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
	const bodies: string[] = [];
	for (const item of chain) {
		const g = repo.resolve(item.id);
		if (g === null) continue;
		bodies.push(g.content);
	}
	if (bodies.length === 0) {
		return `${header}\n\n(No matching gadgets were found in the library for these answers — write your own prompt body here.)`;
	}
	return `${header}\n\n${bodies.join("\n\n")}`;
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
	action: "return" | "execute" | "cancel";
}

/**
 * Run the full five-step interview, compose the prompt, and optionally
 * spawn the configured executor. Returns a `KickoffResult` describing
 * what happened.
 *
 * Graceful fallback: if any elicitation throws (client lacks support),
 * the outer caller catches and returns a template.
 */
export async function runKickoff(
	runner: KickoffRunner,
	repo: GadgetRepo,
	env: { GADGET_KICKOFF_EXEC?: string | undefined },
	spawn: (command: string, cwd: string, stdin: string) => Promise<number>,
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
	const integrationList =
		integrations.action === "accept" && integrations.content !== undefined
			? integrations.content.integrations
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
		message: `Preview (${prompt.length} chars, ${chain.length} gadgets):\n\n${prompt}\n\nWhat next?`,
		requestedSchema: {
			type: "object",
			properties: {
				action: {
					type: "string",
					title: "Action",
					description:
						"`return` hands the paragraph back; `execute` spawns $GADGET_KICKOFF_EXEC in the project path; `cancel` aborts.",
					enum: ["return", "execute", "cancel"],
					default: "return",
				},
			},
			required: ["action"],
		},
	});
	if (preview.action !== "accept" || preview.content === undefined) {
		return { prompt, chain, action: "cancelled" };
	}
	if (preview.content.action === "cancel") {
		return { prompt, chain, action: "cancelled" };
	}
	if (preview.content.action === "execute") {
		const cmd = env.GADGET_KICKOFF_EXEC;
		if (cmd === undefined || cmd === "") {
			return { prompt, chain, action: "returned" };
		}
		try {
			await spawn(cmd, answers.path, prompt);
			return { prompt, chain, action: "executed", executedCommand: cmd };
		} catch {
			return { prompt, chain, action: "returned" };
		}
	}
	return { prompt, chain, action: "returned" };
}
