import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { z } from "zod";

const stateLifetimeMs = 10 * 60_000;
const responseByteLimit = 1_000_000;
const safeAttributeNameSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9_.:-]+$/);

const httpUrlSchema = z.string().url().refine((value) => {
  const url = new URL(value);
  return (
    (url.protocol === "https:" || url.protocol === "http:") &&
    url.username.length === 0 &&
    url.password.length === 0
  );
}, "CAS 地址必须是不含账号密码的 HTTP 或 HTTPS 地址。");

export const casConfigurationSchema = z
  .object({
    loginUrl: httpUrlSchema,
    validateUrl: httpUrlSchema,
    callbackUrl: httpUrlSchema,
    subjectAttribute: safeAttributeNameSchema,
    emailAttribute: safeAttributeNameSchema.optional(),
    nicknameAttribute: safeAttributeNameSchema.optional(),
    studentIdAttributes: z.array(safeAttributeNameSchema).max(10).default([])
  })
  .strict();

export type CasConfiguration = z.infer<typeof casConfigurationSchema>;

export interface CasLoginStateStore {
  put(nonceDigest: string, expiresAt: string): Promise<void>;
  consume(nonceDigest: string, now: string): Promise<boolean>;
}

export interface CasFetch {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

export interface CasIdentity {
  readonly provider: "ustc-cas";
  readonly subject: string;
  readonly nickname?: string;
  readonly email?: string;
  readonly studentIds: readonly { attribute: string; value: string }[];
  readonly availableAttributeNames: readonly string[];
}

export interface CasLoginStart {
  readonly loginUrl: string;
  readonly state: string;
  readonly serviceUrl: string;
  readonly expiresAt: string;
}

interface CasStatePayload {
  readonly version: 1;
  readonly nonce: string;
  readonly returnTo: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export class CasAuthenticationError extends Error {
  public constructor(
    message: string,
    public readonly code: string,
    public readonly availableAttributeNames: readonly string[] = []
  ) {
    super(message);
    this.name = "CasAuthenticationError";
  }
}

export class CasClient {
  readonly #configuration: CasConfiguration;
  readonly #stateSecret: Uint8Array;
  readonly #states: CasLoginStateStore;
  readonly #fetch: CasFetch;
  readonly #now: () => Date;

  public constructor(options: {
    configuration: CasConfiguration;
    stateSecret: Uint8Array;
    states: CasLoginStateStore;
    fetch?: CasFetch;
    now?: () => Date;
  }) {
    this.#configuration = casConfigurationSchema.parse(options.configuration);
    if (options.stateSecret.byteLength < 32) {
      throw new Error("CAS 登录状态密钥至少需要 32 字节。");
    }
    this.#stateSecret = new Uint8Array(options.stateSecret);
    this.#states = options.states;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date());
  }

