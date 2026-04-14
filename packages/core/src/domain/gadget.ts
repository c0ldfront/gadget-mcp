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

export const GADGET_TITLE_MAX = 80;
export const GADGET_DESCRIPTION_MAX = 200;
export const GADGET_CONTENT_MAX = 500;

const GadgetTitleSchema = z.string().min(1).max(GADGET_TITLE_MAX);
const GadgetDescriptionSchema = z.string().min(1).max(GADGET_DESCRIPTION_MAX);
const GadgetContentSchema = z.string().min(1).max(GADGET_CONTENT_MAX);

export const GadgetSchema = z.object({
	id: GadgetIdSchema,
	category: GadgetCategorySchema,
	title: GadgetTitleSchema,
	description: GadgetDescriptionSchema,
	content: GadgetContentSchema,
	tags: z.array(GadgetTagSchema).default([]),
	source: GadgetSourceSchema.default("generated"),
	createdAt: z.number().int().nonnegative(),
	updatedAt: z.number().int().nonnegative(),
});
export type Gadget = z.infer<typeof GadgetSchema>;

export const GadgetInputSchema = z.object({
	id: GadgetIdSchema,
	category: GadgetCategorySchema,
	title: GadgetTitleSchema,
	description: GadgetDescriptionSchema,
	content: GadgetContentSchema,
	tags: z.array(GadgetTagSchema).default([]),
	source: GadgetSourceSchema.default("generated"),
});
export type GadgetInput = z.infer<typeof GadgetInputSchema>;

export const GadgetSummarySchema = GadgetSchema;
export type GadgetSummary = z.infer<typeof GadgetSummarySchema>;

export const GadgetListItemSchema = GadgetSchema.pick({
	id: true,
	category: true,
	title: true,
	description: true,
	tags: true,
	content: true,
});
export type GadgetListItem = z.infer<typeof GadgetListItemSchema>;

export function toListItem(g: Gadget): GadgetListItem {
	return {
		id: g.id,
		category: g.category,
		title: g.title,
		description: g.description,
		tags: g.tags,
		content: g.content,
	};
}

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
	return g;
}
