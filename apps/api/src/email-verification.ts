import { createTransport } from "nodemailer";
import type { RuntimeSmtpSettings } from "./admin-service";

export interface EmailVerificationMessage {
  readonly recipient: string;
  /** The token is only present in this delivery message and must not be logged or persisted. */
  readonly verificationUrl: string;
  readonly expiresAt: string;
}

/**
 * Server-only boundary for mail delivery. Implementations must not log the
 * recipient, verification URL, SMTP credentials or provider response body.
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

/** Production SMTP sender whose current encrypted settings are resolved per message. */
export class SmtpEmailVerificationDelivery implements EmailVerificationDelivery {
  public constructor(
    private readonly readSettings: () => Promise<RuntimeSmtpSettings | undefined>
  ) {}

  public async send(message: EmailVerificationMessage): Promise<void> {
    const settings = await this.readSettings();
    if (settings === undefined) {
      throw new Error("SMTP 投递尚未配置。");
    }
    const transport = createTransport({
      host: settings.host,
      port: settings.port,
      secure: settings.secure,
      requireTLS: !settings.secure,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
      ...(settings.username.length === 0 || settings.password === null
        ? {}
        : { auth: { user: settings.username, pass: settings.password } })
    });
    try {
      await transport.sendMail({
        from: { name: settings.fromName, address: settings.fromEmail },
        to: message.recipient,
        subject: "验证你的 Urmotiv 邮箱",
        text: [
          "请打开下面的链接完成邮箱验证：",
          message.verificationUrl,
          "",
          `链接有效期至：${message.expiresAt}`,
          "如果这不是你的操作，请忽略本邮件。"
        ].join("\n")
      });
    } finally {
      transport.close();
    }
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
