import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { z } from "zod";
import type { CasLoginStateStore } from "./cas";

const stateLifetimeMs = 10 * 60_000;
const stateLifetimeSeconds = stateLifetimeMs / 1_000;
const browserBindingByteLength = 32;
const browserBindingDigestContext = "urmotiv:ustc-oauth:browser-binding:v1\0";
const browserBindingSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const tokenResponseCap = 8_192;
const profileResponseCap = 16_384;

export const ustcOAuthCallbackPath = "/api/v1/auth/ustc/callback" as const;
export const ustcOAuthEndpointContract = {
  authority: "id.ustc.edu.cn",
  authorizePath: "/cas/oauth2.0/authorize",
  tokenPath: "/cas/oauth2.0/accessToken",
  profilePath: "/cas/oauth2.0/profile"
} as const;
type UstcOAuthEndpointPath =
  | typeof ustcOAuthEndpointContract.authorizePath
  | typeof ustcOAuthEndpointContract.tokenPath
  | typeof ustcOAuthEndpointContract.profilePath;

export function isApprovedUstcOAuthEndpoint(value: string, path: UstcOAuthEndpointPath): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === ustcOAuthEndpointContract.authority &&
      url.port === "" &&
      url.pathname === path &&
      url.search === "" &&
      url.hash === "" &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

function approvedEndpointSchema(path: UstcOAuthEndpointPath) {
  return z.string().url().refine(
    (value) => isApprovedUstcOAuthEndpoint(value, path),
    "USTC OAuth 地址必须精确使用已批准的 HTTPS authority/path。"
  );
}

const loopbackRedirectHostnames = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isLoopbackHttpRedirect(url: URL): boolean {
  return url.protocol === "http:" && loopbackRedirectHostnames.has(url.hostname);
}

const redirectUriSchema = z.string().url().refine((value) => {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || isLoopbackHttpRedirect(url)) &&
      url.pathname === ustcOAuthCallbackPath &&
      url.search === "" &&
      url.hash === "" &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}, "回调地址必须使用 HTTPS（回环地址可显式使用 HTTP）且精确指向 /api/v1/auth/ustc/callback，不能带查询参数或片段。");

/**
 * USTC 统一身份认证 OAuth2 客户端配置。客户端密钥只在服务器进程内存中使用，
 * 用于向令牌端点换取访问令牌；它永远不会出现在接口响应、日志或审计记录里。
 */
export const ustcOAuthConfigurationSchema = z
  .object({
    authorizeUrl: approvedEndpointSchema(ustcOAuthEndpointContract.authorizePath),
    tokenUrl: approvedEndpointSchema(ustcOAuthEndpointContract.tokenPath),
    profileUrl: approvedEndpointSchema(ustcOAuthEndpointContract.profilePath),
    redirectUri: redirectUriSchema,
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
export type UstcOAuthHostResolver = (hostname: string) => Promise<readonly string[]>;

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

export function ustcOAuthBrowserBindingCookieName(state: string, secure = true): string {
  const stateDigest = createHash("sha256").update(state, "utf8").digest("base64url");
  return `${secure ? "__Host-" : ""}urmotiv_ustc_binding_${stateDigest}`;
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
  readonly #customFetch: boolean;
  readonly #resolveHostAddresses: UstcOAuthHostResolver;
  readonly #now: () => Date;

  public constructor(options: {
    configuration: UstcOAuthConfiguration;
    stateSecret: Uint8Array;
    states: CasLoginStateStore;
    fetch?: UstcOAuthFetch;
    resolveHostAddresses?: UstcOAuthHostResolver;
    now?: () => Date;
    /**
     * HTTP redirects are permitted only for exact loopback origins when the
     * caller has explicitly enabled the existing loopback-cookie safety mode.
     */
    allowLoopbackInsecureRedirect?: boolean;
  }) {
    const configuration = ustcOAuthConfigurationSchema.parse(options.configuration);
    const redirectUri = new URL(configuration.redirectUri);
    if (isLoopbackHttpRedirect(redirectUri) && options.allowLoopbackInsecureRedirect !== true) {
      throw new Error("HTTP OAuth 回调地址必须显式开启回环安全模式。");
    }
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
    this.#customFetch = options.fetch !== undefined;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#resolveHostAddresses = options.resolveHostAddresses ?? resolveHostAddresses;
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
        name: ustcOAuthBrowserBindingCookieName(state, true),
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
      (url, init) => this.fetchProvider(url, init)
    );
    const profile = await fetchProfile(
      this.#profileUrl,
      accessToken,
      this.#clientId,
      (url, init) => this.fetchProvider(url, init)
    );
    const identity = parseOAuthProfile(profile);
    return { identity, returnTo: payload.returnTo };
  }

  private async fetchProvider(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    let addresses: readonly string[];
    try {
      addresses = await this.#resolveHostAddresses(url.hostname);
    } catch {
      throw new UstcOAuthError("统一身份认证地址解析失败。", "provider_dns_blocked");
    }
    if (addresses.length === 0 || addresses.some(isBlockedNetworkAddress)) {
      throw new UstcOAuthError("统一身份认证地址解析到不允许的网络。", "provider_dns_blocked");
    }
    if (this.#customFetch) {
      return this.#fetch(input, init);
    }
    return pinnedHttpsFetch(url, addresses[0]!, init);
  }
}

async function resolveHostAddresses(hostname: string): Promise<readonly string[]> {
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

function isBlockedNetworkAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return isBlockedIPv4(address);
  }
  if (family === 6) {
    return isBlockedIPv6(address);
  }
  return true;
}

