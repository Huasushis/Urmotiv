import type { ApiAppOptions } from "./app";
import {
  casConfigurationSchema,
  ustcOAuthConfigurationSchema,
  type CasConfiguration,
  type UstcOAuthConfiguration
} from "@urmotiv/auth";
import { normalizeIpCidr } from "@urmotiv/contracts";
import {
  validateLocalStorageRoot,
  validateS3StorageConnection,
  type FileStorageFactoryOptions
} from "@urmotiv/storage";

const defaultStorageMaxFileBytes = 128 * 1024 * 1024;
const maximumStorageMaxFileBytes = 512 * 1024 * 1024;
const maximumTrustedProxyCidrs = 32;
const trustedProxyConfigurationError =
  "URMOTIV_TRUSTED_PROXY_CIDRS 必须是最多 32 项、逗号分隔且不含全网范围的 IPv4 或 IPv6 CIDR。";
const casConfigurationError = "URMOTIV_CAS_CONFIGURATION_INVALID";
const casStateSecretPattern = /^[A-Za-z0-9_-]{43}$/;
const ustcOAuthConfigurationError = "URMOTIV_USTC_OAUTH_CONFIGURATION_INVALID";
const loopbackCookieConfigurationError =
  "URMOTIV_ALLOW_LOOPBACK_INSECURE_COOKIES_CONFIGURATION_INVALID";
const loopbackHosts: Record<string, true> = {
  localhost: true,
  "127.0.0.1": true,
  "[::1]": true
};

export interface ServerEnvironment {
  readonly [name: string]: string | undefined;
  DATABASE_URL?: string;
  NODE_ENV?: string;
  URMOTIV_DATABASE_MIGRATE?: string;
  URMOTIV_DEMO_AUTH?: string;
  URMOTIV_DEMO_SEED?: string;
  URMOTIV_EMAIL_LOGIN_ENABLED?: string;
  URMOTIV_EMAIL_REGISTRATION_ENABLED?: string;
  URMOTIV_EMAIL_DELIVERY_MODE?: string;
  URMOTIV_EMAIL_VERIFICATION_WEB_URL?: string;
  URMOTIV_CAS_ENABLED?: string;
  URMOTIV_CAS_LOGIN_URL?: string;
  URMOTIV_CAS_VALIDATE_URL?: string;
  URMOTIV_CAS_CALLBACK_URL?: string;
  URMOTIV_CAS_SUBJECT_ATTRIBUTE?: string;
  URMOTIV_CAS_EMAIL_ATTRIBUTE?: string;
  URMOTIV_CAS_NICKNAME_ATTRIBUTE?: string;
  URMOTIV_CAS_STUDENT_ID_ATTRIBUTES?: string;
  URMOTIV_CAS_STATE_SECRET?: string;
  URMOTIV_USTC_OAUTH_ENABLED?: string;
  URMOTIV_USTC_OAUTH_AUTHORIZE_URL?: string;
  URMOTIV_USTC_OAUTH_TOKEN_URL?: string;
  URMOTIV_USTC_OAUTH_PROFILE_URL?: string;
  URMOTIV_USTC_OAUTH_REDIRECT_URI?: string;
  URMOTIV_USTC_OAUTH_CLIENT_ID?: string;
  URMOTIV_USTC_OAUTH_CLIENT_SECRET?: string;
  URMOTIV_USTC_OAUTH_STATE_SECRET?: string;
  URMOTIV_USTC_OAUTH_SCOPE?: string;
  URMOTIV_PLUGIN_SECRET_KEY?: string;
  URMOTIV_PGLITE_PATH?: string;
  URMOTIV_TRUSTED_PROXY_CIDRS?: string;
  URMOTIV_WEB_ORIGIN?: string;
  URMOTIV_ALLOW_LOOPBACK_INSECURE_COOKIES?: string;
  STORAGE_LOCAL_ROOT?: string;
  STORAGE_MAX_FILE_BYTES?: string;
  S3_ENDPOINT?: string;
  S3_REGION?: string;
  S3_BUCKET?: string;
  S3_ACCESS_KEY?: string;
  S3_SECRET_KEY?: string;
  S3_FORCE_PATH_STYLE?: string;
}

