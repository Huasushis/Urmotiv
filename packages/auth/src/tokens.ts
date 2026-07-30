import { createHash, randomBytes } from "node:crypto";

export interface SecretToken {
  readonly token: string;
  readonly digest: string;
  readonly displayPrefix: string;
}

export function createSessionToken(): SecretToken {
  return createToken("");
}

export function createApiToken(): SecretToken {
  return createToken("urv_");
}

/**
 * Creates the secret included in a verification link. Callers must persist only
 * `digest`, never `token` or a URL containing it.
 */
export function createEmailVerificationToken(): SecretToken {
  return createToken("uve_");
}

export function digestSecretToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function createToken(prefix: string): SecretToken {
  const token = `${prefix}${randomBytes(32).toString("base64url")}`;
  return {
    token,
    digest: digestSecretToken(token),
    displayPrefix: token.slice(0, prefix.length + 8)
  };
}
