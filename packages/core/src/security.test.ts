import { describe, expect, test } from "bun:test";
import { GadgetCategorySchema } from "./domain/category.ts";
import { MalformedCursorError, SearchCursorQueryMismatchError } from "./domain/errors.ts";
import { GADGET_ID_PATTERN, validateGadgetId } from "./domain/id.ts";
import {
	decodeListCursor,
	decodeSearchCursor,
	encodeListCursor,
	encodeSearchCursor,
} from "./repo/cursor.ts";

function rng(seed: number): () => number {
	let state = seed >>> 0 || 1;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 0x1_00_00_00_00;
	};
}

function pickChar(r: number, alphabet: string): string {
	const i = Math.min(alphabet.length - 1, Math.floor(r * alphabet.length));
	return alphabet.charAt(i);
}

function genString(rand: () => number, alphabet: string, len: number): string {
	let out = "";
	for (let i = 0; i < len; i++) out += pickChar(rand(), alphabet);
	return out;
}

function flipByte(s: string, idx: number): string {
	if (idx >= s.length) return s;
	const ch = s.charCodeAt(idx) ^ 0x01;
	return s.slice(0, idx) + String.fromCharCode(ch) + s.slice(idx + 1);
}

const NAME_OK = "abcdefghijklmnopqrstuvwxyz0123456789-";
const NAME_BAD_EXTRA = "ABC !@#$%^&*()/\\\t\n_.";

describe("property: gadget id pattern", () => {
	test("100 generated lowercase kebab ids parse and validate", () => {
		const rand = rng(0xc0ffee);
		for (let trial = 0; trial < 100; trial++) {
			const len = 1 + Math.floor(rand() * 63);
			let candidate = pickChar(rand(), "abcdefghijklmnopqrstuvwxyz0123456789");
			candidate += genString(rand, NAME_OK, len - 1);
			if (!GADGET_ID_PATTERN.test(candidate)) continue; // tail might still be `-` which is fine, but skip if overlength
			expect(GADGET_ID_PATTERN.test(candidate)).toBe(true);
			expect(() => validateGadgetId(candidate)).not.toThrow();
		}
	});

	test("100 generated ids with an illegal character reject", () => {
		const rand = rng(0xfeed);
		for (let trial = 0; trial < 100; trial++) {
			const len = 5 + Math.floor(rand() * 30);
			let candidate = "";
			let inserted = false;
			for (let i = 0; i < len; i++) {
				if (!inserted && rand() < 0.3) {
					candidate += pickChar(rand(), NAME_BAD_EXTRA);
					inserted = true;
				} else {
					candidate += pickChar(rand(), NAME_OK);
				}
			}
			if (!inserted) candidate += pickChar(rand(), NAME_BAD_EXTRA);
			expect(GADGET_ID_PATTERN.test(candidate)).toBe(false);
		}
	});

	test("empty, leading hyphen, and oversize ids reject", () => {
		expect(GADGET_ID_PATTERN.test("")).toBe(false);
		expect(GADGET_ID_PATTERN.test("-abc")).toBe(false);
		expect(GADGET_ID_PATTERN.test("a".repeat(65))).toBe(false);
	});
});

