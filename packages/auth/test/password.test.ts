import { describe, expect, it } from "vitest";
import { hashPassword, normalizeEmail, verifyPassword } from "../src/password";

describe("邮箱和密码", () => {
  it("使用 Argon2id 保存并校验密码", async () => {
    const encoded = await hashPassword("correct horse battery staple");
    expect(encoded).toMatch(/^\$argon2id\$/);
    await expect(verifyPassword(encoded, "correct horse battery staple")).resolves.toBe(true);
    await expect(verifyPassword(encoded, "wrong password")).resolves.toBe(false);
  });

  it("标准化邮箱但不应用服务商特有改写", () => {
    expect(normalizeEmail("  User.Name+tag@Example.COM ")).toBe(
      "user.name+tag@example.com"
    );
  });
});