export type ServerDatabaseOptions =
  | {
      kind: "postgres";
      connectionString: string;
      migrate: boolean;
      seedDemoData: boolean;
    }
  | {
      kind: "pglite";
      dataDirectory: string;
      migrate: true;
      seedDemoData: boolean;
    };

export type ServerStorageOptions = FileStorageFactoryOptions;

export interface ServerAuthenticationOptions {
  readonly emailLoginEnabled: boolean;
  readonly emailRegistrationEnabled: boolean;
  readonly emailVerification?: {
    readonly mode: "test";
    readonly webUrl: string;
  };
  readonly cas?: {
    readonly configuration: CasConfiguration;
    readonly stateSecret: Uint8Array;
  };
  readonly ustcOAuth?: {
    readonly configuration: UstcOAuthConfiguration;
    readonly stateSecret: Uint8Array;
  };
  readonly ustcOAuthStateSecret?: Uint8Array;
}

export function readServerOptions(environment: ServerEnvironment): ApiAppOptions {
  const demoAuthEnabled = environment.URMOTIV_DEMO_AUTH === "true";
  const production = environment.NODE_ENV === "production";
  if (production && demoAuthEnabled) {
    throw new Error("生产环境不能启用演示登录。");
  }

  const allowedOrigins = (environment.URMOTIV_WEB_ORIGIN ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  if (production && allowedOrigins.length === 0) {
    throw new Error("生产环境必须配置 URMOTIV_WEB_ORIGIN。");
  }
  const parsedOrigins = parseWebOrigins(allowedOrigins);
  const allowLoopbackInsecureCookies = readLoopbackCookieOptIn(
    environment.URMOTIV_ALLOW_LOOPBACK_INSECURE_COOKIES
  );
  if (
    parsedOrigins.some(
      (origin) => origin.protocol === "http:" && loopbackHosts[origin.hostname] !== true
    )
  ) {
    throw new Error(loopbackCookieConfigurationError);
  }
  if (
    allowLoopbackInsecureCookies
    && (
      parsedOrigins.length === 0
      || parsedOrigins.some((origin) => loopbackHosts[origin.hostname] !== true)
    )
  ) {
    throw new Error(loopbackCookieConfigurationError);
  }
  const insecureLoopbackCookies =
    allowLoopbackInsecureCookies
    && parsedOrigins.length > 0
    && parsedOrigins.every(
      (origin) => origin.protocol === "http:" && loopbackHosts[origin.hostname] === true
    );
  const trustedProxyCidrs = readTrustedProxyCidrs(environment.URMOTIV_TRUSTED_PROXY_CIDRS);

  return {
    secureCookies: production && !insecureLoopbackCookies,
    allowLoopbackInsecureCookies: insecureLoopbackCookies,
    ...(demoAuthEnabled ? { demoAuthEnabled } : {}),
    emailLoginEnabled: environment.URMOTIV_EMAIL_LOGIN_ENABLED !== "false",
    emailRegistrationEnabled: environment.URMOTIV_EMAIL_REGISTRATION_ENABLED === "true",
    ...(allowedOrigins.length === 0 ? {} : { allowedOrigins }),
    ...(trustedProxyCidrs.length === 0 ? {} : { trustedProxyCidrs })
  };
}

interface ParsedWebOrigin {
  readonly protocol: "http:" | "https:";
  readonly hostname: string;
}

function parseWebOrigins(origins: readonly string[]): ParsedWebOrigin[] {
  const parsedOrigins: ParsedWebOrigin[] = [];
  for (const origin of origins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(loopbackCookieConfigurationError);
    }
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      || parsed.username.length > 0
      || parsed.password.length > 0
      || (parsed.pathname !== "" && parsed.pathname !== "/")
      || parsed.search.length > 0
      || parsed.hash.length > 0
    ) {
      throw new Error(loopbackCookieConfigurationError);
    }
    parsedOrigins.push({ protocol: parsed.protocol, hostname: parsed.hostname });
  }
  return parsedOrigins;
}

