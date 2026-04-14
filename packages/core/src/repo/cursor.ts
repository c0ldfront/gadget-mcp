import { z } from "zod";
import { MalformedCursorError, SearchCursorQueryMismatchError } from "../domain/errors.ts";

const ListCursorSchema = z.object({
	t: z.literal("list"),
	v: z.literal(1),
	updatedAt: z.number().int().nonnegative(),
	id: z.string().min(1),
	category: z.string().nullable(),
});
export type ListCursor = z.infer<typeof ListCursorSchema>;

const SearchCursorSchema = z.object({
	t: z.literal("search"),
	v: z.literal(1),
	q: z.string(),
	category: z.string().nullable(),
	rank: z.number(),
	rowid: z.number().int().nonnegative(),
});
export type SearchCursor = z.infer<typeof SearchCursorSchema>;

function toBase64Url(bytes: Uint8Array): string {
	let bin = "";
	for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i] ?? 0);
	return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(cursor: string): Uint8Array {
	const pad = "=".repeat((4 - (cursor.length % 4)) % 4);
	const b64 = cursor.replaceAll("-", "+").replaceAll("_", "/") + pad;
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encodeJson<T>(value: T): string {
	return toBase64Url(encoder.encode(JSON.stringify(value)));
}

function decodeJson(cursor: string): unknown {
	try {
		return JSON.parse(decoder.decode(fromBase64Url(cursor)));
	} catch {
		throw new MalformedCursorError(cursor);
	}
}

export function encodeListCursor(input: Omit<ListCursor, "t" | "v">): string {
	return encodeJson<ListCursor>({ t: "list", v: 1, ...input });
}

export function decodeListCursor(cursor: string): ListCursor {
	const parsed = ListCursorSchema.safeParse(decodeJson(cursor));
	if (!parsed.success) throw new MalformedCursorError(cursor);
	return parsed.data;
}

export function encodeSearchCursor(input: Omit<SearchCursor, "t" | "v">): string {
	return encodeJson<SearchCursor>({ t: "search", v: 1, ...input });
}

export function decodeSearchCursor(cursor: string, query: string): SearchCursor {
	const parsed = SearchCursorSchema.safeParse(decodeJson(cursor));
	if (!parsed.success) throw new MalformedCursorError(cursor);
	if (parsed.data.q !== query) {
		throw new SearchCursorQueryMismatchError(parsed.data.q, query);
	}
	return parsed.data;
}
