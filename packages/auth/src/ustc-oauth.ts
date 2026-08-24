import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import { z } from "zod";
import type { CasLoginStateStore } from "./cas";

const stateLifetimeMs = 10 * 60_000;
const stateLifetimeSeconds = stateLifetimeMs / 1_000;
const browserBindingByteLength = 32;
const browserBindingDigestContext = "urmotiv:ustc-oauth:browser-binding:v1\0";
const browserBindingSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const tokenResponseCap = 8_192;
const profileResponseCap = 16_384;
const ustcOAuthCallbackPaths = {
  "/api/v1/auth/ustc/callback": true,
  "/oauth/ustc/callback": true
} as const;

const httpUrlSchema = z.string().url().refine((value) => {
  const url = new URL(value);
  return (
    (url.protocol === "https:" || url.protocol === "http:") &&
    url.username.length === 0 &&
    url.password.length === 0
  );
}, "USTC OAuth 地址必须是不含账号密码的 HTTP 或 HTTPS 地址。");

/**
 * USTC 统一身份认证 OAuth2 客户端配置。客户端密钥只在服务器进程内存中使用，
 * 用于向令牌端点换取访问令牌；它永远不会出现在接口响应、日志或审计记录里。
 */
export const ustcOAuthConfigurationSchema = z
  .object({
    authorizeUrl: httpUrlSchema,
    tokenUrl: httpUrlSchema,
    profileUrl: httpUrlSchema,
    redirectUri: httpUrlSchema.refine((value) => {
      const url = new URL(value);
      const schemeEnd = value.indexOf("://");
      const authorityStart = schemeEnd + 3;
      const pathStart = value.indexOf("/", authorityStart);
      const queryStart = value.indexOf("?", authorityStart);
      const hashStart = value.indexOf("#", authorityStart);
      const pathEnd = Math.min(
        queryStart === -1 ? value.length : queryStart,
        hashStart === -1 ? value.length : hashStart
      );
      const rawPath =
        pathStart === -1 || pathStart > pathEnd ? "/" : value.slice(pathStart, pathEnd);
      return (
        url.protocol === "https:" &&
        url.username.length === 0 &&
        url.password.length === 0 &&
        Object.hasOwn(ustcOAuthCallbackPaths, rawPath) &&
        url.pathname === rawPath &&
        url.search.length === 0 &&
        url.hash.length === 0
      );
    }, "回调地址必须是 HTTPS 且精确指向 /api/v1/auth/ustc/callback 或 /oauth/ustc/callback，不能带查询参数或片段。"),
    clientId: z.string().trim().min(1, "client_id 不能为空。").max(200),
    clientSecret: z
      .string()
      .min(16, "client_secret 至少需要 16 个字符。")
      .max(4_096),
    scope: z.string().max(200).optional()
  })
  .strict();

export type UstcOAuthConfiguration = z.infer<typeof ustcOAuthConfigurationSchema>;

export interface UstcOAuthFetch {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

/**
 * 从 USTC OAuth2 资料端点解析出的稳定身份。subject 取自 attributes.gid（优先）
 * 或顶层 id，作为“认证来源 + 稳定编号”的唯一键；username 取自学工号 zjhm，
 * realName 取自 name，email 取自 email。这些字段只在登录瞬间用于建档或更新，
 * 不写入日志，也不回显给除本人以外的接口。
 */
export interface UstcOAuthIdentity {
  readonly provider: "ustc-oauth";
  readonly subject: string;
  readonly username: string | undefined;
  readonly realName: string | undefined;
  readonly email: string | undefined;
  readonly nickname: string;
  readonly studentIds: readonly { readonly attribute: string; readonly value: string }[];
}

export interface UstcOAuthLoginStart {
  readonly authorizeUrl: string;
  readonly state: string;
  readonly returnTo: string;
  readonly browserBindingCookie: {
    readonly name: string;
    readonly value: string;
    readonly maxAgeSeconds: number;
  };
}

interface UstcOAuthStatePayload {
  readonly version: 3;
  readonly nonce: string;
  readonly browserBindingDigest: string;
  readonly returnTo: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export class UstcOAuthError extends Error {
  public constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = "UstcOAuthError";
  }
}

export function ustcOAuthBrowserBindingCookieName(state: string): string {
  const stateDigest = createHash("sha256").update(state, "utf8").digest("base64url");
  return `__Host-urmotiv_ustc_binding_${stateDigest}`;
}

/**
 * USTC 统一身份认证 OAuth2 授权码客户端。与经典 CAS 客户端并行存在：
 * 两者共享同一套一次性状态存储接口，但状态版本、浏览器绑定摘要命名空间和
 * Cookie 前缀各自独立，互不串扰。经典 CAS 仅在显式配置时启用，不会替代 OAuth2。
 */
export class UstcOAuthClient {
  readonly #authorizeUrl: string;
  readonly #tokenUrl: string;
  readonly #profileUrl: string;
  readonly #redirectUri: string;
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #scope: string | undefined;
  readonly #stateSecret: Uint8Array;
  readonly #states: CasLoginStateStore;
  readonly #fetch: UstcOAuthFetch;
  readonly #now: () => Date;

