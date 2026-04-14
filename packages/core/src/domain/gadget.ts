import { z } from "zod";
import { GadgetCategorySchema, GadgetSourceSchema } from "./category.ts";
import { GADGET_ID_PATTERN } from "./id.ts";

export const GadgetIdSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(GADGET_ID_PATTERN, { message: "gadget id must match ^[a-z0-9][a-z0-9-]{0,63}$" });

export const GadgetTagSchema = z
	.string()
	.min(1)
	.max(40)
	.regex(/^[a-z0-9][a-z0-9-]*$/, { message: "tag must be lowercase kebab-case" });

export const GadgetSchema = z.object({
	id: GadgetIdSchema,
	category: GadgetCategorySchema,
	title: z.string().min(1).max(200),
	description: z.string().min(1).max(500),
	content: z.string().min(1),
	tags: z.array(GadgetTagSchema).default([]),
	source: GadgetSourceSchema.default("generated"),
	createdAt: z.number().int().nonnegative(),
	updatedAt: z.number().int().nonnegative(),
});
export type Gadget = z.infer<typeof GadgetSchema>;

export const GadgetInputSchema = z.object({
	id: GadgetIdSchema,
	category: GadgetCategorySchema,
	title: z.string().min(1).max(200),
	description: z.string().min(1).max(500),
	content: z.string().min(1),
	tags: z.array(GadgetTagSchema).default([]),
	source: GadgetSourceSchema.default("generated"),
});
export type GadgetInput = z.infer<typeof GadgetInputSchema>;

export const GadgetSummarySchema = GadgetSchema.omit({ content: true });
export type GadgetSummary = z.infer<typeof GadgetSummarySchema>;

export const RevisionSchema = z.object({
	id: z.string(),
	gadgetId: GadgetIdSchema,
	version: z.number().int().positive(),
	content: z.string(),
	title: z.string(),
	description: z.string(),
	tags: z.array(GadgetTagSchema),
	createdAt: z.number().int().nonnegative(),
});
export type Revision = z.infer<typeof RevisionSchema>;

export function toSummary(g: Gadget): GadgetSummary {
	const { content: _content, ...rest } = g;
	return rest;
}
