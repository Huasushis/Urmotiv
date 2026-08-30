import { beforeEach, describe, expect, it, vi } from "vitest";

const smtpMocks = vi.hoisted(() => ({
  sendMail: vi.fn(),
  close: vi.fn(),
  createTransport: vi.fn()
}));

vi.mock("nodemailer", () => ({
  createTransport: smtpMocks.createTransport
}));

import { SmtpEmailVerificationDelivery } from "../src/email-verification";

beforeEach(() => {
  smtpMocks.sendMail.mockReset();
  smtpMocks.close.mockReset();
  smtpMocks.createTransport.mockReset();
  smtpMocks.createTransport.mockReturnValue({
    sendMail: smtpMocks.sendMail,
    close: smtpMocks.close
  });
});

describe("SMTP 邮箱验证投递", () => {
  it("未完整配置时失败且不会建立外部连接", async () => {
    const delivery = new SmtpEmailVerificationDelivery(async () => undefined);
    await expect(delivery.send({
      recipient: "member@example.test",
      verificationUrl: "https://urmotiv.example.test/#/verify-email?token=redacted",
      expiresAt: "2026-08-30T12:00:00.000Z"
    })).rejects.toThrow("SMTP 投递尚未配置");
    expect(smtpMocks.createTransport).not.toHaveBeenCalled();
  });

  it("使用当前运行时设置发送纯文本验证邮件并始终关闭连接", async () => {
    smtpMocks.sendMail.mockResolvedValue({ messageId: "redacted" });
    const delivery = new SmtpEmailVerificationDelivery(async () => ({
      host: "smtp.example.test",
      port: 587,
      secure: false,
      username: "mailer",
      password: "smtp-password",
      fromEmail: "noreply@example.test",
      fromName: "Urmotiv"
    }));
    await delivery.send({
      recipient: "member@example.test",
      verificationUrl: "https://urmotiv.example.test/#/verify-email?token=redacted",
      expiresAt: "2026-08-30T12:00:00.000Z"
    });
    expect(smtpMocks.createTransport).toHaveBeenCalledWith(expect.objectContaining({
      host: "smtp.example.test",
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: "mailer", pass: "smtp-password" }
    }));
    expect(smtpMocks.sendMail).toHaveBeenCalledWith(expect.objectContaining({
      from: { name: "Urmotiv", address: "noreply@example.test" },
      to: "member@example.test",
      subject: expect.stringContaining("验证")
    }));
    expect(smtpMocks.close).toHaveBeenCalledOnce();
  });

  it("发送失败时仍关闭连接", async () => {
    smtpMocks.sendMail.mockRejectedValue(new Error("provider unavailable"));
    const delivery = new SmtpEmailVerificationDelivery(async () => ({
      host: "smtp.example.test",
      port: 465,
      secure: true,
      username: "",
      password: null,
      fromEmail: "noreply@example.test",
      fromName: "Urmotiv"
    }));
    await expect(delivery.send({
      recipient: "member@example.test",
      verificationUrl: "https://urmotiv.example.test/#/verify-email?token=redacted",
      expiresAt: "2026-08-30T12:00:00.000Z"
    })).rejects.toThrow("provider unavailable");
    expect(smtpMocks.createTransport).toHaveBeenCalledWith(expect.not.objectContaining({ auth: expect.anything() }));
    expect(smtpMocks.close).toHaveBeenCalledOnce();
  });
});