  public constructor(options: {
    configuration: UstcOAuthConfiguration;
    stateSecret: Uint8Array;
    states: CasLoginStateStore;
    fetch?: UstcOAuthFetch;
    now?: () => Date;
  }) {
    const configuration = ustcOAuthConfigurationSchema.parse(options.configuration);
    this.#authorizeUrl = configuration.authorizeUrl;
    this.#tokenUrl = configuration.tokenUrl;
    this.#profileUrl = configuration.profileUrl;
    this.#redirectUri = configuration.redirectUri;
    this.#clientId = configuration.clientId;
    this.#clientSecret = configuration.clientSecret;
    this.#scope = configuration.scope;
    if (options.stateSecret.byteLength < 32) {
      throw new Error("USTC OAuth 登录状态密钥至少需要 32 字节。");
    }
    this.#stateSecret = new Uint8Array(options.stateSecret);
    this.#states = options.states;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date());
  }

  public async startLogin(returnTo = "/"): Promise<UstcOAuthLoginStart> {
    const safeReturnTo = parseReturnPath(returnTo);
    const now = this.#now();
    const expiresAt = new Date(now.getTime() + stateLifetimeMs).toISOString();
    const browserBinding = randomBytes(browserBindingByteLength).toString("base64url");
    const payload: UstcOAuthStatePayload = {
      version: 3,
      nonce: randomBytes(24).toString("base64url"),
      browserBindingDigest: digestBrowserBinding(browserBinding),
      returnTo: safeReturnTo,
      issuedAt: now.toISOString(),
      expiresAt
    };
    const state = signState(payload, this.#stateSecret);
    await this.#states.put(digestNonce(payload.nonce), expiresAt);
    const authorizeUrl = buildAuthorizeUrl(this.#authorizeUrl, this.#clientId, this.#redirectUri, state, this.#scope);
    return {
      authorizeUrl,
      state,
      returnTo: safeReturnTo,
      browserBindingCookie: {
        name: ustcOAuthBrowserBindingCookieName(state),
        value: browserBinding,
        maxAgeSeconds: stateLifetimeSeconds
      }
    };
  }

  public async finishLogin(input: {
    state: string;
    code: string;
    browserBinding: string | undefined;
  }): Promise<{ identity: UstcOAuthIdentity; returnTo: string }> {
    const payload = verifyState(input.state, this.#stateSecret);
    const now = this.#now();
    if (Date.parse(payload.expiresAt) <= now.getTime()) {
      throw new UstcOAuthError("统一身份认证登录状态已过期。", "state_expired");
    }
    if (
      input.browserBinding === undefined ||
      !browserBindingSchema.safeParse(input.browserBinding).success
    ) {
      throw new UstcOAuthError("浏览器绑定 Cookie 缺失或格式不正确。", "binding_missing");
    }
    const expectedBindingDigest = digestBrowserBinding(input.browserBinding);
    if (
      expectedBindingDigest.length !== payload.browserBindingDigest.length ||
      !timingSafeEqual(
        Buffer.from(expectedBindingDigest),
        Buffer.from(payload.browserBindingDigest)
      )
    ) {
      throw new UstcOAuthError("浏览器绑定 Cookie 与登录请求不匹配。", "binding_mismatch");
    }
    const consumed = await this.#states.consume(digestNonce(payload.nonce), now.toISOString());
    if (!consumed) {
      throw new UstcOAuthError("登录状态已使用或失效。", "state_consumed");
    }
    if (typeof input.code !== "string" || input.code.length === 0 || input.code.length > 200) {
      throw new UstcOAuthError("授权码格式不正确。", "bad_code_shape");
    }

    const accessToken = await exchangeCode(
      this.#tokenUrl,
      this.#clientId,
      this.#clientSecret,
      this.#redirectUri,
      input.code,
      this.#fetch
    );
    const profile = await fetchProfile(
      this.#profileUrl,
      accessToken,
      this.#clientId,
      this.#fetch
    );
    const identity = parseOAuthProfile(profile);
    return { identity, returnTo: payload.returnTo };
  }
}

function buildAuthorizeUrl(
  authorizeUrl: string,
  clientId: string,
  redirectUri: string,
  state: string,
  scope: string | undefined
): string {
  const url = new URL(authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  if (scope !== undefined) {
    url.searchParams.set("scope", scope);
  }
  return url.toString();
}

async function exchangeCode(
  tokenUrl: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
  code: string,
  fetchImpl: UstcOAuthFetch
): Promise<string> {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    code
  });
  let response: Response;
  try {
    response = await fetchImpl(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      redirect: "error",
      signal: AbortSignal.timeout(15_000)
    });
  } catch {
    throw new UstcOAuthError("令牌端点请求失败。", "token_network");
  }
  const text = await readBounded(response, tokenResponseCap, "token_exchange");
  if (!response.ok) {
    throw new UstcOAuthError("令牌端点拒绝了授权码。", "token_rejected");
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new UstcOAuthError("令牌响应不是合法 JSON。", "token_bad_json");
  }
  const accessToken =
    json !== null && typeof json === "object" && "access_token" in json
      ? (json as Record<string, unknown>).access_token
      : undefined;
  if (typeof accessToken !== "string" || accessToken.length === 0 || accessToken.length > 4_096) {
    throw new UstcOAuthError("令牌响应缺少有效的 access_token。", "no_access_token");
  }
  return accessToken;
}

async function fetchProfile(
  profileUrl: string,
  accessToken: string,
  clientId: string,
  fetchImpl: UstcOAuthFetch
): Promise<Record<string, unknown>> {
  const params = new URLSearchParams({ access_token: accessToken });
  let response: Response;
  try {
    response = await fetchImpl(profileUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      redirect: "error",
      signal: AbortSignal.timeout(15_000)
    });
  } catch {
    throw new UstcOAuthError("资料端点请求失败。", "profile_network");
  }
  const text = await readBounded(response, profileResponseCap, "profile");
  if (!response.ok) {
    throw new UstcOAuthError("资料端点拒绝了访问令牌。", "profile_rejected");
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new UstcOAuthError("资料响应不是合法 JSON。", "profile_bad_json");
  }
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    throw new UstcOAuthError("资料响应格式不正确。", "profile_bad_shape");
  }
  const record = json as Record<string, unknown>;
  if (record.active !== true || firstString(record.client_id) !== clientId) {
    throw new UstcOAuthError(
      "统一身份认证资料未激活或不属于当前客户端。",
      "profile_inactive_or_wrong_client"
    );
  }
  return record;
}