function readLoopbackCookieOptIn(value: string | undefined): boolean {
  if (value === undefined || value === "" || value === "false") {
    return false;
  }
  if (value === "true") {
    return true;
  }
  throw new Error(loopbackCookieConfigurationError);
}

export function readTrustedProxyCidrs(value: string | undefined): string[] {
  if (value === undefined || value.trim().length === 0) return [];
  const entries = value.split(",");
  if (entries.length > maximumTrustedProxyCidrs) {
    throw new Error(trustedProxyConfigurationError);
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const cidr = normalizeIpCidr(entry.trim());
    if (
      cidr === undefined ||
      cidr === "0.0.0.0/0" ||
      cidr === "::/0" ||
      seen.has(cidr)
    ) {
      throw new Error(trustedProxyConfigurationError);
    }
    seen.add(cidr);
    normalized.push(cidr);
  }
  return normalized;
}

export function readServerAuthenticationOptions(
  environment: ServerEnvironment
): ServerAuthenticationOptions {
  const emailLoginEnabled = environment.URMOTIV_EMAIL_LOGIN_ENABLED !== "false";
  const emailRegistrationEnabled = environment.URMOTIV_EMAIL_REGISTRATION_ENABLED === "true";
  if (emailRegistrationEnabled && !emailLoginEnabled) {
    throw new Error("开启邮箱注册前必须开启邮箱登录。");
  }
  const verification = readEmailVerificationOptions(environment, emailRegistrationEnabled);
  const ustcOAuthStateSecret = readUstcOAuthStateSecret(
    environment,
    environment.URMOTIV_USTC_OAUTH_ENABLED === "true"
  );
  const ustcOAuth = readUstcOAuthOptions(environment);
  const casEnabled = environment.URMOTIV_CAS_ENABLED;
  if (casEnabled === undefined || casEnabled === "false") {
    return {
      emailLoginEnabled,
      emailRegistrationEnabled,
      ...(verification === undefined ? {} : { emailVerification: verification }),
      ...(ustcOAuth === undefined ? {} : { ustcOAuth }),
      ...(ustcOAuthStateSecret === undefined ? {} : { ustcOAuthStateSecret })
    };
  }
  if (casEnabled !== "true") {
    throw new Error(casConfigurationError);
  }

  const secretText = environment.URMOTIV_CAS_STATE_SECRET ?? "";
  if (
    !casStateSecretPattern.test(secretText) ||
    secretText === environment.URMOTIV_PLUGIN_SECRET_KEY
  ) {
    throw new Error(casConfigurationError);
  }
  const decodedStateSecret = Buffer.from(secretText, "base64url");
  if (
    decodedStateSecret.byteLength !== 32 ||
    decodedStateSecret.toString("base64url") !== secretText
  ) {
    throw new Error(casConfigurationError);
  }
  const stateSecret = new Uint8Array(decodedStateSecret);

  const textualConfigurationValues = [
    environment.URMOTIV_CAS_LOGIN_URL,
    environment.URMOTIV_CAS_VALIDATE_URL,
    environment.URMOTIV_CAS_CALLBACK_URL,
    environment.URMOTIV_CAS_SUBJECT_ATTRIBUTE,
    environment.URMOTIV_CAS_EMAIL_ATTRIBUTE,
    environment.URMOTIV_CAS_NICKNAME_ATTRIBUTE,
    environment.URMOTIV_CAS_STUDENT_ID_ATTRIBUTES
  ];
  if (textualConfigurationValues.some((value) => value !== undefined && value !== value.trim())) {
    throw new Error(casConfigurationError);
  }
  const studentIdAttributeText = environment.URMOTIV_CAS_STUDENT_ID_ATTRIBUTES ?? "";
  const studentIdAttributes =
    studentIdAttributeText === "" ? [] : studentIdAttributeText.split(",");
  let configuration: CasConfiguration;
  try {
    configuration = casConfigurationSchema.parse({
      loginUrl: environment.URMOTIV_CAS_LOGIN_URL,
      validateUrl: environment.URMOTIV_CAS_VALIDATE_URL,
      callbackUrl: environment.URMOTIV_CAS_CALLBACK_URL,
      subjectAttribute: environment.URMOTIV_CAS_SUBJECT_ATTRIBUTE,
      ...(environment.URMOTIV_CAS_EMAIL_ATTRIBUTE
        ? { emailAttribute: environment.URMOTIV_CAS_EMAIL_ATTRIBUTE }
        : {}),
      ...(environment.URMOTIV_CAS_NICKNAME_ATTRIBUTE
        ? { nicknameAttribute: environment.URMOTIV_CAS_NICKNAME_ATTRIBUTE }
        : {}),
      ...(studentIdAttributes.length > 0 ? { studentIdAttributes } : {})
    });
  } catch {
    throw new Error(casConfigurationError);
  }
  if (
    environment.NODE_ENV === "production" &&
    [configuration.loginUrl, configuration.validateUrl, configuration.callbackUrl]
      .some((value) => new URL(value).protocol !== "https:")
  ) {
    throw new Error(casConfigurationError);
  }
  const callbackUrl = new URL(configuration.callbackUrl);
  if (
    callbackUrl.pathname !== "/api/v1/auth/cas/callback" ||
    callbackUrl.search.length > 0 ||
    callbackUrl.hash.length > 0
  ) {
    throw new Error(casConfigurationError);
  }
  if (environment.NODE_ENV === "production") {
    const webOriginText = environment.URMOTIV_WEB_ORIGIN ?? "";
    let webOrigin: URL;
    try {
      if (webOriginText !== webOriginText.trim() || webOriginText.includes(",")) {
        throw new Error("invalid web origin");
      }
      webOrigin = new URL(webOriginText);
    } catch {
      throw new Error(casConfigurationError);
    }
    if (
      webOrigin.protocol !== "https:" ||
      webOrigin.username.length > 0 ||
      webOrigin.password.length > 0 ||
      (webOrigin.pathname !== "" && webOrigin.pathname !== "/") ||
      webOrigin.search.length > 0 ||
      webOrigin.hash.length > 0 ||
      callbackUrl.origin !== webOrigin.origin
    ) {
      throw new Error(casConfigurationError);
    }
  }
  return {
    emailLoginEnabled,
    emailRegistrationEnabled,
    ...(verification === undefined ? {} : { emailVerification: verification }),
    ...(ustcOAuth === undefined ? {} : { ustcOAuth }),
    ...(ustcOAuthStateSecret === undefined ? {} : { ustcOAuthStateSecret }),
    cas: { configuration, stateSecret }
  };
}