function isBlockedIPv4(address: string): boolean {
  const octets = address.split(".").map((part) => Number(part));
  if (
    octets.length !== 4 ||
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true;
  }
  const value = octets.reduce((result, part) => result * 256 + part, 0);
  const ranges: ReadonlyArray<readonly [number, number]> = [
    [0, 8],
    [0x0a000000, 8],
    [0x64400000, 10],
    [0x7f000000, 8],
    [0xa9fe0000, 16],
    [0xac100000, 12],
    [0xc0000000, 24],
    [0xc0000200, 24],
    [0xc0a80000, 16],
    [0xc6120000, 15],
    [0xc6336400, 24],
    [0xcb007100, 24],
    [0xe0000000, 4],
    [0xf0000000, 4]
  ];
  return ranges.some(([network, prefix]) => ipv4InRange(value, network, prefix));
}

function ipv4InRange(value: number, network: number, prefix: number): boolean {
  if (prefix === 0) return true;
  const mask = prefix === 32 ? 0xffffffff : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === ((network as number) & mask);
}

function isBlockedIPv6(address: string): boolean {
  const value = parseIPv6(address);
  if (value === undefined) return true;
  const mappedPrefix = parseIPv6("::ffff:0:0");
  if (mappedPrefix !== undefined && (value >> 32n) === (mappedPrefix >> 32n)) {
    return isBlockedIPv4(String([
      Number((value >> 24n) & 0xffn),
      Number((value >> 16n) & 0xffn),
      Number((value >> 8n) & 0xffn),
      Number(value & 0xffn)
    ].join(".")));
  }
  const ranges: ReadonlyArray<readonly [string, number]> = [
    ["::", 128],
    ["::1", 128],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8],
    ["2001:db8::", 32]
  ];
  return ranges.some(([network, prefix]) => {
    const parsedNetwork = parseIPv6(network);
    return parsedNetwork !== undefined && ipv6InRange(value, parsedNetwork, prefix);
  });
}

function parseIPv6(address: string): bigint | undefined {
  const normalized = address.toLowerCase().split("%", 1)[0]!;
  if (normalized.length === 0) return undefined;
  const sections = normalized.split("::");
  if (sections.length > 2) return undefined;
  const parseSection = (section: string): number[] => {
    if (section.length === 0) return [];
    const parts = section.split(":");
    const result: number[] = [];
    for (const part of parts) {
      if (part.includes(".")) {
        const octets = part.split(".").map((value) => Number(value));
        if (
          octets.length !== 4 ||
          octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
        ) {
          return [];
        }
        result.push((octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!);
      } else {
        if (!/^[0-9a-f]{1,4}$/u.test(part)) return [];
        result.push(Number.parseInt(part, 16));
      }
    }
    return result;
  };
  const left = parseSection(sections[0]!);
  const right = sections.length === 2 ? parseSection(sections[1]!) : [];
  if (left.length + right.length > 8 || (sections.length === 1 && left.length !== 8)) {
    return undefined;
  }
  const groups = sections.length === 2
    ? [...left, ...Array.from({ length: 8 - left.length - right.length }, () => 0), ...right]
    : left;
  if (groups.length !== 8) return undefined;
  return groups.reduce((result, group) => (result << 16n) | BigInt(group), 0n);
}

function ipv6InRange(value: bigint, network: bigint, prefix: number): boolean {
  if (prefix === 0) return true;
  const mask = ((1n << 128n) - 1n) ^ ((1n << BigInt(128 - prefix)) - 1n);
  return (value & mask) === (network & mask);
}

async function pinnedHttpsFetch(
  url: URL,
  address: string,
  init?: RequestInit
): Promise<Response> {
  const body = init?.body === undefined
    ? undefined
    : Buffer.from(await new Response(init.body).arrayBuffer());
  const headers = new Headers(init?.headers);
  headers.set("host", url.host);
  const requestHeaders: Record<string, string> = {};
  headers.forEach((value, key) => {
    requestHeaders[key] = value;
  });
  return new Promise<Response>((resolve, reject) => {
    const request = httpsRequest(
      {
        hostname: address,
        port: url.port === "" ? 443 : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: init?.method ?? "GET",
        headers: requestHeaders,
        servername: url.hostname,
        rejectUnauthorized: true
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.byteLength;
          if (size > 1_048_576) {
            request.destroy(new Error("response too large"));
            return;
          }
          chunks.push(bytes);
        });
        response.on("end", () => {
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(response.headers)) {
            if (value !== undefined) {
              responseHeaders.set(key, Array.isArray(value) ? value.join(", ") : value);
            }
          }
          resolve(new Response(Buffer.concat(chunks), {
            status: response.statusCode ?? 502,
            headers: responseHeaders
          }));
        });
      }
    );
    request.once("error", reject);
    const signal = init?.signal;
    const abort = () => request.destroy(new Error("request aborted"));
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    request.once("close", () => signal?.removeEventListener("abort", abort));
    if (body !== undefined) request.write(body);
    request.end();
  });
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
  } catch (error) {
    if (error instanceof UstcOAuthError) throw error;
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
  } catch (error) {
    if (error instanceof UstcOAuthError) throw error;
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
