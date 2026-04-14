import type { Db } from "../db/connection.ts";
import { newRevisionId } from "../domain/id.ts";

export interface AuditRecord {
	readonly actor: string;
	readonly tool: string;
	readonly args: unknown;
	readonly resultCode: string;
	readonly gadgetId?: string;
	readonly correlationId?: string;
}

export interface AuditEntry {
	readonly id: string;
	readonly ts: number;
	readonly actor: string;
	readonly tool: string;
	readonly args: unknown;
	readonly resultCode: string;
	readonly gadgetId: string | null;
	readonly correlationId: string | null;
}

function serializeArgs(args: unknown): string {
	try {
		return JSON.stringify(args ?? {});
	} catch {
		return "{}";
	}
}

export class AuditWriter {
	readonly #db: Db;
	constructor(db: Db) {
		this.#db = db;
	}

	record(rec: AuditRecord): void {
		try {
			const ts = Date.now();
			this.#db
				.prepare(
					`INSERT INTO audit_log (id, ts, actor, tool, args_json, result_code, gadget_id, correlation_id)
					 VALUES ($id, $ts, $actor, $tool, $args, $code, $gid, $cid)`,
				)
				.run({
					$id: newRevisionId(ts),
					$ts: ts,
					$actor: rec.actor,
					$tool: rec.tool,
					$args: serializeArgs(rec.args),
					$code: rec.resultCode,
					$gid: rec.gadgetId ?? null,
					$cid: rec.correlationId ?? null,
				});
		} catch {
			// best-effort: never block primary op
		}
	}

	tail(limit: number): AuditEntry[] {
		const n = Math.max(1, Math.min(1000, Math.floor(limit)));
		const rows = this.#db
			.query(
				`SELECT id, ts, actor, tool, args_json, result_code, gadget_id, correlation_id
				 FROM audit_log ORDER BY ts DESC, id DESC LIMIT $n`,
			)
			.all({ $n: n }) as {
			id: string;
			ts: number;
			actor: string;
			tool: string;
			args_json: string;
			result_code: string;
			gadget_id: string | null;
			correlation_id: string | null;
		}[];
		return rows.map((r) => {
			let args: unknown = {};
			try {
				args = JSON.parse(r.args_json);
			} catch {
				args = {};
			}
			return {
				id: r.id,
				ts: r.ts,
				actor: r.actor,
				tool: r.tool,
				args,
				resultCode: r.result_code,
				gadgetId: r.gadget_id,
				correlationId: r.correlation_id,
			};
		});
	}

	pruneOlderThan(retentionMs: number): number {
		if (retentionMs <= 0) return 0;
		const cutoff = Date.now() - retentionMs;
		const res = this.#db
			.prepare("DELETE FROM audit_log WHERE ts < $cutoff")
			.run({ $cutoff: cutoff });
		return Number(res.changes);
	}

	count(): number {
		const row = this.#db.query("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number };
		return row?.n ?? 0;
	}
}

export function resolveRetentionMs(env: string | undefined): number {
	const days = Number.parseInt(env ?? "90", 10);
	if (!Number.isFinite(days) || days < 0) return 90 * 86_400_000;
	return days * 86_400_000;
}
