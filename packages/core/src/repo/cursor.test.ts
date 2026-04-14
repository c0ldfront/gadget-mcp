import { expect, test } from "bun:test";
import { MalformedCursorError, SearchCursorQueryMismatchError } from "../domain/errors.ts";
import {
	decodeListCursor,
	decodeSearchCursor,
	encodeListCursor,
	encodeSearchCursor,
} from "./cursor.ts";

test("encode/decode list cursor round-trip", () => {
	const c = encodeListCursor({ updatedAt: 1700, id: "role-bun", category: null });
	const parsed = decodeListCursor(c);
	expect(parsed.id).toBe("role-bun");
	expect(parsed.updatedAt).toBe(1700);
	expect(parsed.category).toBeNull();
});

test("encode/decode search cursor round-trip", () => {
	const c = encodeSearchCursor({ q: "bun", category: "role", rank: -0.1, rowid: 7 });
	const parsed = decodeSearchCursor(c, "bun");
	expect(parsed.rowid).toBe(7);
});

test("search cursor throws mismatch when query changes", () => {
	const c = encodeSearchCursor({ q: "bun", category: null, rank: 0, rowid: 1 });
	expect(() => decodeSearchCursor(c, "other")).toThrow(SearchCursorQueryMismatchError);
});

test("malformed cursor throws MalformedCursorError", () => {
	expect(() => decodeListCursor("not-base64!!!")).toThrow(MalformedCursorError);
	expect(() => decodeSearchCursor("zzz", "q")).toThrow(MalformedCursorError);
});
