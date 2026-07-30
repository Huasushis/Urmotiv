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

export function normalizeEmail(address: string): string {
  return z.string().email().max(320).parse(address.trim().toLocaleLowerCase("en-US"));
}