function readUstcOAuthStateSecret(
  environment: ServerEnvironment,
  required: boolean
): Uint8Array | undefined {
  const secretText = environment.URMOTIV_USTC_OAUTH_STATE_SECRET;
  if (!required && (secretText === undefined || secretText === "")) return undefined;
  const value = secretText ?? "";
  if (
    value !== value.trim() ||
    !casStateSecretPattern.test(value) ||
    value === environment.URMOTIV_PLUGIN_SECRET_KEY ||
    value === environment.URMOTIV_CAS_STATE_SECRET
  ) {
    throw new Error(ustcOAuthConfigurationError);
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== 32 || decoded.toString("base64url") !== value) {
    throw new Error(ustcOAuthConfigurationError);
  }
  return new Uint8Array(decoded);
}

function readUstcOAuthOptions(
  environment: ServerEnvironment
): ServerAuthenticationOptions["ustcOAuth"] {
  const enabled = environment.URMOTIV_USTC_OAUTH_ENABLED;
  if (enabled === undefined || enabled === "false") {
    return undefined;
  }
  if (enabled !== "true") {
    throw new Error(ustcOAuthConfigurationError);
  }
  const decodedStateSecret = readUstcOAuthStateSecret(environment, true);
  if (decodedStateSecret === undefined) {
    throw new Error(ustcOAuthConfigurationError);
  }
  const secretText = environment.URMOTIV_USTC_OAUTH_STATE_SECRET ?? "";
  const textualValues = [
    environment.URMOTIV_USTC_OAUTH_AUTHORIZE_URL,
    environment.URMOTIV_USTC_OAUTH_TOKEN_URL,
    environment.URMOTIV_USTC_OAUTH_PROFILE_URL,
    environment.URMOTIV_USTC_OAUTH_REDIRECT_URI,
    environment.URMOTIV_USTC_OAUTH_CLIENT_ID,
    environment.URMOTIV_USTC_OAUTH_CLIENT_SECRET,
    environment.URMOTIV_USTC_OAUTH_SCOPE
  ];
  if (textualValues.some((value) => value !== undefined && value !== value.trim())) {
    throw new Error(ustcOAuthConfigurationError);
  }
  let configuration: UstcOAuthConfiguration;
  try {
    configuration = ustcOAuthConfigurationSchema.parse({
      authorizeUrl: environment.URMOTIV_USTC_OAUTH_AUTHORIZE_URL,
      tokenUrl: environment.URMOTIV_USTC_OAUTH_TOKEN_URL,
      profileUrl: environment.URMOTIV_USTC_OAUTH_PROFILE_URL,
      redirectUri: environment.URMOTIV_USTC_OAUTH_REDIRECT_URI,
      clientId: environment.URMOTIV_USTC_OAUTH_CLIENT_ID,
      clientSecret: environment.URMOTIV_USTC_OAUTH_CLIENT_SECRET,
      ...(environment.URMOTIV_USTC_OAUTH_SCOPE
        ? { scope: environment.URMOTIV_USTC_OAUTH_SCOPE }
        : {})
    });
  } catch {
    throw new Error(ustcOAuthConfigurationError);
  }
  if (configuration.clientSecret === secretText) {
    throw new Error(ustcOAuthConfigurationError);
  }
  const redirectUrl = new URL(configuration.redirectUri);
  if (
    environment.NODE_ENV === "production" &&
    [
      configuration.authorizeUrl,
      configuration.tokenUrl,
      configuration.profileUrl,
      configuration.redirectUri
    ].some((value) => new URL(value).protocol !== "https:")
  ) {
    throw new Error(ustcOAuthConfigurationError);
  }
  if (environment.NODE_ENV === "production") {
    const webOriginText = environment.URMOTIV_WEB_ORIGIN ?? "";
    let webOrigin: URL;
    try {
      if (webOriginText !== webOriginText.trim() || webOriginText.includes(",")) {
        throw new Error("invalid web origin");
      }
      webOrigin = new URL(webOriginText);
    } catch {
      throw new Error(ustcOAuthConfigurationError);
    }
    if (
      webOrigin.protocol !== "https:" ||
      webOrigin.username.length > 0 ||
      webOrigin.password.length > 0 ||
      (webOrigin.pathname !== "" && webOrigin.pathname !== "/") ||
      webOrigin.search.length > 0 ||
      webOrigin.hash.length > 0 ||
      redirectUrl.origin !== webOrigin.origin
    ) {
      throw new Error(ustcOAuthConfigurationError);
    }
  }
  return {
    configuration,
    stateSecret: new Uint8Array(decodedStateSecret)
  };
}

