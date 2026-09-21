import { z } from "zod";
import { problemContentSchema, sampleSchema } from "./problem";
export const aiDraftInputSchema = z
  .object({ text: z.string().min(1).max(200_000) })
  .strict();
export const aiDraftResultSchema = z
  .object({
    title: z.string().max(200),
    content: problemContentSchema,
    samples: z.array(sampleSchema).max(50),
    standardSolution: z.string().max(200_000),
    unclassified: z.string().max(200_000),
  })
  .strict();
export const aiDraftJobSchema = z
  .object({
    id: z.string().uuid(),
    status: z.enum(["running", "complete", "failed"]),
    result: aiDraftResultSchema.optional(),
    error: z.string().max(300).optional(),
  })
  .strict();
export const aiDraftAvailabilitySchema = z
  .object({ available: z.boolean() })
  .strict();
export type AiDraftResult = z.infer<typeof aiDraftResultSchema>;
