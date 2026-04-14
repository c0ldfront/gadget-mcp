import { expect, test } from "bun:test";
import {
	lookupRole,
	originAllowed,
	parseOriginAllowlist,
	parseTokens,
	roleAllows,
	TOOL_REQUIRED_ROLES,
} from "./auth.ts";

test("parseTokens parses CSV token:role pairs", () => {
	const t = parseTokens("abc:reader,def:admin");
	expect(t.enabled).toBe(true);
	expect(t.map.get("abc")).toBe("reader");
	expect(t.map.get("def")).toBe("admin");
});

test("parseTokens on empty returns disabled map", () => {
	expect(parseTokens(undefined).enabled).toBe(false);
	expect(parseTokens("").enabled).toBe(false);
});

test("parseTokens skips invalid rows", () => {
	const t = parseTokens("abc:writer,bad,wrong:notarole,ok:admin");
	expect(t.map.size).toBe(2);
	expect(t.map.get("ok")).toBe("admin");
});

test("lookupRole returns admin when tokens disabled", () => {
	expect(lookupRole({ map: new Map(), enabled: false }, null)).toBe("admin");
});

test("lookupRole matches Bearer case-insensitively", () => {
	const t = parseTokens("tok:writer");
	expect(lookupRole(t, "Bearer tok")).toBe("writer");
	expect(lookupRole(t, "bearer tok")).toBe("writer");
	expect(lookupRole(t, "Basic tok")).toBeNull();
	expect(lookupRole(t, "Bearer nope")).toBeNull();
	expect(lookupRole(t, null)).toBeNull();
});

test("roleAllows enforces hierarchy", () => {
	expect(roleAllows("admin", "reader")).toBe(true);
	expect(roleAllows("writer", "writer")).toBe(true);
	expect(roleAllows("reader", "writer")).toBe(false);
	expect(roleAllows("reader", "admin")).toBe(false);
});

test("parseOriginAllowlist + originAllowed", () => {
	const al = parseOriginAllowlist("http://a.test,https://b.test");
	expect(al.enabled).toBe(true);
	expect(originAllowed(al, "http://a.test")).toBe(true);
	expect(originAllowed(al, "http://nope")).toBe(false);
	expect(originAllowed(al, null)).toBe(false);
	const openAl = parseOriginAllowlist(undefined);
	expect(originAllowed(openAl, null)).toBe(true);
});

test("TOOL_REQUIRED_ROLES covers list + add + delete", () => {
	expect(TOOL_REQUIRED_ROLES["gadget.list-gadgets"]).toBe("reader");
	expect(TOOL_REQUIRED_ROLES["gadget.add-gadget"]).toBe("writer");
	expect(TOOL_REQUIRED_ROLES["gadget.delete-gadget"]).toBe("admin");
});
