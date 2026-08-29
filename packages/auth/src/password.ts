import { hash, verify, type Options } from "@node-rs/argon2";
import { z } from "zod";

export const newPasswordSchema = z
  .string()
  .min(12, "密码至少需要 12 个字符。")
  .max(1_024, "密码过长。");

const passwordOptions: Readonly<Options> = Object.freeze({
  // @node-rs/argon2 declares this runtime value as an ambient const enum.
  algorithm: 2,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32
});

export async function hashPassword(password: string): Promise<string> {
  return hash(newPasswordSchema.parse(password), passwordOptions);
}

export async function verifyPassword(encodedHash: string, password: string): Promise<boolean> {
  if (password.length > 1_024 || !encodedHash.startsWith("$argon2id$")) {
    return false;
  }
  try {
    return await verify(encodedHash, password, passwordOptions);
  } catch {
    return false;
  }
}

/**
 * 固定合成 Argon2id 摘要：当邮箱没有合格口令哈希时，用它执行一次与真实校验
 * 等价的 Argon2id 计算，统一“邮箱未知 / 口令错误 / 账号不可登录”三条路径的
 * 行为。它不是任何真实账号的口令，也不是密钥。
 */
export const dummyEmailLoginPasswordDigest =
  "$argon2id$v=19$m=19456,t=2,p=1$ZTts/8qP6pH10pe2/AM3XQ$IQkAFLUTqGDeJ0Kf8GEM/uMJHhQ5pSe1O7GB9rwA/G4";

/**
 * 邮箱登录的口令校验：存在合格哈希时校验该哈希；否则对固定合成摘要执行
 * 一次 Argon2id 计算并返回 false，保证全部登录失败路径都做过一次等价验证。
 */
export async function verifyEmailLoginPassword(
  encodedHash: string | undefined,
  password: string
): Promise<boolean> {
  if (encodedHash === undefined) {
    return verifyPassword(dummyEmailLoginPasswordDigest, password);
  }
  return verifyPassword(encodedHash, password);
}

export function normalizeEmail(address: string): string {
  return z.string().email().max(320).parse(address.trim().toLocaleLowerCase("en-US"));
}
