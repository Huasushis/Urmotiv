import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { DatabaseExecutor, DatabaseHandle } from "@urmotiv/database";
import {
  emailNotificationPreferencesSchema,
  type EmailNotificationPreferences,
} from "@urmotiv/contracts";
import { createTransport } from "nodemailer";
import type { RuntimeSmtpSettings } from "./admin-service";
import type { DataStore } from "./repository";
import { createProblemVisibility, hasPermission } from "./permissions";
import { notFound } from "./errors";

type Kind = keyof EmailNotificationPreferences;
export interface ReviewEmailMessage {
  recipient: string;
  kind: Kind;
  problemId: string;
  url: string;
  messageId: string;
}
export async function enqueueReviewEmail(
  db: DatabaseExecutor,
  problemId: string,
  kind: Kind,
  eventKey: string,
): Promise<void> {
  // 与审核共用事务。只记录事件标识，不保存邮箱、题目内容或内部意见。
  await db.execute(sql`INSERT INTO review_email_outbox(id,event_key,user_id,problem_id,kind)
    SELECT ${randomUUID()}::uuid,${eventKey},owner_id,id,${kind} FROM problems WHERE id=${BigInt(problemId)} AND deleted_at IS NULL
    ON CONFLICT(event_key) DO NOTHING`);
}

export class ReviewEmailService {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private running: Promise<void> | undefined;
  constructor(
    private readonly db: DatabaseHandle,
    private readonly store: Pick<DataStore, "getUser" | "findVisibleProblem">,
  ) {}

  async preferences(userId: string): Promise<EmailNotificationPreferences> {
    const rows = await this.db.query<EmailNotificationPreferences>(
      sql`SELECT new_review AS "newReview",approved,rejected FROM email_notification_preferences WHERE user_id=${BigInt(userId)}`,
    );
    return emailNotificationPreferencesSchema.parse(
      rows[0] ?? { newReview: true, approved: true, rejected: true },
    );
  }
  async savePreferences(
    userId: string,
    input: EmailNotificationPreferences,
  ): Promise<EmailNotificationPreferences> {
    const value = emailNotificationPreferencesSchema.parse(input);
    const rows = await this.db.query<{
      id: string;
    }>(sql`INSERT INTO email_notification_preferences(user_id,new_review,approved,rejected)
      SELECT id,${value.newReview},${value.approved},${value.rejected} FROM users WHERE id=${BigInt(userId)} AND account_type='human' AND disabled_at IS NULL AND deleted_at IS NULL
      ON CONFLICT(user_id) DO UPDATE SET new_review=excluded.new_review,approved=excluded.approved,rejected=excluded.rejected RETURNING user_id::text AS id`);
    if (!rows.length) throw notFound();
    return value;
  }

  /** 小批投递，多个 API 实例通过数据库短租约防止同时领取。不占用审核请求。 */
  async deliverBatch(
    send: (message: ReviewEmailMessage) => Promise<void>,
    webUrl: () => Promise<string>,
  ): Promise<void> {
    for (let count = 0; count < 10; count++) {
      const item = await this.db.transaction(async (tx) => {
        const [row] = await tx.query<{
          id: string;
          userId: string;
          problemId: string;
          kind: Kind;
          attempts: number;
        }>(sql`SELECT id::text,user_id::text AS "userId",problem_id::text AS "problemId",kind,attempts FROM review_email_outbox
          WHERE completed_at IS NULL AND available_at<=now() ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`);
        if (row)
          await tx.execute(
            sql`UPDATE review_email_outbox SET available_at=now()+interval '5 minutes',attempts=attempts+1 WHERE id=${row.id}::uuid`,
          );
        return row;
      });
      if (!item) return;
      let outcome: "sent" | "skipped" | "failed" = "skipped";
      try {
        const user = await this.store.getUser(item.userId);
        const allowed =
          user?.accountType === "human" &&
          !user.disabled &&
          hasPermission(user, "auth.login", {}) &&
          (await this.preferences(item.userId))[item.kind];
        const problem = allowed
          ? await this.store.findVisibleProblem(
              item.problemId,
              createProblemVisibility(user!),
            )
          : undefined;
        const [email] =
          problem?.ownerId === item.userId
            ? await this.db.query<{ address: string }>(
                sql`SELECT address FROM user_emails WHERE user_id=${BigInt(item.userId)} AND is_primary=true AND verified_at IS NOT NULL`,
              )
            : [];
        if (email) {
          const url = new URL(await webUrl());
          if (!["https:", "http:"].includes(url.protocol))
            throw new Error("MAIL_SITE_URL_INVALID");
          url.pathname = `/problems/${item.problemId}`;
          url.search = "?tab=reviews";
          url.hash = "";
          await send({
            recipient: email.address,
            kind: item.kind,
            problemId: item.problemId,
            url: url.toString(),
            messageId: `<${item.id}@urmotiv.notifications>`,
          });
          outcome = "sent";
        }
      } catch {
        if (item.attempts < 4) {
          // 不记录提供商错误原文，避免邮箱、SMTP 凭据或邮件内容进入日志。
          await this.db.execute(
            sql`UPDATE review_email_outbox SET available_at=now()+(${Math.min(60, 2 ** item.attempts)} * interval '5 minutes') WHERE id=${item.id}::uuid`,
          );
          continue;
        }
        outcome = "failed";
      }
      await this.db.execute(
        sql`UPDATE review_email_outbox SET completed_at=now(),outcome=${outcome} WHERE id=${item.id}::uuid`,
      );
    }
    await this.db.execute(
      sql`DELETE FROM review_email_outbox WHERE completed_at<now()-interval '30 days'`,
    );
  }
  start(
    send: (message: ReviewEmailMessage) => Promise<void>,
    webUrl: () => Promise<string>,
  ): void {
    if (!this.stopped) return;
    this.stopped = false;
    const tick = () => {
      this.running = this.deliverBatch(send, webUrl)
        .catch(() => undefined)
        .finally(() => {
          this.running = undefined;
          if (!this.stopped) {
            this.timer = setTimeout(tick, 30_000);
            this.timer.unref();
          }
        });
    };
    this.timer = setTimeout(tick, 1000);
    this.timer.unref();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }
}

export async function sendReviewEmail(
  settings: RuntimeSmtpSettings | undefined,
  message: ReviewEmailMessage,
): Promise<void> {
  if (!settings) throw new Error("SMTP_NOT_CONFIGURED");
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
      : { auth: { user: settings.username, pass: settings.password } }),
  });
  const text = {
    newReview: "收到了新的审核意见",
    approved: "已审核通过",
    rejected: "已审核不通过",
  }[message.kind];
  try {
    await transport.sendMail({
      from: { name: settings.fromName, address: settings.fromEmail },
      to: message.recipient,
      messageId: message.messageId,
      subject: `Urmotiv：你的题目${text}`,
      text: `你的题目 #${message.problemId} ${text}。\n请登录后查看详情和当前状态：\n${message.url}\n\n邮件不包含题面或审核原文。你可以在“个人资料 → 邮件通知”关闭这类通知。`,
    });
  } finally {
    transport.close();
  }
}
