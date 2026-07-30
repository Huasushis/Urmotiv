import { z } from "zod";

/**
 * 审核条目是挂在审核轮次上的结构化参考信息（原题相似度、AI 分析等），
 * 供作者与审题人查看。它不是审核意见，也不参与通过人数统计。
 */

export const reviewItemSourceSchema = z.enum(["human", "anklang", "fermata", "plugin"]);

export const reviewItemVisibilitySchema = z.enum(["author", "reviewer", "administrator"]);

export const reviewItemViewSchema = z
  .object({
    id: z.string().min(1).max(200),
    type: z
      .string()
      .min(1)
      .max(160)
      .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/),
    source: reviewItemSourceSchema,
    visibility: reviewItemVisibilitySchema,
    summary: z.string().min(1).max(500),
    data: z.unknown(),
    createdAt: z.string().datetime({ offset: true })
  })
  .strict();

export type ReviewItemView = z.infer<typeof reviewItemViewSchema>;

export const reviewItemListResponseSchema = z
  .object({
    round: z.number().int().min(0),
    items: z.array(reviewItemViewSchema).max(1_000)
  })
  .strict();

export type ReviewItemListResponse = z.infer<typeof reviewItemListResponseSchema>;

/**
 * 手动原题检索的结果。blockedAdvice 只是给人看的“建议不要提交”，
 * 不会改变题目状态；真正的拦截发生在提交时的服务端检查里。
 */
export const similarityCheckResponseSchema = z
  .object({
    status: z.enum(["completed", "unavailable"]),
    blockedAdvice: z
      .object({
        code: z.string().min(1).max(160),
        message: z.string().min(1).max(2_000)
      })
      .strict()
      .nullable(),
    items: z.array(reviewItemViewSchema).max(100)
  })
  .strict();

export type SimilarityCheckResponse = z.infer<typeof similarityCheckResponseSchema>;
