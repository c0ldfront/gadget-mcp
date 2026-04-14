export type Role = "reader" | "writer" | "admin";

export const ROLES: readonly Role[] = ["reader", "writer", "admin"];

const ROLE_LEVEL: Record<Role, number> = { reader: 0, writer: 1, admin: 2 };

export function roleAllows(actual: Role, required: Role): boolean {
	return ROLE_LEVEL[actual] >= ROLE_LEVEL[required];
}

export interface TokenMap {
	readonly map: ReadonlyMap<string, Role>;
	readonly enabled: boolean;
}

function isRole(value: string): value is Role {
	return value === "reader" || value === "writer" || value === "admin";
}

export function parseTokens(raw: string | undefined): TokenMap {
	if (raw === undefined || raw.trim() === "") return { map: new Map(), enabled: false };
	const map = new Map<string, Role>();
	for (const part of raw.split(",")) {
		const [tok, role] = part.split(":").map((s) => s.trim());
		if (tok === undefined || tok === "" || role === undefined || !isRole(role)) continue;
		map.set(tok, role);
	}
	return { map, enabled: true };
}

export function lookupRole(tokens: TokenMap, authHeader: string | null): Role | null {
	if (!tokens.enabled) return "admin";
	if (authHeader === null) return null;
	const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
	if (match === null || match[1] === undefined) return null;
	return tokens.map.get(match[1]) ?? null;
}

export interface OriginAllowlist {
	readonly enabled: boolean;
	readonly origins: ReadonlySet<string>;
}

export function parseOriginAllowlist(raw: string | undefined): OriginAllowlist {
	if (raw === undefined || raw.trim() === "") return { enabled: false, origins: new Set() };
	const origins = new Set<string>();
	for (const part of raw.split(",")) {
		const v = part.trim();
		if (v !== "") origins.add(v);
	}
	return { enabled: origins.size > 0, origins };
}

export function originAllowed(allowlist: OriginAllowlist, origin: string | null): boolean {
	if (!allowlist.enabled) return true;
	if (origin === null) return false;
	return allowlist.origins.has(origin);
}

export const TOOL_REQUIRED_ROLES: Readonly<Record<string, Role>> = {
	"gadget.list-gadgets": "reader",
	"gadget.get-gadget": "reader",
	"gadget.search-gadgets": "reader",
	"gadget.compose-prompt": "reader",
	"gadget.list-revisions": "reader",
	"gadget.list-runners": "reader",
	"gadget.list-client-roots": "reader",
	"gadget.export-gadgets": "reader",
	"gadget.project-kickoff": "reader",
	"gadget.add-gadget": "writer",
	"gadget.put-gadget": "writer",
	"gadget.rename-gadget": "writer",
	"gadget.rollback-gadget": "writer",
	"gadget.import-gadgets": "writer",
	"gadget.run-reviewer": "writer",
	"gadget.upsert-runner": "admin",
	"gadget.delete-gadget": "admin",
	"gadget.delete-runner": "admin",
};
