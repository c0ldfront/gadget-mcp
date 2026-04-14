import { expect, test } from "bun:test";
import {
	GADGET_CONTENT_MAX,
	GADGET_DESCRIPTION_MAX,
	GADGET_TITLE_MAX,
	GadgetInputSchema,
	GadgetSchema,
	toSummary,
} from "./gadget.ts";

const base = {
	id: "role-bun",
	category: "role" as const,
	title: "Bun Runtime Engineer",
	description: "Bun-native TypeScript engineer persona.",
	content: "You are a Bun-runtime engineer.",
	tags: ["bun", "typescript"],
	source: "curated" as const,
	createdAt: 1,
	updatedAt: 1,
};

test("GadgetSchema accepts a well-formed gadget", () => {
	const res = GadgetSchema.safeParse(base);
	expect(res.success).toBe(true);
});

test("GadgetSchema rejects uppercase id", () => {
	const res = GadgetSchema.safeParse({ ...base, id: "Role-Bun" });
	expect(res.success).toBe(false);
});

test("GadgetInputSchema defaults tags to []", () => {
	const { id, category, title, description, content } = base;
	const res = GadgetInputSchema.parse({ id, category, title, description, content });
	expect(res.tags).toEqual([]);
	expect(res.source).toBe("generated");
});

test("toSummary returns the full gadget including content", () => {
	const g = GadgetSchema.parse(base);
	const s = toSummary(g);
	expect(s.content).toBe(base.content);
	expect(s.id).toBe(base.id);
});

test("GadgetInputSchema rejects content over the hard cap", () => {
	const { id, category, title, description } = base;
	const res = GadgetInputSchema.safeParse({
		id,
		category,
		title,
		description,
		content: "x".repeat(GADGET_CONTENT_MAX + 1),
	});
	expect(res.success).toBe(false);
});

test("GadgetInputSchema rejects title over the hard cap", () => {
	const { id, category, description, content } = base;
	const res = GadgetInputSchema.safeParse({
		id,
		category,
		title: "x".repeat(GADGET_TITLE_MAX + 1),
		description,
		content,
	});
	expect(res.success).toBe(false);
});

test("GadgetInputSchema rejects description over the hard cap", () => {
	const { id, category, title, content } = base;
	const res = GadgetInputSchema.safeParse({
		id,
		category,
		title,
		description: "x".repeat(GADGET_DESCRIPTION_MAX + 1),
		content,
	});
	expect(res.success).toBe(false);
});
