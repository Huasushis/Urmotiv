import { describe, expect, it } from "vitest";
import {
  createFileStorage,
  LocalFileStorage,
  S3FileStorage,
  StorageConfigurationError,
  validateS3StorageConnection
} from "../src";

const limits = { maxBytes: 1024 };

describe("文件存储工厂", () => {
  it("在轻量模式创建本地文件存储", () => {
    const storage = createFileStorage({
      kind: "local",
      rootDirectory: ".data/storage",
      limits
    });

    expect(storage).toBeInstanceOf(LocalFileStorage);
  });

  it("在生产配置创建 S3 文件存储而不公开下载地址", () => {
    const storage = createFileStorage({
      kind: "s3",
      endpoint: "http://minio.internal:9000",
      region: "us-east-1",
      bucket: "urmotiv-private",
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
      forcePathStyle: true,
      limits
    });

    expect(storage).toBeInstanceOf(S3FileStorage);
    expect("getPublicUrl" in storage).toBe(false);
  });

  it("拒绝会把凭据或查询参数放进对象存储地址的配置", () => {
    expect(() =>
      validateS3StorageConnection({
        endpoint: "https://access:secret@storage.example/?token=not-allowed",
        region: "us-east-1",
        bucket: "urmotiv-private",
        accessKeyId: "test-access-key",
        secretAccessKey: "test-secret-key",
        forcePathStyle: false
      })
    ).toThrow(StorageConfigurationError);
  });

  it("拒绝无效的桶名和凭据格式", () => {
    expect(() =>
      validateS3StorageConnection({
        endpoint: "https://storage.example",
        region: "us-east-1",
        bucket: "Invalid_Bucket",
        accessKeyId: "test-access-key",
        secretAccessKey: "test-secret-key",
        forcePathStyle: false
      })
    ).toThrow("S3_BUCKET");

    expect(() =>
      validateS3StorageConnection({
        endpoint: "https://storage.example",
        region: "us-east-1",
        bucket: "urmotiv-private",
        accessKeyId: "test access key",
        secretAccessKey: "test-secret-key",
        forcePathStyle: false
      })
    ).toThrow("S3_ACCESS_KEY");
  });
});
