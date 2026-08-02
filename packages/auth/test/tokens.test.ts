import { describe, expect, it } from "vitest";
import {
  createApiToken,
  createEmailVerificationToken,
  createSessionToken,
  digestSecretToken
} from "../src/tokens";

describe("会话和机器人令牌", () => {
  it("只需保存摘要即可核对随机会话令牌", () => {
    const created = createSessionToken();
    expect(created.token).not.toBe(created.digest);
    expect(digestSecretToken(created.token)).toBe(created.digest);
    expect(created.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("机器人令牌有可辨认前缀且每次不同", () => {
    const first = createApiToken();
    const second = createApiToken();
    expect(first.token).toMatch(/^urv_/);
    expect(first.token).not.toBe(second.token);
    expect(first.displayPrefix).toBe(first.token.slice(0, 12));
  });

  it("邮箱验证令牌只把摘要交给持久化层", () => {
    const created = createEmailVerificationToken();
    expect(created.token).toMatch(/^uve_/);
    expect(created.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(created.digest).toBe(digestSecretToken(created.token));
  });
});
