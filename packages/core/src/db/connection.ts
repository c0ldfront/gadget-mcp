import { Database } from "bun:sqlite";
import { runMigrations } from "./migrations.ts";

export type Db = Database;

export interface OpenDbOptions {
	readonly path: string;
	readonly readonly?: boolean;
}

export function openDb(options: OpenDbOptions): Db {
	const db = new Database(options.path, { readwrite: !options.readonly, create: true });
	db.run("PRAGMA journal_mode = WAL;");
	db.run("PRAGMA foreign_keys = ON;");
	db.run("PRAGMA synchronous = NORMAL;");
	db.run("PRAGMA temp_store = MEMORY;");
	if (!options.readonly) runMigrations(db);
	return db;
}

export function openMemoryDb(): Db {
	const db = new Database(":memory:");
	db.run("PRAGMA foreign_keys = ON;");
	runMigrations(db);
	return db;
}
