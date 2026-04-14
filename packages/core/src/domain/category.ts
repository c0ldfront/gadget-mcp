import { z } from "zod";

export const GADGET_CATEGORIES = [
	"role",
	"context",
	"task",
	"constraint",
	"format",
	"example",
	"reasoning",
	"tone",
	"caveat",
] as const;

export type GadgetCategory = (typeof GADGET_CATEGORIES)[number];

export const GadgetCategorySchema = z.enum(GADGET_CATEGORIES);

export const GADGET_SOURCES = ["curated", "generated"] as const;
export type GadgetSource = (typeof GADGET_SOURCES)[number];
export const GadgetSourceSchema = z.enum(GADGET_SOURCES);

export const COMPOSE_ORDER: readonly GadgetCategory[] = [
	"role",
	"context",
	"task",
	"constraint",
	"format",
	"example",
	"reasoning",
	"tone",
	"caveat",
];

export function isGadgetCategory(value: unknown): value is GadgetCategory {
	return typeof value === "string" && (GADGET_CATEGORIES as readonly string[]).includes(value);
}