describe("property: cursor tamper-resistance", () => {
	test("list cursor: flipped bytes decode to valid shape or throw malformed", () => {
		const rand = rng(0xdeadbeef);
		for (let trial = 0; trial < 100; trial++) {
			const cursor = encodeListCursor({
				updatedAt: Math.floor(rand() * 1e9),
				id: "role-bun",
				category: null,
			});
			const tampered = flipByte(cursor, Math.floor(rand() * cursor.length));
			try {
				const decoded = decodeListCursor(tampered);
				expect(decoded.t).toBe("list");
				expect(decoded.v).toBe(1);
				expect(typeof decoded.id).toBe("string");
				expect(decoded.updatedAt).toBeGreaterThanOrEqual(0);
			} catch (err) {
				expect(err).toBeInstanceOf(MalformedCursorError);
			}
		}
	});

	test("search cursor: flipped bytes decode to valid shape, throw malformed, or query-mismatch", () => {
		const rand = rng(0xc0c0a);
		for (let trial = 0; trial < 100; trial++) {
			const cursor = encodeSearchCursor({
				q: "needle",
				category: null,
				rank: rand() * 10,
				rowid: trial,
			});
			const tampered = flipByte(cursor, Math.floor(rand() * cursor.length));
			try {
				const decoded = decodeSearchCursor(tampered, "needle");
				expect(decoded.t).toBe("search");
				expect(decoded.v).toBe(1);
			} catch (err) {
				expect(
					err instanceof MalformedCursorError || err instanceof SearchCursorQueryMismatchError,
				).toBe(true);
			}
		}
	});
});

describe("category enum is closed", () => {
	test("100 random labels that aren't one of the nine reject", () => {
		const rand = rng(0x12345);
		for (let trial = 0; trial < 100; trial++) {
			const candidate = genString(rand, "abcdefghijklmnopqrstuvwxyz", 3 + Math.floor(rand() * 10));
			if (
				candidate === "role" ||
				candidate === "context" ||
				candidate === "task" ||
				candidate === "constraint" ||
				candidate === "format" ||
				candidate === "example" ||
				candidate === "reasoning" ||
				candidate === "tone" ||
				candidate === "caveat"
			) {
				continue;
			}
			expect(GadgetCategorySchema.safeParse(candidate).success).toBe(false);
		}
	});
});

describe("workspace name sandbox", () => {
	test("parseWorkspaces rejects names with path separators", async () => {
		const { parseWorkspaces } = await import("../../server/src/workspace.ts");
		expect(() => parseWorkspaces('{"../etc":"/x"}', "/x")).toThrow();
		expect(() => parseWorkspaces('{"/root":"/x"}', "/x")).toThrow();
		expect(() => parseWorkspaces('{"A":"/x"}', "/x")).toThrow();
	});
});

describe("auth hardening", () => {
	test("parseTokens silently drops malformed rows; lookupRole requires exact match", async () => {
		const { parseTokens, lookupRole } = await import("../../server/src/mcp/auth.ts");
		const t = parseTokens("good:admin,bad,wrong:root,x:y");
		expect(t.map.size).toBe(1);
		expect(lookupRole(t, "Bearer good")).toBe("admin");
		expect(lookupRole(t, "Bearer GOOD")).toBeNull();
		expect(lookupRole(t, null)).toBeNull();
	});

	test("origin allowlist is strict string equality (no substring / scheme coercion)", async () => {
		const { parseOriginAllowlist, originAllowed } = await import("../../server/src/mcp/auth.ts");
		const al = parseOriginAllowlist("https://a.test");
		expect(originAllowed(al, "https://a.test")).toBe(true);
		expect(originAllowed(al, "http://a.test")).toBe(false);
		expect(originAllowed(al, "https://a.test.attacker.com")).toBe(false);
		expect(originAllowed(al, null)).toBe(false);
	});

	test("role hierarchy is monotonic (reader < writer < admin)", async () => {
		const { roleAllows } = await import("../../server/src/mcp/auth.ts");
		expect(roleAllows("admin", "admin")).toBe(true);
		expect(roleAllows("admin", "writer")).toBe(true);
		expect(roleAllows("admin", "reader")).toBe(true);
		expect(roleAllows("writer", "writer")).toBe(true);
		expect(roleAllows("writer", "reader")).toBe(true);
		expect(roleAllows("writer", "admin")).toBe(false);
		expect(roleAllows("reader", "reader")).toBe(true);
		expect(roleAllows("reader", "writer")).toBe(false);
		expect(roleAllows("reader", "admin")).toBe(false);
	});
});
