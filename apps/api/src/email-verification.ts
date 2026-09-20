import { createTransport } from "nodemailer";
import type { RuntimeSmtpSettings } from "./admin-service";

export interface EmailVerificationMessage {
  readonly purpose?: "email-verification" | "password-reset" | "email-change" | "email-changed";
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
    const wording = {
      "email-verification": ["验证你的 Urmotiv 邮箱", "请打开下面的链接完成邮箱验证："],
      "password-reset": ["重设你的 Urmotiv 密码", "请打开下面的链接设置新密码。完成后所有旧会话都会退出："],
      "email-change": ["确认更换 Urmotiv 联系邮箱", "请打开下面的链接确认新邮箱。确认前原邮箱保持不变："],
      "email-changed": ["你的 Urmotiv 联系邮箱已更改", "此邮箱已从账号的主要联系地址解绑。如果这不是你的操作，请立即联系站点管理员："]
    } as const;
    const [subject,introduction]=wording[message.purpose ?? "email-verification"];
    try {
      await transport.sendMail({
        from: { name: settings.fromName, address: settings.fromEmail },
        to: message.recipient,
        subject,
        text: [
          introduction,
          message.verificationUrl,
          "",
          ...(message.purpose === "email-changed" ? [] : [`链接有效期至：${message.expiresAt}`, "如果这不是你的操作，请忽略本邮件。"])
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
