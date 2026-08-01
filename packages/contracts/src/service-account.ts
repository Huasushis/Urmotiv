import { z } from "zod";
import { normalizeIpCidr } from "./ip-address";
import { corePermissions, robotHardDeniedPermissions } from "./permissions";

const robotHardDeniedPermissionSet = new Set<string>(robotHardDeniedPermissions);

export function normalizeServiceAccountSourceCidr(value: string): string | undefined {
  return normalizeIpCidr(value);
}

export const serviceAccountSourceCidrSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .transform((value, context) => {
    const normalized = normalizeServiceAccountSourceCidr(value);
    if (normalized === undefined) {
      context.addIssue({
        code: "custom",
        message: "请输入有效的 IPv4 或 IPv6 地址范围。"
      });
      return z.NEVER;
    }
    return normalized;
  });

export const serviceAccountTokenPermissionSchema = z.enum(corePermissions);

export const createServiceAccountTokenInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    permissions: z.array(serviceAccountTokenPermissionSchema).min(1).max(64),
    sourceCidrs: z.array(serviceAccountSourceCidrSchema).max(32).default([]),
    expiresAt: z.string().datetime({ offset: true }).nullable().default(null)
  })
  .strict()
  .superRefine((input, context) => {
    const seenPermissions = new Set<string>();
    for (const [index, permission] of input.permissions.entries()) {
      if (seenPermissions.has(permission)) {
        context.addIssue({
          code: "custom",
          path: ["permissions", index],
          message: "同一项令牌权限不能重复。"
        });
      }
      seenPermissions.add(permission);
      if (robotHardDeniedPermissionSet.has(permission)) {
        context.addIssue({
          code: "custom",
          path: ["permissions", index],
          message: "机器人固定禁止的权限不能写入令牌。"
        });
      }
    }

    if (!seenPermissions.has("auth.login")) {
      context.addIssue({
        code: "custom",
        path: ["permissions"],
        message: "机器人令牌必须包含登录系统权限。"
      });
    }

    const seenCidrs = new Set<string>();
    for (const [index, cidr] of input.sourceCidrs.entries()) {
      if (seenCidrs.has(cidr)) {
        context.addIssue({
          code: "custom",
          path: ["sourceCidrs", index],
          message: "同一来源地址范围不能重复。"
        });
      }
      seenCidrs.add(cidr);
    }
  });

export type CreateServiceAccountTokenInput = z.infer<
  typeof createServiceAccountTokenInputSchema
>;

export const serviceAccountTokenSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1).max(120),
    displayPrefix: z.string().regex(/^urv_[A-Za-z0-9_-]{8}$/),
    permissions: z.array(serviceAccountTokenPermissionSchema).max(64),
    sourceCidrs: z.array(serviceAccountSourceCidrSchema).max(32),
    expiresAt: z.string().datetime({ offset: true }).nullable(),
    lastUsedAt: z.string().datetime({ offset: true }).nullable(),
    revokedAt: z.string().datetime({ offset: true }).nullable(),
    createdAt: z.string().datetime({ offset: true })
  })
  .strict();

export type ServiceAccountToken = z.infer<typeof serviceAccountTokenSchema>;

export const serviceAccountTokenListSchema = z
  .object({ items: z.array(serviceAccountTokenSchema) })
  .strict();

export type ServiceAccountTokenList = z.infer<typeof serviceAccountTokenListSchema>;

export const createdServiceAccountTokenSchema = z
  .object({
    item: serviceAccountTokenSchema,
    token: z.string().regex(/^urv_[A-Za-z0-9_-]{43}$/)
  })
  .strict();

export type CreatedServiceAccountToken = z.infer<
  typeof createdServiceAccountTokenSchema
>;
