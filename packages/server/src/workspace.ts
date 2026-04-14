import {
	AuditWriter,
	buildGadgetMetrics,
	type Db,
	type GadgetMetrics,
	GadgetRepo,
	openDb,
	ReviewerRunnerRepo,
} from "@gadget/core";

export interface WorkspaceDef {
	readonly name: string;
	readonly dbPath: string;
}

export interface OpenWorkspace {
	readonly name: string;
	readonly db: Db;
	readonly repo: GadgetRepo;
	readonly runnerRepo: ReviewerRunnerRepo;
	readonly audit: AuditWriter;
	readonly metrics: GadgetMetrics;
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function parseWorkspaces(
	workspacesEnv: string | undefined,
	defaultDb: string,
): ReadonlyMap<string, WorkspaceDef> {
	if (workspacesEnv === undefined || workspacesEnv.trim() === "") {
		return new Map([["default", { name: "default", dbPath: defaultDb }]]);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(workspacesEnv);
	} catch (err) {
		throw new Error(`GADGET_WORKSPACES must be JSON: ${(err as Error).message}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("GADGET_WORKSPACES must be a JSON object { name: dbPath }");
	}
	const map = new Map<string, WorkspaceDef>();
	for (const [name, dbPath] of Object.entries(parsed as Record<string, unknown>)) {
		if (!NAME_PATTERN.test(name)) {
			throw new Error(`invalid workspace name: ${name}`);
		}
		if (typeof dbPath !== "string" || dbPath === "") {
			throw new Error(`workspace ${name} requires a string dbPath`);
		}
		map.set(name, { name, dbPath });
	}
	if (map.size === 0) {
		throw new Error("GADGET_WORKSPACES must contain at least one workspace");
	}
	return map;
}

export class WorkspaceRegistry {
	readonly #defs: ReadonlyMap<string, WorkspaceDef>;
	readonly #opened = new Map<string, OpenWorkspace>();

	constructor(defs: ReadonlyMap<string, WorkspaceDef>) {
		this.#defs = defs;
	}

	has(name: string): boolean {
		return this.#defs.has(name);
	}

	names(): readonly string[] {
		return [...this.#defs.keys()];
	}

	defaultName(): string {
		const first = this.#defs.keys().next().value;
		if (typeof first !== "string") {
			throw new Error("no workspaces configured");
		}
		return first;
	}

	get(name: string): OpenWorkspace {
		const cached = this.#opened.get(name);
		if (cached !== undefined) return cached;
		const def = this.#defs.get(name);
		if (def === undefined) throw new Error(`unknown workspace: ${name}`);
		const db = openDb({ path: def.dbPath });
		const opened: OpenWorkspace = {
			name,
			db,
			repo: new GadgetRepo(db),
			runnerRepo: new ReviewerRunnerRepo(db),
			audit: new AuditWriter(db),
			metrics: buildGadgetMetrics(db),
		};
		this.#opened.set(name, opened);
		return opened;
	}

	closeAll(): void {
		for (const ws of this.#opened.values()) {
			try {
				ws.db.close();
			} catch {
				// ignore
			}
		}
		this.#opened.clear();
	}
}
