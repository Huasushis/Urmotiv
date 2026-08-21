import { z } from "zod";
import { userSummarySchema } from "./problem";

export const sessionUserSchema = userSummarySchema.extend({
  permissions: z.array(z.string()),
  roles: z.array(z.string()),
  isRoot: z.boolean(),
  canManageReviewPolicy: z.boolean(),
  canManagePlugins: z.boolean(),
  canManageTags: z.boolean()
});

export type SessionUser = z.infer<typeof sessionUserSchema>;

export const sessionResponseSchema = z.object({
  user: sessionUserSchema.nullable(),
  auth: z.object({
    emailEnabled: z.boolean(),
    emailRegistrationEnabled: z.boolean(),
    ustcOAuthEnabled: z.boolean(),
    casEnabled: z.boolean(),
    demoEnabled: z.boolean()
  })
});

export type SessionResponse = z.infer<typeof sessionResponseSchema>;

export const demoLoginInputSchema = z.object({
  userId: z.string().min(1)
});

export const loginInputSchema = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(8).max(1024)
});

export const emailRegistrationInputSchema = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(12).max(1024),
  nickname: z.string().trim().min(1).max(120)
});

export const emailVerificationInputSchema = z.object({
  token: z.string().regex(/^uve_[A-Za-z0-9_-]{32,128}$/)
});

export const resendEmailVerificationInputSchema = z.object({
  email: z.string().trim().email().max(320)
});

export const casStartQuerySchema = z.object({
  returnPath: z.string().max(2_000).optional()
});

export const casCallbackQuerySchema = z.object({
  state: z.string().min(1).max(4_096),
  ticket: z.string().trim().min(1).max(2_000)
});

export const ustcOAuthStartQuerySchema = z.object({
  returnPath: z.string().max(2_000).optional()
});

export const ustcOAuthCallbackQuerySchema = z.object({
  state: z.string().min(1).max(4_096),
  code: z.string().trim().min(1).max(200)
});

export const okResponseSchema = z.object({ ok: z.literal(true) });

export const emailVerificationPendingResponseSchema = z.object({
  ok: z.literal(true),
  verificationPending: z.literal(true)
});
