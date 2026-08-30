import { newPasswordSchema, normalizeEmail } from "@urmotiv/auth";

export const batchAccountMaximumRows = 100;

export interface ParsedBatchAccount {
  readonly line: number;
  readonly username: string | null;
  readonly nickname: string;
  readonly displayEmail: string;
  readonly normalizedEmail: string;
  readonly password: string;
}

export interface HashedBatchAccount {
  readonly line: number;
  readonly username: string | null;
  readonly nickname: string;
  readonly displayEmail: string;
  readonly normalizedEmail: string;
  readonly passwordHash: string;
}

export type BatchAccountFieldErrors = Record<string, string[]>;

export class BatchAccountInputError extends Error {
  public readonly fieldErrors: BatchAccountFieldErrors;

  public constructor(fieldErrors: BatchAccountFieldErrors) {
    super("批量账号内容不符合要求。");
    this.name = "BatchAccountInputError";
    this.fieldErrors = fieldErrors;
  }
}

export class BatchAccountConflictError extends Error {
  public readonly fieldErrors: BatchAccountFieldErrors;

  public constructor(fieldErrors: BatchAccountFieldErrors = {}) {
    super("批量账号与已有账号冲突。");
    this.name = "BatchAccountConflictError";
    this.fieldErrors = fieldErrors;
  }
}

export class BatchAccountAuditWriteError extends Error {
  public constructor() {
    super("账号创建记录暂时无法保存。");
    this.name = "BatchAccountAuditWriteError";
  }
}

function addFieldError(fieldErrors: BatchAccountFieldErrors, field: string, message: string): void {
  (fieldErrors[field] ??= []).push(message);
}

function validateUsername(value: string, line: number, fieldErrors: BatchAccountFieldErrors): string | null {
  const username = value.trim();
  if (username.length === 0) {
    return null;
  }
  if (username.length > 255 || /\s/u.test(username)) {
    addFieldError(fieldErrors, `lines.${line}`, "用户名只能是不含空格的标识，长度不超过 255 个字符。");
    return null;
  }
  return username;
}

export function normalizeUsernameKey(username: string): string {
  return username.trim().toLocaleLowerCase();
}

export function parseBatchAccountText(text: string): ParsedBatchAccount[] {
  const fieldErrors: BatchAccountFieldErrors = {};
  const rows: ParsedBatchAccount[] = [];
  const normalizedText = text.replace(/\r\n?/gu, "\n");
  const lines = normalizedText.split("\n");

  for (const [index, rawLine] of lines.entries()) {
    const line = index + 1;
    if (rawLine.trim().length === 0) {
      continue;
    }

    const columns = rawLine.split("\t");
    if (columns.length !== 4) {
      addFieldError(fieldErrors, `lines.${line}`, "每行必须使用 Tab 分隔为四列：用户名、昵称、邮箱、密码。");
      continue;
    }

    const [usernameValue, nicknameValue, emailValue, password] = columns as [string, string, string, string];
    const username = validateUsername(usernameValue, line, fieldErrors);
    const nickname = nicknameValue.trim();
    const displayEmail = emailValue.trim();

    if (nickname.length === 0 || nickname.length > 120) {
      addFieldError(fieldErrors, `lines.${line}`, "昵称不能为空且不能超过 120 个字符。");
    }

    let normalizedEmail: string | undefined;
    try {
      normalizedEmail = normalizeEmail(displayEmail);
    } catch {
      addFieldError(fieldErrors, `lines.${line}`, "邮箱格式不正确。");
    }

    const passwordResult = newPasswordSchema.safeParse(password);
    if (!passwordResult.success) {
      addFieldError(fieldErrors, `lines.${line}`, "密码长度必须为 12–1024 个字符。");
    }

    if (nickname.length > 0 && nickname.length <= 120 && normalizedEmail !== undefined && passwordResult.success) {
      rows.push({
        line,
        username,
        nickname,
        displayEmail,
        normalizedEmail,
        password
      });
    }
  }

  if (rows.length === 0 && Object.keys(fieldErrors).length === 0) {
    addFieldError(fieldErrors, "text", "至少填写一行账号。");
  }
  if (rows.length > batchAccountMaximumRows) {
    addFieldError(fieldErrors, "text", `每批最多创建 ${batchAccountMaximumRows} 个账号。`);
  }

  const seenEmails = new Set<string>();
  const seenUsernames = new Set<string>();
  for (const row of rows) {
    if (seenEmails.has(row.normalizedEmail)) {
      addFieldError(fieldErrors, `lines.${row.line}`, "本批次中邮箱重复。");
    }
    seenEmails.add(row.normalizedEmail);
    if (row.username !== null) {
      const usernameKey = normalizeUsernameKey(row.username);
      if (seenUsernames.has(usernameKey)) {
        addFieldError(fieldErrors, `lines.${row.line}`, "本批次中用户名重复。");
      }
      seenUsernames.add(usernameKey);
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    const hasConflict = Object.values(fieldErrors).some((messages) =>
      messages.some((message) => message.includes("重复"))
    );
    if (hasConflict) {
      throw new BatchAccountConflictError(fieldErrors);
    }
    throw new BatchAccountInputError(fieldErrors);
  }

  return rows;
}
