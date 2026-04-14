import { expect, test } from "bun:test";
import {
	AliasConflictError,
	ComposeMissingIdsError,
	GadgetNotFoundError,
	RevisionMissingError,
} from "@gadget/core";
import { GADGET_ERROR_CODES, gadgetMcpError, resultCodeOf, toMcpError } from "./errors.ts";

test("gadgetMcpError attaches gadgetCode to data", () => {
	const e = gadgetMcpError({
		code: GADGET_ERROR_CODES.NotFound,
		message: "gone",
		data: { id: "x" },
	});
	expect((e.data as { gadgetCode: string }).gadgetCode).toBe("gadget.notFound");
	expect((e.data as { id: string }).id).toBe("x");
});

test("toMcpError maps domain errors to gadget codes", () => {
	expect(toMcpError(new GadgetNotFoundError("a"))?.data).toMatchObject({
		gadgetCode: "gadget.notFound",
	});
	expect(toMcpError(new AliasConflictError("old", "new"))?.data).toMatchObject({
		gadgetCode: "gadget.aliasConflict",
	});
	expect(toMcpError(new ComposeMissingIdsError(["a"]))?.data).toMatchObject({
		gadgetCode: "gadget.composeMissingIds",
		missing: ["a"],
	});
	expect(toMcpError(new RevisionMissingError("a", 2))?.data).toMatchObject({
		gadgetCode: "gadget.revisionMissing",
	});
});

test("toMcpError returns null for unknown errors", () => {
	expect(toMcpError(new Error("weird"))).toBeNull();
});

test("resultCodeOf extracts code or falls back", () => {
	expect(resultCodeOf(new GadgetNotFoundError("a"))).toBe("gadget.notFound");
	expect(resultCodeOf(new Error("x"))).toBe("internalError");
});
