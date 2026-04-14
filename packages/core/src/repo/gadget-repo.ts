import type { Db } from "../db/connection.ts";
import { COMPOSE_ORDER, type GadgetCategory } from "../domain/category.ts";
import {
	AliasConflictError,
	ComposeMissingIdsError,
	GadgetAlreadyExistsError,
	GadgetNotFoundError,
	RevisionMissingError,
	TooManyAliasesError,
} from "../domain/errors.ts";
import {
	type Gadget,
	type GadgetInput,
	type GadgetSummary,
	type Revision,
	toSummary,
} from "../domain/gadget.ts";
import { newRevisionId, validateGadgetId } from "../domain/id.ts";
import {
	decodeListCursor,
	decodeSearchCursor,
	encodeListCursor,
	encodeSearchCursor,
} from "./cursor.ts";

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;
export const MAX_ALIASES_PER_GADGET = 32;

export interface Clock {
	now(): number;
}
const systemClock: Clock = { now: () => Date.now() };

type Binding = string | number | bigint | boolean | null | Uint8Array;
type Bindings = Record<string, Binding>;

interface GadgetRow {
	id: string;
	category: GadgetCategory;
	title: string;
	description: string;
	content: string;
	tags_json: string;
	source: "curated" | "generated";
	created_at: number;
	updated_at: number;
}

interface RevisionRow {
	id: string;
	gadget_id: string;
	version: number;
	title: string;
	description: string;
	content: string;
	tags_json: string;
	created_at: number;
}

interface AliasRow {
	alias: string;
	gadget_id: string;
	created_at: number;
}

export interface ListInput {
	readonly category?: GadgetCategory;
	readonly limit?: number;
	readonly cursor?: string;
}

export interface SearchInput {
	readonly query: string;
	readonly category?: GadgetCategory;
	readonly limit?: number;
	readonly cursor?: string;
}

export interface Page<T> {
	readonly items: T[];
	readonly nextCursor: string | null;
}

export interface PutResult {
	readonly gadget: Gadget;
	readonly version: number;
	readonly created: boolean;
}

export interface RenameResult {
	readonly gadget: Gadget;
	readonly previousName: string;
}

export interface RollbackResult {
	readonly gadget: Gadget;
	readonly newVersion: number;
}

