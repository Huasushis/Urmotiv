import { z } from "zod";

/**
 * One non-empty line is four tab-separated columns:
 * username (optional), nickname, email, password.
 */
export const batchAccountCreateInputSchema = z
  .object({
    text: z.string().max(64_000, "批量账号内容不能超过 64 KB。")
  })
  .strict();

/** The response intentionally contains counts only; it never returns account data or credentials. */
export const batchAccountCreateResponseSchema = z
  .object({
    ok: z.literal(true),
    createdCount: z.number().int().nonnegative(),
    totalCount: z.number().int().positive()
  })
  .strict();

export type BatchAccountCreateInput = z.infer<typeof batchAccountCreateInputSchema>;
export type BatchAccountCreateResponse = z.infer<typeof batchAccountCreateResponseSchema>;
