import { mcpToolName, type ToolInvocation } from "../harness.ts";

interface CodexItem {
	readonly id?: string;
	readonly type?: string;
	readonly status?: string;
	readonly server?: string;
	readonly tool?: string;
	readonly text?: string;
	readonly message?: string;
}

interface CodexEvent {
	readonly type?: string;
	readonly item?: CodexItem;
	readonly msg?: CodexItem;
}

export function parseCodexToolCallsForTest(stdout: string): ToolInvocation[] {
	const out: ToolInvocation[] = [];
	const seen = new Set<string>();
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		let evt: CodexEvent;
		try {
			evt = JSON.parse(trimmed) as CodexEvent;
		} catch {
			continue;
		}
		if ((evt.type === "item.started" || evt.type === "item.completed") && evt.item !== undefined) {
			const item = evt.item;
			if (item.type === "mcp_tool_call" && typeof item.tool === "string") {
				const dedupe = `${item.id ?? ""}|${item.tool}`;
				if (seen.has(dedupe)) continue;
				seen.add(dedupe);
				const server = typeof item.server === "string" ? item.server : null;
				const { server: parsedServer, tool } = mcpToolName(item.tool);
				out.push({ name: tool, server: server ?? parsedServer, raw: evt });
				continue;
			}
		}
		const legacy = evt.msg;
		if (legacy !== undefined) {
			const legacyKind = legacy.type;
			if (legacyKind === "mcp_tool_call_begin" || legacyKind === "mcp_tool_call") {
				const rawName = legacy.tool ?? "";
				if (rawName === "") continue;
				const server = typeof legacy.server === "string" ? legacy.server : null;
				// Legacy events don't carry an item id; dedupe on (server, tool) so
				// begin + completion for the same call only counts once.
				const dedupe = `legacy|${server ?? ""}|${rawName}`;
				if (seen.has(dedupe)) continue;
				seen.add(dedupe);
				const { server: parsedServer, tool } = mcpToolName(rawName);
				out.push({ name: tool, server: server ?? parsedServer, raw: evt });
			}
		}
	}
	return out;
}

export function parseCodexFinalTextForTest(stdout: string): string {
	for (const line of stdout.split("\n").reverse()) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		try {
			const evt = JSON.parse(trimmed) as CodexEvent;
			const item = evt.item;
			if (item !== undefined && item.type === "agent_message") {
				if (typeof item.text === "string") return item.text;
				if (typeof item.message === "string") return item.message;
			}
			const legacy = evt.msg;
			if (legacy !== undefined && legacy.type === "agent_message") {
				if (typeof legacy.message === "string") return legacy.message;
				if (typeof legacy.text === "string") return legacy.text;
			}
		} catch {
			// keep scanning
		}
	}
	return "";
}