function hydrate(row: GadgetRow): Gadget {
	return {
		id: row.id,
		category: row.category,
		title: row.title,
		description: row.description,
		content: row.content,
		tags: JSON.parse(row.tags_json) as string[],
		source: row.source,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function hydrateRevision(row: RevisionRow): Revision {
	return {
		id: row.id,
		gadgetId: row.gadget_id,
		version: row.version,
		title: row.title,
		description: row.description,
		content: row.content,
		tags: JSON.parse(row.tags_json) as string[],
		createdAt: row.created_at,
	};
}

function clampLimit(limit: number | undefined): number {
	if (limit === undefined) return DEFAULT_PAGE_SIZE;
	if (!Number.isFinite(limit) || limit < 1) return 1;
	return Math.min(Math.floor(limit), MAX_PAGE_SIZE);
}

export class GadgetRepo {
	readonly #db: Db;
	readonly #clock: Clock;

	constructor(db: Db, clock: Clock = systemClock) {
		this.#db = db;
		this.#clock = clock;
	}

	getById(id: string): Gadget | null {
		const row = this.#db
			.query("SELECT * FROM gadgets WHERE id = $id")
			.get({ $id: id }) as GadgetRow | null;
		return row === null ? null : hydrate(row);
	}

	resolve(idOrAlias: string): Gadget | null {
		const live = this.getById(idOrAlias);
		if (live !== null) return live;
		const alias = this.#db
			.query("SELECT * FROM aliases WHERE alias = $alias")
			.get({ $alias: idOrAlias }) as AliasRow | null;
		if (alias === null) return null;
		return this.getById(alias.gadget_id);
	}

	aliasesOf(id: string): string[] {
		const rows = this.#db
			.query("SELECT * FROM aliases WHERE gadget_id = $id ORDER BY created_at ASC")
			.all({ $id: id }) as AliasRow[];
		return rows.map((r) => r.alias);
	}

	list(input: ListInput = {}): Page<GadgetSummary> {
		const limit = clampLimit(input.limit);
		const category = input.category ?? null;
		let after: { updatedAt: number; id: string } | null = null;
		if (input.cursor !== undefined) {
			const c = decodeListCursor(input.cursor);
			if (c.category !== category) {
				throw new Error("cursor category mismatch");
			}
			after = { updatedAt: c.updatedAt, id: c.id };
		}
		const params: Bindings = { $limit: limit + 1 };
		const clauses: string[] = [];
		if (category !== null) {
			clauses.push("category = $category");
			params.$category = category;
		}
		if (after !== null) {
			clauses.push("(updated_at < $updatedAt OR (updated_at = $updatedAt AND id > $afterId))");
			params.$updatedAt = after.updatedAt;
			params.$afterId = after.id;
		}
		const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
		const rows = this.#db
			.query(`SELECT * FROM gadgets ${where} ORDER BY updated_at DESC, id ASC LIMIT $limit`)
			.all(params) as GadgetRow[];
		const items = rows.slice(0, limit).map((r) => toSummary(hydrate(r)));
		let nextCursor: string | null = null;
		if (rows.length > limit) {
			const last = items[items.length - 1];
			if (last !== undefined) {
				nextCursor = encodeListCursor({
					updatedAt: last.updatedAt,
					id: last.id,
					category,
				});
			}
		}
		return { items, nextCursor };
	}

	search(input: SearchInput): Page<GadgetSummary> {
		const limit = clampLimit(input.limit);
		const q = input.query.trim();
		if (q === "") return { items: [], nextCursor: null };
		const category = input.category ?? null;
		let after: { rank: number; rowid: number } | null = null;
		if (input.cursor !== undefined) {
			const c = decodeSearchCursor(input.cursor, q);
			if (c.category !== category) {
				throw new Error("cursor category mismatch");
			}
			after = { rank: c.rank, rowid: c.rowid };
		}
		const params: Bindings = { $q: q, $limit: limit + 1 };
		const where: string[] = ["gadgets_fts MATCH $q"];
		if (category !== null) {
			where.push("g.category = $category");
			params.$category = category;
		}
		if (after !== null) {
			where.push("(bm25(gadgets_fts) > $rank OR (bm25(gadgets_fts) = $rank AND g.rowid > $rowid))");
			params.$rank = after.rank;
			params.$rowid = after.rowid;
		}
		const sql = `
			SELECT g.*, bm25(gadgets_fts) AS rank, g.rowid AS rowid
			FROM gadgets_fts
			JOIN gadgets g ON g.rowid = gadgets_fts.rowid
			WHERE ${where.join(" AND ")}
			ORDER BY bm25(gadgets_fts) ASC, g.rowid ASC
			LIMIT $limit
		`;
		const rows = this.#db.query(sql).all(params) as (GadgetRow & {
			rank: number;
			rowid: number;
		})[];
		const items = rows.slice(0, limit).map((r) => toSummary(hydrate(r)));
		let nextCursor: string | null = null;
		if (rows.length > limit) {
			const lastFull = rows[limit - 1];
			if (lastFull !== undefined) {
				nextCursor = encodeSearchCursor({
					q,
					category,
					rank: lastFull.rank,
					rowid: lastFull.rowid,
				});
			}
		}
		return { items, nextCursor };
	}

	put(input: GadgetInput): PutResult {
		validateGadgetId(input.id);
		return this.#db.transaction(() => {
			const now = this.#clock.now();
			const existing = this.getById(input.id);
			const tagsJson = JSON.stringify(input.tags);
			if (existing === null) {
				const aliasCollision = this.#db
					.query("SELECT * FROM aliases WHERE alias = $alias")
					.get({ $alias: input.id }) as AliasRow | null;
				if (aliasCollision !== null) {
					throw new AliasConflictError(input.id, aliasCollision.gadget_id);
				}
				this.#db
					.prepare(
						`INSERT INTO gadgets (id, category, title, description, content, tags_json, source, created_at, updated_at)
						 VALUES ($id, $category, $title, $description, $content, $tags, $source, $now, $now)`,
					)
					.run({
						$id: input.id,
						$category: input.category,
						$title: input.title,
						$description: input.description,
						$content: input.content,
						$tags: tagsJson,
						$source: input.source,
						$now: now,
					});
			} else {
				this.#db
					.prepare(
						`UPDATE gadgets SET category=$category, title=$title, description=$description,
						 content=$content, tags_json=$tags, source=$source, updated_at=$now WHERE id=$id`,
					)
					.run({
						$id: input.id,
						$category: input.category,
						$title: input.title,
						$description: input.description,
						$content: input.content,
						$tags: tagsJson,
						$source: input.source,
						$now: now,
					});
			}
			const version = this.#writeRevision(input.id, {
				title: input.title,
				description: input.description,
				content: input.content,
				tagsJson,
				now,
			});
			const hydrated = this.getById(input.id);
			if (hydrated === null) throw new GadgetNotFoundError(input.id);
			return { gadget: hydrated, version, created: existing === null };
		})();
	}

	add(input: GadgetInput): PutResult {
		validateGadgetId(input.id);
		const existing = this.getById(input.id);
		if (existing !== null) throw new GadgetAlreadyExistsError(input.id);
		return this.put(input);
	}

	delete(id: string): void {
		const existing = this.getById(id);
		if (existing === null) throw new GadgetNotFoundError(id);
		this.#db.prepare("DELETE FROM gadgets WHERE id = $id").run({ $id: id });
	}

	rename(id: string, newId: string): RenameResult {
		validateGadgetId(newId);
		return this.#db.transaction(() => {
			const current = this.getById(id);
			if (current === null) throw new GadgetNotFoundError(id);
			if (newId === id) return { gadget: current, previousName: id };
			const liveCollision = this.getById(newId);
			if (liveCollision !== null) {
				throw new AliasConflictError(newId, liveCollision.id);
			}
			const aliasCollision = this.#db
				.query("SELECT * FROM aliases WHERE alias = $alias")
				.get({ $alias: newId }) as AliasRow | null;
			if (aliasCollision !== null && aliasCollision.gadget_id !== id) {
				throw new AliasConflictError(newId, aliasCollision.gadget_id);
			}
			const existingAliases = this.aliasesOf(id);
			if (existingAliases.length >= MAX_ALIASES_PER_GADGET) {
				throw new TooManyAliasesError(id, MAX_ALIASES_PER_GADGET);
			}
			this.#db.prepare("DELETE FROM aliases WHERE alias = $alias").run({ $alias: newId });
			const now = this.#clock.now();
			const tagsJson = JSON.stringify(current.tags);
			this.#db
				.prepare("UPDATE gadgets SET id=$newId, updated_at=$now WHERE id=$id")
				.run({ $newId: newId, $now: now, $id: id });
			this.#db
				.prepare("UPDATE gadget_revisions SET gadget_id=$newId WHERE gadget_id=$id")
				.run({ $newId: newId, $id: id });
			this.#db
				.prepare("UPDATE aliases SET gadget_id=$newId WHERE gadget_id=$id")
				.run({ $newId: newId, $id: id });
			this.#db
				.prepare(
					"INSERT OR IGNORE INTO aliases (alias, gadget_id, created_at) VALUES ($alias, $gid, $now)",
				)
				.run({ $alias: id, $gid: newId, $now: now });
			this.#writeRevision(newId, {
				title: current.title,
				description: current.description,
				content: current.content,
				tagsJson,
				now,
			});
			const next = this.getById(newId);
			if (next === null) throw new GadgetNotFoundError(newId);
			return { gadget: next, previousName: id };
		})();
	}

	listRevisions(id: string): Revision[] {
		const rows = this.#db
			.query("SELECT * FROM gadget_revisions WHERE gadget_id=$id ORDER BY version DESC")
			.all({ $id: id }) as RevisionRow[];
		return rows.map(hydrateRevision);
	}

	getRevision(id: string, version: number): Revision | null {
		const row = this.#db
			.query("SELECT * FROM gadget_revisions WHERE gadget_id=$id AND version=$v")
			.get({ $id: id, $v: version }) as RevisionRow | null;
		return row === null ? null : hydrateRevision(row);
	}

	rollback(id: string, toVersion: number): RollbackResult {
		return this.#db.transaction(() => {
			const current = this.getById(id);
			if (current === null) throw new GadgetNotFoundError(id);
			const target = this.getRevision(id, toVersion);
			if (target === null) throw new RevisionMissingError(id, toVersion);
			const now = this.#clock.now();
			const tagsJson = JSON.stringify(target.tags);
			this.#db
				.prepare(
					`UPDATE gadgets SET title=$title, description=$description, content=$content,
					 tags_json=$tags, updated_at=$now WHERE id=$id`,
				)
				.run({
					$id: id,
					$title: target.title,
					$description: target.description,
					$content: target.content,
					$tags: tagsJson,
					$now: now,
				});
			const newVersion = this.#writeRevision(id, {
				title: target.title,
				description: target.description,
				content: target.content,
				tagsJson,
				now,
			});
			const next = this.getById(id);
			if (next === null) throw new GadgetNotFoundError(id);
			return { gadget: next, newVersion };
		})();
	}

	compose(ids: readonly string[], separator = "\n\n"): { prompt: string; chain: Gadget[] } {
		const missing: string[] = [];
		const chain: Gadget[] = [];
		for (const id of ids) {
			const g = this.resolve(id);
			if (g === null) missing.push(id);
			else chain.push(g);
		}
		if (missing.length > 0) throw new ComposeMissingIdsError(missing);
		return { prompt: chain.map((g) => g.content).join(separator), chain };
	}

	canonicalChain(): Gadget[] {
		const out: Gadget[] = [];
		for (const cat of COMPOSE_ORDER) {
			const row = this.#db
				.query("SELECT * FROM gadgets WHERE category = $cat ORDER BY updated_at DESC LIMIT 1")
				.get({ $cat: cat }) as GadgetRow | null;
			if (row !== null) out.push(hydrate(row));
		}
		return out;
	}

	count(): number {
		const row = this.#db.query("SELECT COUNT(*) AS n FROM gadgets").get() as { n: number };
		return row.n;
	}

	#writeRevision(
		gadgetId: string,
		snapshot: {
			title: string;
			description: string;
			content: string;
			tagsJson: string;
			now: number;
		},
	): number {
		const row = this.#db
			.query("SELECT COALESCE(MAX(version), 0) AS v FROM gadget_revisions WHERE gadget_id=$id")
			.get({ $id: gadgetId }) as { v: number } | null;
		const version = (row?.v ?? 0) + 1;
		this.#db
			.prepare(
				`INSERT INTO gadget_revisions (id, gadget_id, version, title, description, content, tags_json, created_at)
				 VALUES ($id, $gid, $v, $title, $description, $content, $tags, $now)`,
			)
			.run({
				$id: newRevisionId(snapshot.now),
				$gid: gadgetId,
				$v: version,
				$title: snapshot.title,
				$description: snapshot.description,
				$content: snapshot.content,
				$tags: snapshot.tagsJson,
				$now: snapshot.now,
			});
		return version;
	}
}
