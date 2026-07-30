import type { ApiAppOptions } from "./app";
import { casConfigurationSchema, type CasConfiguration } from "@urmotiv/auth";
import {
  validateLocalStorageRoot,
  validateS3StorageConnection,
  type FileStorageFactoryOptions
} from "@urmotiv/storage";

const defaultStorageMaxFileBytes = 128 * 1024 * 1024;
const maximumStorageMaxFileBytes = 512 * 1024 * 1024;

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
  URMOTIV_PGLITE_PATH?: string;
  URMOTIV_WEB_ORIGIN?: string;
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

  return {
    secureCookies: production,
    demoAuthEnabled,
    emailLoginEnabled: environment.URMOTIV_EMAIL_LOGIN_ENABLED !== "false",
    emailRegistrationEnabled: environment.URMOTIV_EMAIL_REGISTRATION_ENABLED === "true",
    ...(allowedOrigins.length === 0 ? {} : { allowedOrigins })
  };
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
  if (environment.URMOTIV_CAS_ENABLED !== "true") {
    return {
      emailLoginEnabled,
      emailRegistrationEnabled,
      ...(verification === undefined ? {} : { emailVerification: verification })
    };
  }
  const secretText = environment.URMOTIV_CAS_STATE_SECRET?.trim() ?? "";
  let stateSecret: Uint8Array;
  try {
    stateSecret = Buffer.from(secretText, "base64url");
  } catch {
    throw new Error("URMOTIV_CAS_STATE_SECRET 必须是 Base64URL 编码的随机密钥。");
  }
  if (stateSecret.byteLength < 32) {
    throw new Error("URMOTIV_CAS_STATE_SECRET 解码后至少需要 32 字节。");
  }
  const studentIdAttributes = (environment.URMOTIV_CAS_STUDENT_ID_ATTRIBUTES ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const configuration = casConfigurationSchema.parse({
    loginUrl: environment.URMOTIV_CAS_LOGIN_URL,
    validateUrl: environment.URMOTIV_CAS_VALIDATE_URL,
    callbackUrl: environment.URMOTIV_CAS_CALLBACK_URL,
    subjectAttribute: environment.URMOTIV_CAS_SUBJECT_ATTRIBUTE,
    ...(environment.URMOTIV_CAS_EMAIL_ATTRIBUTE?.trim()
      ? { emailAttribute: environment.URMOTIV_CAS_EMAIL_ATTRIBUTE.trim() }
      : {}),
    ...(environment.URMOTIV_CAS_NICKNAME_ATTRIBUTE?.trim()
      ? { nicknameAttribute: environment.URMOTIV_CAS_NICKNAME_ATTRIBUTE.trim() }
      : {}),
    ...(studentIdAttributes.length > 0 ? { studentIdAttributes } : {})
  });
  return {
    emailLoginEnabled,
    emailRegistrationEnabled,
    ...(verification === undefined ? {} : { emailVerification: verification }),
    cas: { configuration, stateSecret }
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
