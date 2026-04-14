import type { GadgetCategory } from "./category.ts";

export class GadgetNotFoundError extends Error {
	override readonly name = "GadgetNotFoundError";
	constructor(readonly id: string) {
		super(`gadget not found: ${id}`);
	}
}

export class GadgetAlreadyExistsError extends Error {
	override readonly name = "GadgetAlreadyExistsError";
	constructor(readonly id: string) {
		super(`gadget already exists: ${id}`);
	}
}

export class AliasConflictError extends Error {
	override readonly name = "AliasConflictError";
	constructor(
		readonly alias: string,
		readonly holderId: string,
	) {
		super(`alias '${alias}' is already in use by gadget ${holderId}`);
	}
}

export class TooManyAliasesError extends Error {
	override readonly name = "TooManyAliasesError";
	constructor(
		readonly id: string,
		readonly limit: number,
	) {
		super(`gadget ${id} already has the maximum of ${limit} aliases`);
	}
}

export class RevisionMissingError extends Error {
	override readonly name = "RevisionMissingError";
	constructor(
		readonly id: string,
		readonly version: number,
	) {
		super(`gadget ${id} has no revision v${version}`);
	}
}

export class CategoryUnknownError extends Error {
	override readonly name = "CategoryUnknownError";
	constructor(readonly category: string) {
		super(`unknown gadget category: ${category}`);
	}
}

export class ComposeMissingIdsError extends Error {
	override readonly name = "ComposeMissingIdsError";
	constructor(readonly missing: readonly string[]) {
		super(`compose-prompt: missing gadget ids: ${missing.join(", ")}`);
	}
}

export class MalformedCursorError extends Error {
	override readonly name = "MalformedCursorError";
	constructor(readonly cursor: string) {
		super(`malformed cursor`);
	}
}

export class SearchCursorQueryMismatchError extends Error {
	override readonly name = "SearchCursorQueryMismatchError";
	constructor(
		readonly cursorQuery: string,
		readonly requestQuery: string,
	) {
		super(`search cursor query mismatch: cursor=${cursorQuery} request=${requestQuery}`);
	}
}

export class InvalidGadgetError extends Error {
	override readonly name = "InvalidGadgetError";
	constructor(
		readonly field: string,
		message: string,
	) {
		super(`invalid gadget: ${field}: ${message}`);
	}
}

export class CategoryMismatchError extends Error {
	override readonly name = "CategoryMismatchError";
	constructor(
		readonly id: string,
		readonly expected: GadgetCategory,
		readonly actual: GadgetCategory,
	) {
		super(`gadget ${id} has category ${actual}, expected ${expected}`);
	}
}
