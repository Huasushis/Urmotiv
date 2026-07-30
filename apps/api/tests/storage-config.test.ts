import { describe, expect, it } from "vitest";
import { readServerStorageOptions } from "../src/server-config";

describe("文件存储启动配置", () => {
  it("开发环境默认使用私有本地目录", () => {
    expect(readServerStorageOptions({})).toEqual({
      kind: "local",
      rootDirectory: ".data/storage",
      limits: { maxBytes: 128 * 1024 * 1024 }
    });
    expect(
      readServerStorageOptions({
        STORAGE_LOCAL_ROOT: ".private/storage",
        STORAGE_MAX_FILE_BYTES: "1048576"
      })
    ).toEqual({
      kind: "local",
      rootDirectory: ".private/storage",
      limits: { maxBytes: 1_048_576 }
    });
  });

  it("拒绝不安全的文件大小设置", () => {
    expect(() => readServerStorageOptions({ STORAGE_MAX_FILE_BYTES: "0" })).toThrow(
      "STORAGE_MAX_FILE_BYTES"
    );
    expect(() => readServerStorageOptions({ STORAGE_MAX_FILE_BYTES: "1.5" })).toThrow(
      "STORAGE_MAX_FILE_BYTES"
    );
    expect(() =>
      readServerStorageOptions({ STORAGE_MAX_FILE_BYTES: String(513 * 1024 * 1024) })
    ).toThrow("STORAGE_MAX_FILE_BYTES");
  });

  it("生产环境必须完整配置私有 S3", () => {
    expect(() =>
      readServerStorageOptions({
        NODE_ENV: "production",
        S3_ENDPOINT: "http://minio.internal:9000",
        S3_REGION: "us-east-1",
        S3_BUCKET: "urmotiv-private",
        S3_ACCESS_KEY: "test-access-key"
      })
    ).toThrow("S3_SECRET_KEY");

    expect(
      readServerStorageOptions({
        NODE_ENV: "production",
        S3_ENDPOINT: "http://minio.internal:9000",
        S3_REGION: "us-east-1",
        S3_BUCKET: "urmotiv-private",
        S3_ACCESS_KEY: "test-access-key",
        S3_SECRET_KEY: "test-secret-key",
        S3_FORCE_PATH_STYLE: "true"
      })
    ).toEqual({
      kind: "s3",
      endpoint: "http://minio.internal:9000/",
      region: "us-east-1",
      bucket: "urmotiv-private",
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
      forcePathStyle: true,
      limits: { maxBytes: 128 * 1024 * 1024 }
    });
  });

  it("拒绝不安全的生产 S3 配置而不回退到本地目录", () => {
    expect(() =>
      readServerStorageOptions({
        NODE_ENV: "production",
        STORAGE_LOCAL_ROOT: ".data/storage"
      })
    ).toThrow("STORAGE_LOCAL_ROOT");

    const base = {
      NODE_ENV: "production",
      S3_ENDPOINT: "https://access:secret@storage.example/?token=not-allowed",
      S3_REGION: "us-east-1",
      S3_BUCKET: "urmotiv-private",
      S3_ACCESS_KEY: "test-access-key",
      S3_SECRET_KEY: "test-secret-key"
    };
    expect(() => readServerStorageOptions(base)).toThrow("S3_ENDPOINT");
    expect(() =>
      readServerStorageOptions({
        ...base,
        S3_ENDPOINT: "https://storage.example",
        S3_BUCKET: "UPPERCASE"
      })
    ).toThrow("S3_BUCKET");
    expect(() =>
      readServerStorageOptions({
        ...base,
        S3_ENDPOINT: "https://storage.example",
        S3_FORCE_PATH_STYLE: "sometimes"
      })
    ).toThrow("S3_FORCE_PATH_STYLE");
  });
});
