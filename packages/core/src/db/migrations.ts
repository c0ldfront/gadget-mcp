import type { Db } from "./connection.ts";

const MIGRATIONS: readonly string[] = [
	`
	CREATE TABLE IF NOT EXISTS gadgets (
		id TEXT PRIMARY KEY,
		category TEXT NOT NULL CHECK (category IN (
			'role','context','task','constraint','format','example','reasoning','tone','caveat'
		)),
		title TEXT NOT NULL,
		description TEXT NOT NULL,
		content TEXT NOT NULL,
		tags_json TEXT NOT NULL DEFAULT '[]',
		source TEXT NOT NULL DEFAULT 'generated' CHECK (source IN ('curated','generated')),
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_gadgets_category ON gadgets(category, updated_at DESC, id);
	CREATE INDEX IF NOT EXISTS idx_gadgets_updated_at ON gadgets(updated_at DESC, id);
	`,
	`
	CREATE TABLE IF NOT EXISTS gadget_revisions (
		id TEXT PRIMARY KEY,
		gadget_id TEXT NOT NULL,
		version INTEGER NOT NULL,
		title TEXT NOT NULL,
		description TEXT NOT NULL,
		content TEXT NOT NULL,
		tags_json TEXT NOT NULL DEFAULT '[]',
		created_at INTEGER NOT NULL,
		UNIQUE (gadget_id, version),
		FOREIGN KEY (gadget_id) REFERENCES gadgets(id) ON DELETE CASCADE ON UPDATE CASCADE
	);
	CREATE INDEX IF NOT EXISTS idx_revisions_gadget ON gadget_revisions(gadget_id, version DESC);
	`,
	`
	CREATE TABLE IF NOT EXISTS aliases (
		alias TEXT PRIMARY KEY CHECK (length(alias) BETWEEN 1 AND 64),
		gadget_id TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		FOREIGN KEY (gadget_id) REFERENCES gadgets(id) ON DELETE CASCADE ON UPDATE CASCADE
	);
	CREATE INDEX IF NOT EXISTS idx_aliases_gadget ON aliases(gadget_id);
	`,
	`
	CREATE TABLE IF NOT EXISTS audit_log (
		id TEXT PRIMARY KEY,
		ts INTEGER NOT NULL,
		actor TEXT NOT NULL,
		tool TEXT NOT NULL,
		args_json TEXT NOT NULL DEFAULT '{}',
		result_code TEXT NOT NULL,
		gadget_id TEXT,
		correlation_id TEXT
	);
	CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts DESC);
	CREATE INDEX IF NOT EXISTS idx_audit_tool ON audit_log(tool, ts DESC);
	CREATE INDEX IF NOT EXISTS idx_audit_gadget ON audit_log(gadget_id);
	`,
	`
	CREATE TABLE IF NOT EXISTS reviewer_runners (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		command_json TEXT NOT NULL,
		enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
		timeout_seconds INTEGER,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	);
	`,
	`
	CREATE VIRTUAL TABLE IF NOT EXISTS gadgets_fts USING fts5(
		id UNINDEXED,
		title,
		description,
		content,
		tags,
		tokenize='porter unicode61'
	);
	CREATE TRIGGER IF NOT EXISTS gadgets_ai AFTER INSERT ON gadgets BEGIN
		INSERT INTO gadgets_fts(rowid, id, title, description, content, tags)
		VALUES (new.rowid, new.id, new.title, new.description, new.content,
			replace(replace(replace(new.tags_json, '[', ''), ']', ''), '"', ''));
	END;
	CREATE TRIGGER IF NOT EXISTS gadgets_ad AFTER DELETE ON gadgets BEGIN
		DELETE FROM gadgets_fts WHERE rowid = old.rowid;
	END;
	CREATE TRIGGER IF NOT EXISTS gadgets_au AFTER UPDATE ON gadgets BEGIN
		DELETE FROM gadgets_fts WHERE rowid = old.rowid;
		INSERT INTO gadgets_fts(rowid, id, title, description, content, tags)
		VALUES (new.rowid, new.id, new.title, new.description, new.content,
			replace(replace(replace(new.tags_json, '[', ''), ']', ''), '"', ''));
	END;
	`,
];

export function runMigrations(db: Db): void {
	db.run("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY);");
	const row = db.query("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as {
		v: number;
	};
	const applied = row.v;
	for (let i = applied; i < MIGRATIONS.length; i++) {
		const sql = MIGRATIONS[i];
		if (sql === undefined) continue;
		db.transaction(() => {
			db.run(sql);
			db.prepare("INSERT INTO schema_migrations (version) VALUES ($v)").run({ $v: i + 1 });
		})();
	}
}

export function currentSchemaVersion(db: Db): number {
	const row = db.query("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as {
		v: number;
	};
	return row.v;
}

export function targetSchemaVersion(): number {
	return MIGRATIONS.length;
}
