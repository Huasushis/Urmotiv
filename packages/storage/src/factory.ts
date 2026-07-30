import { S3Client } from "@aws-sdk/client-s3";
import { LocalFileStorage } from "./local";
import { S3FileStorage } from "./s3";
import type { FileStorage, StorageLimits } from "./types";

export interface LocalStorageFactoryOptions {
  readonly kind: "local";
  readonly rootDirectory: string;
  readonly limits: StorageLimits;
}

export interface S3StorageFactoryOptions {
  readonly kind: "s3";
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly forcePathStyle: boolean;
  readonly limits: StorageLimits;
}

export type FileStorageFactoryOptions =
  | LocalStorageFactoryOptions
  | S3StorageFactoryOptions;

export interface S3StorageConnectionOptions {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly forcePathStyle: boolean;
}

/**
 * This error intentionally mentions only a configuration field name. It never
 * includes an endpoint credential or object-storage response.
 */
export class StorageConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "StorageConfigurationError";
  }
}

/**
 * Checks the S3 values before creating the SDK client. The returned endpoint
 * has no embedded credentials, query, or fragment, so it is safe to keep in
 * process configuration without later treating it as a browser download URL.
 */
export function validateS3StorageConnection(
  options: S3StorageConnectionOptions
): S3StorageConnectionOptions {
  const endpoint = validateEndpoint(options.endpoint);
  const region = validateRegion(options.region);
  const bucket = validateBucket(options.bucket);
  const accessKeyId = validateCredential(options.accessKeyId, "S3_ACCESS_KEY");
  const secretAccessKey = validateCredential(options.secretAccessKey, "S3_SECRET_KEY");
  if (typeof options.forcePathStyle !== "boolean") {
    throw new StorageConfigurationError("S3_FORCE_PATH_STYLE 必须是 true 或 false。");
  }

  return {
    endpoint,
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
    forcePathStyle: options.forcePathStyle
  };
}

export function createFileStorage(options: FileStorageFactoryOptions): FileStorage {
  if (options.kind === "local") {
    return new LocalFileStorage({
      rootDirectory: validateLocalStorageRoot(options.rootDirectory),
      limits: options.limits
    });
  }

  const connection = validateS3StorageConnection(options);
  const client = new S3Client({
    endpoint: connection.endpoint,
    region: connection.region,
    forcePathStyle: connection.forcePathStyle,
    credentials: {
      accessKeyId: connection.accessKeyId,
      secretAccessKey: connection.secretAccessKey
    }
  });
  return new S3FileStorage({
    client,
    bucket: connection.bucket,
    limits: options.limits
  });
}

export function validateLocalStorageRoot(value: unknown): string {
  if (typeof value !== "string") {
    throw new StorageConfigurationError("STORAGE_LOCAL_ROOT 必须是文件夹路径。");
  }
  const rootDirectory = value.trim();
  if (rootDirectory.length === 0 || rootDirectory.length > 4_096 || /[\u0000-\u001f\u007f]/.test(rootDirectory)) {
    throw new StorageConfigurationError("STORAGE_LOCAL_ROOT 不是可用的文件夹路径。");
  }
  return rootDirectory;
}

function validateEndpoint(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new StorageConfigurationError("S3_ENDPOINT 必须是有效的 HTTP 或 HTTPS 地址。");
  }
  if (value !== value.trim()) {
    throw new StorageConfigurationError("S3_ENDPOINT 不能包含首尾空白字符。");
  }

  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new StorageConfigurationError("S3_ENDPOINT 必须是有效的 HTTP 或 HTTPS 地址。");
  }
  if (
    (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") ||
    endpoint.username.length > 0 ||
    endpoint.password.length > 0 ||
    endpoint.search.length > 0 ||
    endpoint.hash.length > 0
  ) {
    throw new StorageConfigurationError(
      "S3_ENDPOINT 只能是没有账号、查询参数或片段的 HTTP 或 HTTPS 地址。"
    );
  }
  return endpoint.toString();
}

function validateRegion(value: unknown): string {
  const region = validatePlainValue(value, "S3_REGION", 64);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(region)) {
    throw new StorageConfigurationError("S3_REGION 格式不正确。");
  }
  return region;
}

function validateBucket(value: unknown): string {
  const bucket = validatePlainValue(value, "S3_BUCKET", 63);
  if (
    bucket.length < 3 ||
    !/^[a-z0-9](?:[a-z0-9.-]{1,61}[a-z0-9])$/.test(bucket) ||
    bucket.includes("..") ||
    bucket.includes(".-") ||
    bucket.includes("-.") ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(bucket)
  ) {
    throw new StorageConfigurationError("S3_BUCKET 格式不正确。");
  }
  return bucket;
}

function validateCredential(value: unknown, fieldName: "S3_ACCESS_KEY" | "S3_SECRET_KEY"): string {
  const credential = validatePlainValue(value, fieldName, 1_024);
  if (/\s/.test(credential)) {
    throw new StorageConfigurationError(`${fieldName} 不能包含空白字符。`);
  }
  return credential;
}

function validatePlainValue(value: unknown, fieldName: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new StorageConfigurationError(`${fieldName} 不能为空。`);
  }
  if (value !== value.trim() || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new StorageConfigurationError(`${fieldName} 格式不正确。`);
  }
  return value;
}
