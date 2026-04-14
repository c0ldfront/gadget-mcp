import { expect, test } from "bun:test";
import { GadgetInputSchema, GadgetSchema, toSummary } from "./gadget.ts";

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

test("toSummary strips content", () => {
	const g = GadgetSchema.parse(base);
	const s = toSummary(g);
	expect("content" in s).toBe(false);
	expect(s.id).toBe(base.id);
});
