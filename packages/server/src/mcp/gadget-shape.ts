import { GADGET_ERROR_CODES, gadgetMcpError } from "./errors.ts";

export const MAX_HEADINGS = 2;
export const MAX_FENCED_BLOCKS = 1;

const HEADING_RE = /^[ \t]{0,3}#{1,6}[ \t]+\S/gm;
const FENCE_RE = /^[ \t]{0,3}(?:```|~~~)/gm;

export interface ShapeIssue {
	readonly reason: "too-many-headings" | "too-many-code-fences";
	readonly found: number;
	readonly limit: number;
}

function countMatches(text: string, pattern: RegExp): number {
	let n = 0;
	const re = new RegExp(pattern.source, pattern.flags);
	while (re.exec(text) !== null) n += 1;
	return n;
}

export function inspectGadgetShape(content: string): ShapeIssue | null {
	const headings = countMatches(content, HEADING_RE);
	if (headings > MAX_HEADINGS) {
		return { reason: "too-many-headings", found: headings, limit: MAX_HEADINGS };
	}
	const fences = countMatches(content, FENCE_RE);
	// Each fenced block uses two fence markers.
	const fencedBlocks = Math.floor(fences / 2);
	if (fencedBlocks > MAX_FENCED_BLOCKS) {
		return { reason: "too-many-code-fences", found: fencedBlocks, limit: MAX_FENCED_BLOCKS };
	}
	return null;
}

export function isShapeCheckDisabled(env: Record<string, string | undefined> = Bun.env): boolean {
	const v = env.GADGET_DISABLE_SHAPE_CHECK;
	if (v === undefined) return false;
	const s = v.toLowerCase();
	return s === "1" || s === "true" || s === "yes" || s === "on";
}

export function assertGadgetShape(
	content: string,
	env: Record<string, string | undefined> = Bun.env,
): void {
	if (isShapeCheckDisabled(env)) return;
	const issue = inspectGadgetShape(content);
	if (issue === null) return;
	const message =
		issue.reason === "too-many-headings"
			? `gadget content looks multi-purpose (found ${issue.found} markdown headings, max ${issue.limit}); split into one gadget per section`
			: `gadget content has ${issue.found} fenced code blocks (max ${issue.limit}); keep examples in single-snippet example/format gadgets`;
	throw gadgetMcpError({
		code: GADGET_ERROR_CODES.InvalidGadget,
		message,
		data: { reason: issue.reason, found: issue.found, limit: issue.limit },
	});
}
