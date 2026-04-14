import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "../mcp/server.ts";
import type { WorkspaceRegistry } from "../workspace.ts";

export interface RunStdioOptions {
	readonly registry: WorkspaceRegistry;
	readonly workspace: string;
}

export async function runStdio(opts: RunStdioOptions): Promise<() => Promise<void>> {
	const ws = opts.registry.get(opts.workspace);
	const server = buildServer({
		repo: ws.repo,
		runnerRepo: ws.runnerRepo,
		role: "admin",
		actor: `stdio:${ws.name}`,
		audit: ws.audit,
		metrics: ws.metrics,
		workspace: ws.name,
		db: ws.db,
	});
	const transport = new StdioServerTransport();
	await server.connect(transport);
	process.stderr.write(`gadget-mcp: stdio transport ready (workspace=${ws.name})\n`);
	return async () => {
		await server.close();
		opts.registry.closeAll();
	};
}
