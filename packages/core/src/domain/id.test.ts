import { expect, test } from "bun:test";
import { GADGET_ID_PATTERN, InvalidGadgetIdError, newRevisionId, validateGadgetId } from "./id.ts";

test("GADGET_ID_PATTERN accepts kebab-case ids", () => {
	expect(GADGET_ID_PATTERN.test("role-bun-runtime-engineer")).toBe(true);
	expect(GADGET_ID_PATTERN.test("context-snippy-mcp-repo")).toBe(true);
	expect(GADGET_ID_PATTERN.test("x")).toBe(true);
});

test("GADGET_ID_PATTERN rejects uppercase, whitespace, and leading hyphen", () => {
	expect(GADGET_ID_PATTERN.test("Role-foo")).toBe(false);
	expect(GADGET_ID_PATTERN.test("has spaces")).toBe(false);
	expect(GADGET_ID_PATTERN.test("-leading")).toBe(false);
	expect(GADGET_ID_PATTERN.test("")).toBe(false);
});

test("validateGadgetId throws InvalidGadgetIdError with the id captured", () => {
	try {
		validateGadgetId("BAD");
		throw new Error("expected throw");
	} catch (err) {
		expect(err).toBeInstanceOf(InvalidGadgetIdError);
		if (err instanceof InvalidGadgetIdError) expect(err.id).toBe("BAD");
	}
});

test("newRevisionId is monotonic with respect to timestamp prefix", () => {
	const a = newRevisionId(1_700_000_000_000);
	const b = newRevisionId(1_700_000_000_001);
	expect(a < b).toBe(true);
});
