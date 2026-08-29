import { describe, expect, it, vi } from "vitest";

vi.mock("@node-rs/argon2", () => {
  const verify = vi.fn(async () => false);
  const hash = vi.fn(async () => "mocked-hash");
  return { verify, hash };
});

import { verify } from "@node-rs/argon2";
import {
  dummyEmailLoginPasswordDigest,
  verifyEmailLoginPassword,
  verifyPassword
} from "../src/password";

const mockedVerify = vi.mocked(verify, true);

describe("邮箱登录口令校验的确定性依赖契约", () => {
  it("没有合格哈希时对固定合成摘要执行一次 Argon2id 校验并返回 false", async () => {
    mockedVerify.mockClear();
    await expect(verifyEmailLoginPassword(undefined, "some-password-value")).resolves.toBe(false);
    expect(mockedVerify).toHaveBeenCalledTimes(1);
    expect(mockedVerify).toHaveBeenCalledWith(
      dummyEmailLoginPasswordDigest,
      "some-password-value",
      expect.any(Object)
    );
    expect(dummyEmailLoginPasswordDigest).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/u);
  });

  it("存在合格哈希时校验真实哈希而不是合成摘要", async () => {
    mockedVerify.mockReset();
    mockedVerify.mockImplementation(async () => true);
    const storedHash = "$argon2id$v=19$m=19456,t=2,p=1$salt-salt-salt-salt$hash-hash-hash-hash-hash-hash";
    await expect(verifyEmailLoginPassword(storedHash, "some-password-value")).resolves.toBe(true);
    expect(mockedVerify).toHaveBeenCalledTimes(1);
    expect(mockedVerify.mock.calls[0]?.[0]).toBe(storedHash);
  });

  it("验证结果直接取自 argon2 依赖且不测量耗时", async () => {
    mockedVerify.mockReset();
    mockedVerify.mockImplementation(async () => false);
    await expect(verifyPassword("$argon2id$v=19$m=19456,t=2,p=1$salt-salt-salt-salt$hash-hash-hash-hash-hash-hash", "x")).resolves.toBe(false);
    await expect(verifyPassword("not-an-argon2-hash", "x")).resolves.toBe(false);
  });
});
