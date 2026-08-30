import { z } from "zod";
import { userSummarySchema } from "./problem";

export const sessionUserSchema = userSummarySchema.extend({
  permissions: z.array(z.string()),
  roles: z.array(z.string()),
  isRoot: z.boolean(),
  canManageReviewPolicy: z.boolean(),
  canManagePlugins: z.boolean(),
  canManageTags: z.boolean(),
  canManageSystem: z.boolean().optional(),
  canManagePermissions: z.boolean().optional(),
  canManageServiceAccounts: z.boolean().optional(),
  canReadAudit: z.boolean().optional(),
  canManageProblemCatalog: z.boolean().optional(),
  canManageProblemStatuses: z.boolean().optional(),
  canManageOAuth: z.boolean().optional()
});

export type SessionUser = z.infer<typeof sessionUserSchema>;

export const sessionIdentityUserSchema = z.object({
  id: z.string(),
  nickname: z.string()
}).strict();

export const sessionIdentitySchema = z.object({
  actor: sessionIdentityUserSchema,
  effective: sessionIdentityUserSchema,
  switched: z.boolean()
}).strict();

export type SessionIdentity = z.infer<typeof sessionIdentitySchema>;

export const sessionResponseSchema = z.object({
  user: sessionUserSchema.nullable(),
  identity: sessionIdentitySchema.optional(),
  auth: z.object({
    emailEnabled: z.boolean(),
    emailRegistrationEnabled: z.boolean(),
    ustcOAuthEnabled: z.boolean(),
    casEnabled: z.boolean(),
    demoEnabled: z.boolean()
  })
});

export type SessionResponse = z.infer<typeof sessionResponseSchema>;

export const rootLoginInputSchema = z.object({
  identifier: z.enum(["root", "0"]),
  password: z.string().min(8).max(1_024)
}).strict();
export const usernameLoginInputSchema = z.object({
  username: z.string().trim().min(1).max(255).refine(
    (value) => !/\s/u.test(value),
    "用户名不能包含空白字符。"
  ),
  password: z.string().min(1).max(1_024)
}).strict();
export const loginInputSchema = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(1).max(1_024)
});

export const switchAccountInputSchema = z.object({
  targetUserId: z.string().trim().min(1).max(80)
}).strict();

export const demoLoginInputSchema = z.object({
  userId: z.string().min(1)
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
