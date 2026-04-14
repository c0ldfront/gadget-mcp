import {
	AliasConflictError,
	ComposeMissingIdsError,
	GadgetAlreadyExistsError,
	GadgetNotFoundError,
	InvalidGadgetIdError,
	MalformedCursorError,
	RevisionMissingError,
	SearchCursorQueryMismatchError,
	TooManyAliasesError,
} from "@gadget/core";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

export const GADGET_ERROR_CODES = {
	NotFound: "gadget.notFound",
	AlreadyExists: "gadget.alreadyExists",
	AliasConflict: "gadget.aliasConflict",
	TooManyAliases: "gadget.tooManyAliases",
	InvalidGadget: "gadget.invalidGadget",
	InvalidGadgetId: "gadget.invalidGadgetId",
	CategoryUnknown: "gadget.categoryUnknown",
	ComposeMissingIds: "gadget.composeMissingIds",
	RevisionMissing: "gadget.revisionMissing",
	MalformedCursor: "gadget.malformedCursor",
	SearchCursorQueryMismatch: "gadget.searchCursorQueryMismatch",
	Unauthorized: "gadget.unauthorized",
	Forbidden: "gadget.forbidden",
	WorkspaceUnknown: "gadget.workspaceUnknown",
	Cancelled: "gadget.cancelled",
	RunnerMissing: "gadget.runnerMissing",
	RunnerFailed: "gadget.runnerFailed",
} as const;

export type GadgetErrorCode = (typeof GADGET_ERROR_CODES)[keyof typeof GADGET_ERROR_CODES];

export interface GadgetMcpErrorOptions {
	readonly code: GadgetErrorCode;
	readonly message: string;
	readonly data?: Readonly<Record<string, unknown>>;
	readonly mcpCode?: ErrorCode;
}

export function gadgetMcpError(opts: GadgetMcpErrorOptions): McpError {
	const data: Record<string, unknown> = {
		...(opts.data ?? {}),
		gadgetCode: opts.code,
	};
	return new McpError(opts.mcpCode ?? ErrorCode.InvalidParams, opts.message, data);
}

export function toMcpError(err: unknown): McpError | null {
	if (err instanceof McpError) return err;
	if (err instanceof GadgetNotFoundError) {
		return gadgetMcpError({
			code: GADGET_ERROR_CODES.NotFound,
			message: err.message,
			data: { id: err.id },
		});
	}
	if (err instanceof GadgetAlreadyExistsError) {
		return gadgetMcpError({
			code: GADGET_ERROR_CODES.AlreadyExists,
			message: err.message,
			data: { id: err.id },
		});
	}
	if (err instanceof AliasConflictError) {
		return gadgetMcpError({
			code: GADGET_ERROR_CODES.AliasConflict,
			message: err.message,
			data: { alias: err.alias, holderId: err.holderId },
		});
	}
	if (err instanceof TooManyAliasesError) {
		return gadgetMcpError({
			code: GADGET_ERROR_CODES.TooManyAliases,
			message: err.message,
			data: { id: err.id, limit: err.limit },
		});
	}
	if (err instanceof InvalidGadgetIdError) {
		return gadgetMcpError({
			code: GADGET_ERROR_CODES.InvalidGadgetId,
			message: err.message,
			data: { id: err.id },
		});
	}
	if (err instanceof ComposeMissingIdsError) {
		return gadgetMcpError({
			code: GADGET_ERROR_CODES.ComposeMissingIds,
			message: err.message,
			data: { missing: err.missing },
		});
	}
	if (err instanceof RevisionMissingError) {
		return gadgetMcpError({
			code: GADGET_ERROR_CODES.RevisionMissing,
			message: err.message,
			data: { id: err.id, version: err.version },
		});
	}
	if (err instanceof MalformedCursorError) {
		return gadgetMcpError({
			code: GADGET_ERROR_CODES.MalformedCursor,
			message: err.message,
			data: { cursor: err.cursor },
		});
	}
	if (err instanceof SearchCursorQueryMismatchError) {
		return gadgetMcpError({
			code: GADGET_ERROR_CODES.SearchCursorQueryMismatch,
			message: err.message,
			data: { cursorQuery: err.cursorQuery, requestQuery: err.requestQuery },
		});
	}
	return null;
}

export function rethrowAsMcp(err: unknown): never {
	const mapped = toMcpError(err);
	if (mapped !== null) throw mapped;
	throw err;
}

export function resultCodeOf(err: unknown): string {
	const m = toMcpError(err);
	if (m === null) return "internalError";
	const code = (m.data as { gadgetCode?: unknown } | undefined)?.gadgetCode;
	return typeof code === "string" ? code : "internalError";
}
