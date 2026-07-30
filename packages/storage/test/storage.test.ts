import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalFileStorage, type StoredFile } from "../src";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function makeStorage(maxBytes = 1024): Promise<{ storage: LocalFileStorage; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "urmotiv-storage-"));
  temporaryDirectories.push(root);
  return {
    root,
    storage: new LocalFileStorage({
      rootDirectory: root,
      limits: { maxBytes, allowedMediaTypes: ["text/plain", "application/zip"] }
    })
  };
}

async function* bytes(value: string): AsyncGenerator<Uint8Array> {
  yield new TextEncoder().encode(value);
}

async function readText(content: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of content) {
    chunks.push(chunk);
  }
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const merged = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

describe("本地文件存储", () => {
  it("拒绝把原文件名或伪造位置当作磁盘路径", async () => {
    const { storage } = await makeStorage();
    await expect(
      storage.stage({
        originalName: "../private.txt",
        mediaType: "text/plain",
        content: bytes("secret")
      })
    ).rejects.toMatchObject({ code: "INVALID_FILE_NAME" });

    await expect(
      storage.open({
        id: "11111111-1111-4111-8111-111111111111",
        storageKey: "../../private.txt"
      })
    ).rejects.toMatchObject({ code: "INVALID_STORAGE_KEY" });
  });

  it("同名文件使用不同系统编号且不会互相覆盖", async () => {
    const { storage } = await makeStorage();
    const first = await storage.publish(
      await storage.stage({
        originalName: "data.txt",
        mediaType: "text/plain",
        content: bytes("first")
      })
    );
    const second = await storage.publish(
      await storage.stage({
        originalName: "data.txt",
        mediaType: "text/plain",
        content: bytes("second")
      })
    );

    expect(first.id).not.toBe(second.id);
    expect(first.storageKey).not.toBe(second.storageKey);
    expect(await readText(await storage.open(first))).toBe("first");
    expect(await readText(await storage.open(second))).toBe("second");
    expect(first.sha256).toBe(createHash("sha256").update("first").digest("hex"));
  });

  it("重复发布同一临时记录失败时不会删除已有正式文件", async () => {
    const { storage } = await makeStorage();
    const staged = await storage.stage({
      originalName: "data.txt",
      mediaType: "text/plain",
      content: bytes("kept")
    });
    const stored = await storage.publish(staged);

    await expect(storage.publish(staged)).rejects.toMatchObject({
      code: "STORAGE_PUBLISH_FAILED"
    });
    expect(await readText(await storage.open(stored))).toBe("kept");
  });

  it("流式写入超过大小限制时清理临时文件且不发布", async () => {
    const { storage, root } = await makeStorage(5);
    await expect(
      storage.stage({
        originalName: "data.txt",
        mediaType: "text/plain",
        content: bytes("123456")
      })
    ).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });

    expect(await readdir(join(root, "staging"))).toEqual([]);
    expect(await readdir(join(root, "objects"))).toEqual([]);
  });

  it("数据流中途失败时清理临时文件且不发布", async () => {
    const { storage, root } = await makeStorage();
    async function* brokenStream(): AsyncGenerator<Uint8Array> {
      yield new TextEncoder().encode("partial");
      throw new Error("source failed");
    }

    await expect(
      storage.stage({
        originalName: "data.txt",
        mediaType: "text/plain",
        content: brokenStream()
      })
    ).rejects.toMatchObject({ code: "STORAGE_WRITE_FAILED" });

    expect(await readdir(join(root, "staging"))).toEqual([]);
    expect(await readdir(join(root, "objects"))).toEqual([]);
  });

  it("临时文件丢失时发布失败且正式区保持为空", async () => {
    const { storage, root } = await makeStorage();
    const staged = await storage.stage({
      originalName: "data.txt",
      mediaType: "text/plain",
      content: bytes("value")
    });
    await rm(join(root, ...staged.stagingKey.split("/")));

    await expect(storage.publish(staged)).rejects.toMatchObject({
      code: "STORAGE_PUBLISH_FAILED"
    });
    expect(await readdir(join(root, "staging"))).toEqual([]);
    expect(await readdir(join(root, "objects"))).toEqual([]);
  });

  it("拒绝不在允许范围内的文件类型", async () => {
    const { storage } = await makeStorage();
    await expect(
      storage.stage({
        originalName: "image.png",
        mediaType: "image/png",
        content: bytes("not-an-image")
      })
    ).rejects.toMatchObject({ code: "INVALID_MEDIA_TYPE" });
  });

  it("删除后不再返回正式文件", async () => {
    const { storage } = await makeStorage();
    const file: StoredFile = await storage.publish(
      await storage.stage({
        originalName: "data.txt",
        mediaType: "text/plain",
        content: bytes("value")
      })
    );
    await storage.delete(file);
    await expect(storage.open(file)).rejects.toMatchObject({
      code: "OBJECT_NOT_FOUND"
    });
  });
});
