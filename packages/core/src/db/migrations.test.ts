import { expect, test } from "bun:test";
import { openMemoryDb } from "./connection.ts";
import { currentSchemaVersion, targetSchemaVersion } from "./migrations.ts";

test("migrations bring db up to target version", () => {
	const db = openMemoryDb();
	expect(currentSchemaVersion(db)).toBe(targetSchemaVersion());
	db.close();
});

test("FTS5 triggers mirror gadget rows", () => {
	const db = openMemoryDb();
	db.prepare(
		`INSERT INTO gadgets (id,category,title,description,content,tags_json,source,created_at,updated_at)
		 VALUES ('g1','role','Hello World','desc','the quick brown fox','["tag1"]','curated',1,1)`,
	).run();
	const row = db
		.query("SELECT id, content FROM gadgets_fts WHERE gadgets_fts MATCH 'quick'")
		.get() as { id: string; content: string } | null;
	expect(row?.id).toBe("g1");
	db.prepare("UPDATE gadgets SET content='updated lorem ipsum' WHERE id='g1'").run();
	const row2 = db.query("SELECT id FROM gadgets_fts WHERE gadgets_fts MATCH 'lorem'").get() as {
		id: string;
	} | null;
	expect(row2?.id).toBe("g1");
	db.prepare("DELETE FROM gadgets WHERE id='g1'").run();
	const row3 = db
		.query("SELECT COUNT(*) AS n FROM gadgets_fts WHERE gadgets_fts MATCH 'updated'")
		.get() as { n: number };
	expect(row3.n).toBe(0);
	db.close();
});
