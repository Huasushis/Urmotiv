import { describe, expect, it } from "vitest";
import {
  createServiceAccountTokenInputSchema,
  createdServiceAccountTokenSchema,
  robotHardDeniedPermissions,
  serviceAccountTokenSchema
} from "../src";

const validInput = {
  name: "Fermata 审题服务",
  permissions: ["auth.login", "problem.view.all", "problem.review"],
  sourceCidrs: ["127.0.0.1/32", "2001:db8::/64"],
  expiresAt: "2030-08-01T00:00:00.000Z"
} as const;

describe("机器人令牌管理契约", () => {
  it("接受有界、去重且不包含固定禁权的令牌设置", () => {
    expect(createServiceAccountTokenInputSchema.parse(validInput)).toEqual(validInput);
  });

  it("拒绝缺少登录权限、重复权限、重复地址范围和无效地址", () => {
    expect(createServiceAccountTokenInputSchema.safeParse({
      ...validInput,
      permissions: ["problem.review"]
    }).success).toBe(false);
    expect(createServiceAccountTokenInputSchema.safeParse({
      ...validInput,
      permissions: ["auth.login", "problem.review", "problem.review"]
    }).success).toBe(false);
    expect(createServiceAccountTokenInputSchema.safeParse({
      ...validInput,
      sourceCidrs: ["2001:DB8::/64", "2001:db8::/64"]
    }).success).toBe(false);
    expect(createServiceAccountTokenInputSchema.safeParse({
      ...validInput,
      sourceCidrs: ["999.1.2.3/32"]
    }).success).toBe(false);
    expect(createServiceAccountTokenInputSchema.safeParse({
      ...validInput,
      sourceCidrs: ["001.002.003.004/32"]
    }).success).toBe(false);
  });

  it("接受 IPv4 嵌入的 IPv6，并按同一规范识别等价地址", () => {
    const embedded = createServiceAccountTokenInputSchema.parse({
      ...validInput,
      sourceCidrs: ["::ffff:192.0.2.128/128"]
    });
    expect(embedded.sourceCidrs).toEqual(["::ffff:c000:280/128"]);

    expect(createServiceAccountTokenInputSchema.safeParse({
      ...validInput,
      sourceCidrs: [
        "2001:0db8:0:0:ffff:0:0:1/64",
        "2001:db8::/64"
      ]
    }).success).toBe(false);
    expect(createServiceAccountTokenInputSchema.safeParse({
      ...validInput,
      sourceCidrs: ["192.0.2.1/24", "192.0.2.200/24"]
    }).success).toBe(false);
  });

  it("拒绝把任一机器人固定禁止项写成令牌权限", () => {
    for (const permission of robotHardDeniedPermissions) {
      expect(createServiceAccountTokenInputSchema.safeParse({
        ...validInput,
        permissions: ["auth.login", permission]
      }).success).toBe(false);
    }
  });

  it("列表条目不能混入令牌原文或摘要，创建结果才包含一次原文", () => {
    const item = {
      id: "10000000-0000-4000-8000-000000000001",
      name: validInput.name,
      displayPrefix: "urv_example1",
      permissions: [...validInput.permissions],
      sourceCidrs: [...validInput.sourceCidrs],
      expiresAt: validInput.expiresAt,
      lastUsedAt: null,
      revokedAt: null,
      createdAt: "2026-08-01T00:00:00.000Z"
    };

    expect(serviceAccountTokenSchema.parse(item)).toEqual(item);
    expect(serviceAccountTokenSchema.safeParse({
      ...item,
      token: `urv_${"a".repeat(43)}`
    }).success).toBe(false);
    expect(serviceAccountTokenSchema.safeParse({
      ...item,
      tokenDigest: "a".repeat(64)
    }).success).toBe(false);
    expect(createdServiceAccountTokenSchema.parse({
      item,
      token: `urv_${"a".repeat(43)}`
    })).toEqual({ item, token: `urv_${"a".repeat(43)}` });
  });
});