  public async startLogin(returnTo = "/"): Promise<CasLoginStart> {
    const safeReturnTo = parseReturnPath(returnTo);
    const now = this.#now();
    const expiresAt = new Date(now.getTime() + stateLifetimeMs).toISOString();
    const payload: CasStatePayload = {
      version: 1,
      nonce: randomBytes(24).toString("base64url"),
      returnTo: safeReturnTo,
      issuedAt: now.toISOString(),
      expiresAt
    };
    const state = signState(payload, this.#stateSecret);
    await this.#states.put(digestNonce(payload.nonce), expiresAt);

    const serviceUrl = withQuery(this.#configuration.callbackUrl, "state", state);
    const loginUrl = withQuery(this.#configuration.loginUrl, "service", serviceUrl);
    return { loginUrl, state, serviceUrl, expiresAt };
  }

  public async finishLogin(input: {
    state: string;
    ticket: string;
  }): Promise<{ identity: CasIdentity; returnTo: string }> {
    const payload = verifyState(input.state, this.#stateSecret);
    const now = this.#now();
    if (Date.parse(payload.expiresAt) <= now.getTime()) {
      throw new CasAuthenticationError("统一身份认证登录已过期，请重新开始。", "state_expired");
    }
    if (!(await this.#states.consume(digestNonce(payload.nonce), now.toISOString()))) {
      throw new CasAuthenticationError(
        "统一身份认证登录状态已经使用或不存在，请重新开始。",
        "state_reused"
      );
    }

    const ticket = z.string().trim().min(1).max(2_000).parse(input.ticket);
    const serviceUrl = withQuery(this.#configuration.callbackUrl, "state", input.state);
    const validateUrl = new URL(this.#configuration.validateUrl);
    validateUrl.searchParams.set("service", serviceUrl);
    validateUrl.searchParams.set("ticket", ticket);
    const response = await this.#fetch(validateUrl, {
      method: "GET",
      headers: { Accept: "application/xml, text/xml" },
      redirect: "error"
    });
    if (!response.ok) {
      throw new CasAuthenticationError("统一身份认证未能校验登录票据。", "validation_failed");
    }
    const xml = await readLimitedText(response, responseByteLimit);
    return {
      identity: parseCasIdentity(xml, this.#configuration),
      returnTo: payload.returnTo
    };
  }
}

export function parseCasIdentity(xml: string, configuration: CasConfiguration): CasIdentity {
  const config = casConfigurationSchema.parse(configuration);
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new CasAuthenticationError("统一身份认证返回了不允许的 XML 声明。", "unsafe_xml");
  }
  let parsed: unknown;
  try {
    parsed = new XMLParser({
      ignoreAttributes: true,
      removeNSPrefix: true,
      parseTagValue: false,
      trimValues: true
    }).parse(xml) as unknown;
  } catch {
    throw new CasAuthenticationError("统一身份认证返回格式无法解析。", "invalid_response");
  }

  const success = readRecord(readRecord(parsed)?.serviceResponse)?.authenticationSuccess;
  const successRecord = readRecord(success);
  if (successRecord === undefined) {
    throw new CasAuthenticationError("统一身份认证没有确认登录成功。", "authentication_failed");
  }
  const attributes = flattenAttributes(readRecord(successRecord.attributes));
  const casUser = firstString(successRecord.user);
  if (casUser !== undefined) {
    attributes.set("cas:user", [casUser]);
  }
  const availableAttributeNames = [...attributes.keys()].sort((left, right) =>
    left.localeCompare(right)
  );
  const subject = firstAttribute(attributes, config.subjectAttribute);
  if (subject === undefined) {
    throw new CasAuthenticationError(
      `统一身份认证没有返回配置的稳定身份字段 ${config.subjectAttribute}。`,
      "subject_attribute_missing",
      availableAttributeNames
    );
  }

  const nickname = readOptionalAttribute(attributes, config.nicknameAttribute);
  const email = readOptionalAttribute(attributes, config.emailAttribute);
  const studentIds = config.studentIdAttributes.flatMap((attribute) =>
    (attributes.get(attribute) ?? []).map((value) => ({ attribute, value }))
  );
  return {
    provider: "ustc-cas",
    subject,
    ...(nickname === undefined ? {} : { nickname }),
    ...(email === undefined ? {} : { email }),
    studentIds,
    availableAttributeNames
  };
}

function signState(payload: CasStatePayload, secret: Uint8Array): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function verifyState(state: string, secret: Uint8Array): CasStatePayload {
  if (state.length > 4_096) {
    throw new CasAuthenticationError("统一身份认证登录状态无效。", "invalid_state");
  }
  const [encoded, signature, extra] = state.split(".");
  if (encoded === undefined || signature === undefined || extra !== undefined) {
    throw new CasAuthenticationError("统一身份认证登录状态无效。", "invalid_state");
  }
  const expected = createHmac("sha256", secret).update(encoded).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, "base64url");
  } catch {
    throw new CasAuthenticationError("统一身份认证登录状态无效。", "invalid_state");
  }
  if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
    throw new CasAuthenticationError("统一身份认证登录状态无效。", "invalid_state");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
  } catch {
    throw new CasAuthenticationError("统一身份认证登录状态无效。", "invalid_state");
  }
  const schema = z
    .object({
      version: z.literal(1),
      nonce: z.string().min(24).max(200),
      returnTo: z.string().max(2_000),
      issuedAt: z.string().datetime(),
      expiresAt: z.string().datetime()
    })
    .strict();
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new CasAuthenticationError("统一身份认证登录状态无效。", "invalid_state");
  }
  return { ...result.data, returnTo: parseReturnPath(result.data.returnTo) };
}

function parseReturnPath(value: string): string {
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    /[\u0000-\u001f]/.test(value)
  ) {
    throw new CasAuthenticationError("登录后的返回地址不安全。", "invalid_return_path");
  }
  const parsed = new URL(value, "https://urmotiv.invalid");
  if (parsed.origin !== "https://urmotiv.invalid") {
    throw new CasAuthenticationError("登录后的返回地址不安全。", "invalid_return_path");
  }
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

function withQuery(url: string, name: string, value: string): string {
  const result = new URL(url);
  result.searchParams.set(name, value);
  return result.toString();
}

function digestNonce(nonce: string): string {
  return createHash("sha256").update(nonce, "utf8").digest("hex");
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function flattenAttributes(value: Record<string, unknown> | undefined): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const [name, raw] of Object.entries(value ?? {})) {
    const values = (Array.isArray(raw) ? raw : [raw])
      .map(firstString)
      .filter((item): item is string => item !== undefined && item.length > 0);
    if (values.length > 0) {
      result.set(name, values);
    }
  }
  return result;
}

function firstString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return firstString(value[0]);
  }
  return undefined;
}

function firstAttribute(attributes: Map<string, string[]>, name: string): string | undefined {
  return attributes.get(name)?.[0];
}

function readOptionalAttribute(
  attributes: Map<string, string[]>,
  name: string | undefined
): string | undefined {
  return name === undefined ? undefined : firstAttribute(attributes, name);
}

async function readLimitedText(response: Response, limit: number): Promise<string> {
  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader !== null && Number(lengthHeader) > limit) {
    throw new CasAuthenticationError("统一身份认证响应超过大小限制。", "response_too_large");
  }
  if (response.body === null) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) {
      break;
    }
    size += next.value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new CasAuthenticationError("统一身份认证响应超过大小限制。", "response_too_large");
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
