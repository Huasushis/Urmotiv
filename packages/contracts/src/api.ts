import { z } from "zod";

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string().optional(),
    fieldErrors: z.record(z.string(), z.array(z.string())).optional()
  })
});

export type ApiError = z.infer<typeof apiErrorSchema>;

export const successResponseSchema = z.object({
  ok: z.literal(true)
});
