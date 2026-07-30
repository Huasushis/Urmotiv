export interface EmailVerificationMessage {
  readonly recipient: string;
  /** The token is only present in this delivery message and must not be logged or persisted. */
  readonly verificationUrl: string;
  readonly expiresAt: string;
}

/**
 * Server-only boundary for a reviewed mail provider. The repository deliberately
 * ships no network mail sender: production registration stays disabled until one
 * is configured and reviewed.
 */
export interface EmailVerificationDelivery {
  send(message: EmailVerificationMessage): Promise<void>;
}

/** Test-only delivery sink. It is injected by tests and is never exposed through an HTTP route. */
export class InMemoryEmailVerificationOutbox implements EmailVerificationDelivery {
  readonly messages: EmailVerificationMessage[] = [];

  public async send(message: EmailVerificationMessage): Promise<void> {
    this.messages.push({ ...message });
  }
}

export function createEmailVerificationUrl(webBaseUrl: string, token: string): string {
  const url = new URL(webBaseUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("邮箱验证页面地址必须使用 HTTP 或 HTTPS。");
  }
  url.hash = `/verify-email?${new URLSearchParams({ token }).toString()}`;
  return url.toString();
}
