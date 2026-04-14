import { expect, test } from "bun:test";
import {
	AliasConflictError,
	ComposeMissingIdsError,
	GadgetNotFoundError,
	RevisionMissingError,
	SearchCursorQueryMismatchError,
} from "./errors.ts";

test("errors carry their structured context", () => {
	expect(new GadgetNotFoundError("x").id).toBe("x");
	expect(new AliasConflictError("old", "new").holderId).toBe("new");
	expect(new RevisionMissingError("x", 3).version).toBe(3);
	expect(new ComposeMissingIdsError(["a", "b"]).missing).toEqual(["a", "b"]);
	expect(new SearchCursorQueryMismatchError("old", "new").cursorQuery).toBe("old");
});

test("error names are stable for instanceof / name comparison", () => {
	expect(new GadgetNotFoundError("x").name).toBe("GadgetNotFoundError");
	expect(new AliasConflictError("a", "b").name).toBe("AliasConflictError");
});
