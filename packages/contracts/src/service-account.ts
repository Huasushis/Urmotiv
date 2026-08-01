import { z } from "zod";
import { corePermissions, robotHardDeniedPermissions } from "./permissions";

const robotHardDeniedPermissionSet = new Set<string>(robotHardDeniedPermissions);

function parseIpv4Address(value: string): number[] | undefined {
  const parts = value.split(".");
  if (parts.length !== 4) return undefined;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return undefined;
    const numeric = Number(part);
    if (numeric > 255) return undefined;
    octets.push(numeric);
  }
  return octets;
}

function parseIpv6Address(rawValue: string): number[] | undefined {
  if (!rawValue.includes(":")) return undefined;
  let value = rawValue.toLowerCase();
  if (value.includes(".")) {
    const separator = value.lastIndexOf(":");
    if (separator < 0) return undefined;
    const octets = parseIpv4Address(value.slice(separator + 1));
    if (octets === undefined) return undefined;
    const high = (octets[0]! << 8) | octets[1]!;
    const low = (octets[2]! << 8) | octets[3]!;
    value = `${value.slice(0, separator)}:${high.toString(16)}:${low.toString(16)}`;
  }
  if (!/^[0-9a-f:]+$/.test(value) || value.includes(":::")) return undefined;
  const compressed = value.indexOf("::");
  if (compressed !== value.lastIndexOf("::")) return undefined;
  const parseGroups = (part: string): number[] | undefined => {
    if (part.length === 0) return [];
    const groups = part.split(":");
    if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return undefined;
    return groups.map((group) => Number.parseInt(group, 16));
  };
  if (compressed < 0) {
    const groups = parseGroups(value);
    return groups?.length === 8 ? groups : undefined;
  }
  const left = parseGroups(value.slice(0, compressed));
  const right = parseGroups(value.slice(compressed + 2));
  if (left === undefined || right === undefined || left.length + right.length >= 8) {
    return undefined;
  }
  return [...left, ...Array<number>(8 - left.length - right.length).fill(0), ...right];
}

function canonicalIpv6Address(groups: readonly number[]): string {
  let bestStart = -1;
  let bestLength = 0;
  for (let start = 0; start < groups.length;) {
    if (groups[start] !== 0) {
      start += 1;
      continue;
    }
    let end = start;
    while (end < groups.length && groups[end] === 0) end += 1;
    if (end - start > bestLength && end - start >= 2) {
      bestStart = start;
      bestLength = end - start;
    }
    start = end;
  }
  const values = groups.map((group) => group.toString(16));
  if (bestStart < 0) return values.join(":");
  const before = values.slice(0, bestStart).join(":");
  const after = values.slice(bestStart + bestLength).join(":");
  return `${before}::${after}`;
}

function networkGroups(
  groups: readonly number[],
  prefix: number,
  groupBits: 8 | 16
): number[] {
  let remaining = prefix;
  const maximum = (2 ** groupBits) - 1;
  return groups.map((group) => {
    if (remaining >= groupBits) {
      remaining -= groupBits;
      return group;
    }
    if (remaining <= 0) return 0;
    const mask = maximum - ((2 ** (groupBits - remaining)) - 1);
    remaining = 0;
    return group & mask;
  });
}

export function normalizeServiceAccountSourceCidr(value: string): string | undefined {
  const separator = value.lastIndexOf("/");
  if (separator <= 0 || separator !== value.indexOf("/")) return undefined;
  const address = value.slice(0, separator);
  const prefixText = value.slice(separator + 1);
  if (!/^(0|[1-9]\d{0,2})$/.test(prefixText)) return undefined;
  const prefix = Number(prefixText);
  const ipv4 = parseIpv4Address(address);
  if (ipv4 !== undefined) {
    return prefix <= 32 ? `${networkGroups(ipv4, prefix, 8).join(".")}/${prefix}` : undefined;
  }
  const ipv6 = parseIpv6Address(address);
  if (ipv6 !== undefined) {
    return prefix <= 128
      ? `${canonicalIpv6Address(networkGroups(ipv6, prefix, 16))}/${prefix}`
      : undefined;
  }
  return undefined;
}

export const serviceAccountSourceCidrSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine(
    (value) => normalizeServiceAccountSourceCidr(value) !== undefined,
    "请输入有效的 IPv4 或 IPv6 地址范围。"
  )
  .transform((value) => normalizeServiceAccountSourceCidr(value)!);

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
