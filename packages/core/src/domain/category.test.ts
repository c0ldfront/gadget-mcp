import { expect, test } from "bun:test";
import {
	COMPOSE_ORDER,
	GADGET_CATEGORIES,
	GadgetCategorySchema,
	isGadgetCategory,
} from "./category.ts";

test("GADGET_CATEGORIES covers the nine standard prompt components", () => {
	expect(GADGET_CATEGORIES.length).toBe(9);
	for (const c of ["role", "context", "task", "constraint", "format", "example"] as const) {
		expect(GADGET_CATEGORIES).toContain(c);
	}
});

test("COMPOSE_ORDER matches GADGET_CATEGORIES for the canonical chain", () => {
	expect(COMPOSE_ORDER).toEqual(GADGET_CATEGORIES);
});

test("GadgetCategorySchema rejects unknown categories", () => {
	expect(GadgetCategorySchema.safeParse("role").success).toBe(true);
	expect(GadgetCategorySchema.safeParse("bogus").success).toBe(false);
});

test("isGadgetCategory guards non-string input", () => {
	expect(isGadgetCategory("tone")).toBe(true);
	expect(isGadgetCategory("nope")).toBe(false);
	expect(isGadgetCategory(null)).toBe(false);
	expect(isGadgetCategory(42)).toBe(false);
});