function parseOAuthProfile(profile: Record<string, unknown>): UstcOAuthIdentity {
  const attributes =
    profile.attributes !== null &&
    typeof profile.attributes === "object" &&
    !Array.isArray(profile.attributes)
      ? (profile.attributes as Record<string, unknown>)
      : {};
  const gid = firstString(attributes.gid);
  const topId = firstString(profile.id);
  const subject = gid ?? topId;
  if (subject === undefined) {
    throw new UstcOAuthError(
      "身份源未发布稳定身份字段（gid/id），无法建档。",
      "missing_stable_id"
    );
  }
  const zjhm = firstString(attributes.zjhm);
  const jrzjhm = firstString(attributes.jrzjhm);
  const name = firstString(attributes.name);
  const email = firstString(attributes.email);
  const studentIds: { attribute: string; value: string }[] = [];
  if (zjhm !== undefined) {
    studentIds.push({ attribute: "zjhm", value: zjhm });
  }
  if (jrzjhm !== undefined && jrzjhm !== zjhm) {
    studentIds.push({ attribute: "jrzjhm", value: jrzjhm });
  }
  return {
    provider: "ustc-oauth",
    subject,
    username: zjhm ?? jrzjhm,
    realName: name,
    email,
    nickname: name ?? "统一身份认证用户",
    studentIds
  };
}

function signState(payload: UstcOAuthStatePayload, secret: Uint8Array): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function verifyState(state: string, secret: Uint8Array): UstcOAuthStatePayload {
  if (state.length > 4_096) {
    throw new UstcOAuthError("统一身份认证登录状态无效。", "invalid_state");
  }
  const [encoded, signature, extra] = state.split(".");
  if (encoded === undefined || signature === undefined || extra !== undefined) {
    throw new UstcOAuthError("统一身份认证登录状态无效。", "invalid_state");
  }
  const expected = createHmac("sha256", secret).update(encoded).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, "base64url");
  } catch {
    throw new UstcOAuthError("统一身份认证登录状态无效。", "invalid_state");
  }
  if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
    throw new UstcOAuthError("统一身份认证登录状态无效。", "invalid_state");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
  } catch {
    throw new UstcOAuthError("统一身份认证登录状态无效。", "invalid_state");
  }
  const schema = z
    .object({
      version: z.literal(3),
      nonce: z.string().min(24).max(200),
      browserBindingDigest: browserBindingSchema,
      returnTo: z.string().max(2_000),
      issuedAt: z.string().datetime(),
      expiresAt: z.string().datetime()
    })
    .strict();
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new UstcOAuthError("统一身份认证登录状态无效。", "invalid_state");
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
    throw new UstcOAuthError("登录后的返回地址不安全。", "invalid_return_path");
  }
  const parsed = new URL(value, "https://urmotiv.invalid");
  if (parsed.origin !== "https://urmotiv.invalid") {
    throw new UstcOAuthError("登录后的返回地址不安全。", "invalid_return_path");
  }
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

function digestNonce(nonce: string): string {
  return createHash("sha256").update(nonce, "utf8").digest("hex");
}

function digestBrowserBinding(browserBinding: string): string {
  return createHash("sha256")
    .update(browserBindingDigestContext, "utf8")
    .update(browserBinding, "utf8")
    .digest("base64url");
}

function firstString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

async function readBounded(
  response: Response,
  limit: number,
  stage: string
): Promise<string> {
  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader !== null && Number(lengthHeader) > limit) {
    throw new UstcOAuthError(`统一身份认证 ${stage} 响应超过大小限制。`, "response_too_large");
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
      throw new UstcOAuthError(`统一身份认证 ${stage} 响应超过大小限制。`, "response_too_large");
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
