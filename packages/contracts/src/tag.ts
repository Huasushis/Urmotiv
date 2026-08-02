import { z } from "zod";

export const tagItemKinds = ["category", "tag"] as const;
export const tagItemKindSchema = z.enum(tagItemKinds);

export const tagCategorySummarySchema = z
  .object({
    id: z.string().min(1).max(120),
    name: z.string().min(1).max(80),
  })
  .strict();

export const tagSchema = z
  .object({
    id: z.string().min(1).max(120),
    name: z.string().min(1).max(80),
    group: z.string().min(1).max(80),
    itemKind: z.literal("tag").default("tag"),
    active: z.boolean().default(true),
    category: tagCategorySummarySchema.optional(),
    description: z.string().max(2_000).optional(),
    aliases: z.array(z.string().min(1).max(160)).default([]),
  })
  .strict();

export const tagCatalogCategorySchema = z
  .object({
    id: z.string().min(1).max(120),
    name: z.string().min(1).max(80),
    description: z.string(),
    sortOrder: z.number().int(),
    active: z.boolean(),
  })
  .strict();

export const tagCatalogItemSchema = z.discriminatedUnion("itemKind", [
  tagCatalogCategorySchema
    .extend({
      itemKind: z.literal("category"),
      parentId: z.null(),
    })
    .strict(),
  tagSchema
    .extend({
      description: z.string().max(2_000),
      aliases: z.array(z.string().min(1).max(160)),
      normalizedName: z.string().min(1).max(160),
      parentId: z.string().min(1).max(120),
      sortOrder: z.number().int(),
    })
    .strict(),
]);

export const tagCatalogResponseSchema = z
  .object({
    version: z.number().int().positive(),
    items: z.array(tagCatalogItemSchema),
  })
  .strict();

export const tagCatalogAliasSchema = z
  .object({
    id: z.string().uuid(),
    tagId: z.string().min(1).max(120),
    name: z.string().min(1).max(160),
    normalizedName: z.string().min(1).max(160),
  })
  .strict();

export const managedTagCatalogResponseSchema = tagCatalogResponseSchema
  .extend({ aliases: z.array(tagCatalogAliasSchema) })
  .strict();

export const createTagCatalogItemInputSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    id: z
      .string()
      .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u)
      .max(120),
    itemKind: tagItemKindSchema,
    parentId: z.string().min(1).max(120).nullable(),
    name: z.string().trim().min(1).max(80),
    description: z.string().max(2_000).default(""),
    sortOrder: z.number().int().min(-2_147_483_648).max(2_147_483_647).default(0),
  })
  .strict();

export const updateTagCatalogItemInputSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().max(2_000).optional(),
    parentId: z.string().min(1).max(120).nullable().optional(),
    sortOrder: z.number().int().min(-2_147_483_648).max(2_147_483_647).optional(),
    active: z.boolean().optional(),
  })
  .strict();

export const createTagAliasInputSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    name: z.string().trim().min(1).max(160),
  })
  .strict();

export const updateTagAliasInputSchema = createTagAliasInputSchema;

export const deleteTagAliasInputSchema = z
  .object({ expectedVersion: z.number().int().positive() })
  .strict();

export const tagDeactivationPreviewInputSchema = z
  .object({
    replacementTagId: z.string().min(1).max(120).optional(),
  })
  .strict();

export const confirmTagDeactivationInputSchema = z
  .object({
    confirmationId: z.string().uuid(),
    catalogVersion: z.number().int().positive(),
  })
  .strict();

export const tagCatalogMutationResponseSchema = z
  .object({ version: z.number().int().positive() })
  .strict();

export const tagAliasMutationResponseSchema = tagCatalogMutationResponseSchema
  .extend({ aliasId: z.string().uuid() })
  .strict();

export const tagDeactivationImpactSchema = z
  .object({
    currentProblemCount: z.number().int().nonnegative(),
    soleCurrentTagCount: z.number().int().nonnegative(),
    historicalRevisionCount: z.number().int().nonnegative(),
    reviewOpinionCount: z.number().int().nonnegative(),
    childTagCount: z.number().int().nonnegative(),
  })
  .strict();

export const tagDeactivationPreviewSchema = z
  .object({
    confirmationId: z.string().uuid(),
    catalogVersion: z.number().int().positive(),
    expiresAt: z.string().datetime(),
    impact: tagDeactivationImpactSchema,
  })
  .strict();

export type ProblemTag = z.input<typeof tagSchema>;
export type TagCatalogItem = z.infer<typeof tagCatalogItemSchema>;
export type TagCatalogResponse = z.infer<typeof tagCatalogResponseSchema>;
export type TagCatalogAlias = z.infer<typeof tagCatalogAliasSchema>;
export type ManagedTagCatalogResponse = z.infer<typeof managedTagCatalogResponseSchema>;
export type TagDeactivationImpact = z.infer<typeof tagDeactivationImpactSchema>;
export type TagDeactivationPreview = z.infer<typeof tagDeactivationPreviewSchema>;
export type CreateTagCatalogItemInput = z.infer<typeof createTagCatalogItemInputSchema>;
export type UpdateTagCatalogItemInput = z.infer<typeof updateTagCatalogItemInputSchema>;
export type CreateTagAliasInput = z.infer<typeof createTagAliasInputSchema>;
export type UpdateTagAliasInput = z.infer<typeof updateTagAliasInputSchema>;
export type DeleteTagAliasInput = z.infer<typeof deleteTagAliasInputSchema>;
export type TagDeactivationPreviewInput = z.infer<typeof tagDeactivationPreviewInputSchema>;
export type ConfirmTagDeactivationInput = z.infer<typeof confirmTagDeactivationInputSchema>;
export type TagCatalogMutationResponse = z.infer<typeof tagCatalogMutationResponseSchema>;
export type TagAliasMutationResponse = z.infer<typeof tagAliasMutationResponseSchema>;

export function normalizeTagName(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}