function readEmailVerificationOptions(
  environment: ServerEnvironment,
  emailRegistrationEnabled: boolean
): ServerAuthenticationOptions["emailVerification"] {
  if (!emailRegistrationEnabled) {
    return undefined;
  }
  if (environment.NODE_ENV !== "test" || environment.URMOTIV_EMAIL_DELIVERY_MODE !== "test") {
    throw new Error(
      "邮箱注册只能在测试环境使用内存投递；生产环境必须先接入并审查真实邮件投递服务。"
    );
  }
  const webUrl = environment.URMOTIV_EMAIL_VERIFICATION_WEB_URL?.trim() ?? "";
  try {
    const parsed = new URL(webUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error();
    }
  } catch {
    throw new Error("测试邮箱验证必须配置有效的 URMOTIV_EMAIL_VERIFICATION_WEB_URL。");
  }
  return { mode: "test", webUrl };
}

export function readServerDatabaseOptions(
  environment: ServerEnvironment
): ServerDatabaseOptions {
  const production = environment.NODE_ENV === "production";
  const connectionString = environment.DATABASE_URL?.trim() ?? "";
  const configuredPglitePath = environment.URMOTIV_PGLITE_PATH?.trim() ?? "";
  const demoAuthEnabled = environment.URMOTIV_DEMO_AUTH === "true";
  const seedDemoData = environment.URMOTIV_DEMO_SEED === "true";

  if (seedDemoData && !demoAuthEnabled) {
    throw new Error("初始化演示数据前必须显式开启 URMOTIV_DEMO_AUTH。");
  }
  if (connectionString.length > 0 && configuredPglitePath.length > 0) {
    throw new Error("DATABASE_URL 与 URMOTIV_PGLITE_PATH 只能配置一个。");
  }
  if (production && connectionString.length === 0) {
    throw new Error("生产环境必须配置 DATABASE_URL，不能使用本地文件数据库。");
  }
  if (production && environment.URMOTIV_DATABASE_MIGRATE === "true") {
    throw new Error("URMOTIV_PRODUCTION_API_MIGRATION_FORBIDDEN");
  }

  if (connectionString.length > 0) {
    return {
      kind: "postgres",
      connectionString,
      migrate: environment.URMOTIV_DATABASE_MIGRATE === "true",
      seedDemoData
    };
  }

  return {
    kind: "pglite",
    dataDirectory: configuredPglitePath || ".data/database",
    migrate: true,
    seedDemoData
  };
}

/**
 * Development and automated tests keep files under a private local directory.
 * A production process always builds an S3-backed store and refuses to start
 * when any required S3 setting is missing or malformed.
 */
export function readServerStorageOptions(
  environment: ServerEnvironment
): ServerStorageOptions {
  const maxBytes = readStorageMaxFileBytes(environment.STORAGE_MAX_FILE_BYTES);
  const production = environment.NODE_ENV === "production";

  if (!production) {
    const configuredRoot = environment.STORAGE_LOCAL_ROOT?.trim();
    return {
      kind: "local",
      rootDirectory: validateLocalStorageRoot(configuredRoot || ".data/storage"),
      limits: { maxBytes }
    };
  }

  if ((environment.STORAGE_LOCAL_ROOT?.trim().length ?? 0) > 0) {
    throw new Error("生产环境不能使用 STORAGE_LOCAL_ROOT，必须使用私有 S3 存储。");
  }

  const connection = validateS3StorageConnection({
    endpoint: requireProductionStorageValue(environment, "S3_ENDPOINT"),
    region: requireProductionStorageValue(environment, "S3_REGION"),
    bucket: requireProductionStorageValue(environment, "S3_BUCKET"),
    accessKeyId: requireProductionStorageValue(environment, "S3_ACCESS_KEY"),
    secretAccessKey: requireProductionStorageValue(environment, "S3_SECRET_KEY"),
    forcePathStyle: readS3ForcePathStyle(environment.S3_FORCE_PATH_STYLE)
  });

  return {
    kind: "s3",
    ...connection,
    limits: { maxBytes }
  };
}

function readStorageMaxFileBytes(value: string | undefined): number {
  if (value === undefined || value.length === 0) {
    return defaultStorageMaxFileBytes;
  }
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(
      `STORAGE_MAX_FILE_BYTES 必须是 1 到 ${maximumStorageMaxFileBytes} 之间的整数。`
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximumStorageMaxFileBytes) {
    throw new Error(
      `STORAGE_MAX_FILE_BYTES 必须是 1 到 ${maximumStorageMaxFileBytes} 之间的整数。`
    );
  }
  return parsed;
}

function requireProductionStorageValue(
  environment: ServerEnvironment,
  fieldName:
    | "S3_ENDPOINT"
    | "S3_REGION"
    | "S3_BUCKET"
    | "S3_ACCESS_KEY"
    | "S3_SECRET_KEY"
): string {
  const value = environment[fieldName];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`生产环境必须配置私有 S3 的 ${fieldName}。`);
  }
  return value;
}

function readS3ForcePathStyle(value: string | undefined): boolean {
  if (value === undefined || value.length === 0) {
    return false;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error("S3_FORCE_PATH_STYLE 必须是 true 或 false。");
}
