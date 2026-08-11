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

/**
 * 断言 staging 目录下无残留 .part 文件。
 * 只捕获 ENOENT（staging 目录不存在 = 零残留）；若目录存在，
 * 所有子目录必须为空，否则断言失败（不吞没 expect）。
 */
async function assertStagingEmpty(root: string): Promise<void> {
  const stagingRoot = join(root, "staging");
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(stagingRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      expect(await readdir(join(stagingRoot, entry.name))).toEqual([]);
    }
  }
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

  it("精确重放同一临时记录返回相同正式文件且不删除已有正式对象", async () => {
    const { storage, root } = await makeStorage();
    const staged = await storage.stage({
      originalName: "data.txt",
      mediaType: "text/plain",
      content: bytes("kept")
    });
    const stored = await storage.publish(staged);

    // 确定性重放断言：首次 publish 后，per-attempt staging 临时文件必须已被删除。
    assertStagingEmpty(root);

    // 重放：正式对象已存在，临时区已清理。幂等返回相同的 StoredFile。
    const replayed = await storage.publish(staged);
    expect(replayed.id).toBe(stored.id);
    expect(replayed.sha256).toBe(stored.sha256);
    expect(replayed.byteSize).toBe(stored.byteSize);
    expect(replayed.storageKey).toBe(stored.storageKey);
    expect(await readText(await storage.open(stored))).toBe("kept");
  });

  it("调用方提供 UUID 时精确重放返回相同 StagedFile 和 StoredFile", async () => {
    const { storage, root } = await makeStorage();
    const fixedId = "11111111-1111-4111-8111-111111111111";
    const staged1 = await storage.stage({
      originalName: "data.zip",
      mediaType: "application/zip",
      content: bytes("payload"),
      id: fixedId,
    });
    expect(staged1.id).toBe(fixedId);
    const stored1 = await storage.publish(staged1);
    expect(stored1.id).toBe(fixedId);
    expect(stored1.storageKey).toBe(`objects/${fixedId}`);

    // 再次 stage 同一 UUID + 同一内容：新 StagedFile 有相同 id/sha256/byteSize。
    const staged2 = await storage.stage({
      originalName: "data.zip",
      mediaType: "application/zip",
      content: bytes("payload"),
      id: fixedId,
    });
    expect(staged2.id).toBe(fixedId);
    expect(staged2.sha256).toBe(staged1.sha256);
    expect(staged2.byteSize).toBe(staged1.byteSize);

    // publish 幂等：正式对象已存在，返回相同的 StoredFile。
    const stored2 = await storage.publish(staged2);
    expect(stored2.id).toBe(fixedId);
    expect(stored2.sha256).toBe(stored1.sha256);
    expect(stored2.storageKey).toBe(stored1.storageKey);

    // objects 目录只有这一个对象。
    expect(await readdir(join(root, "objects"))).toHaveLength(1);
  });

  it("调用方提供 UUID 但内容不同时第二次 publish 失败", async () => {
    const { storage } = await makeStorage();
    const fixedId = "22222222-2222-4222-8222-222222222222";
    const staged1 = await storage.stage({
      originalName: "a.txt",
      mediaType: "text/plain",
      content: bytes("aaa"),
      id: fixedId,
    });
    expect(staged1.id).toBe(fixedId);
    // 第一次 publish 成功。
    const stored1 = await storage.publish(staged1);
    expect(stored1.id).toBe(fixedId);

    // 同一 UUID 但不同内容：所有权安全 staging 允许 stage（不同 attempt 路径），
    // 但 publish 时既有对象大小不匹配 → fail-closed。
    const staged2 = await storage.stage({
      originalName: "a.txt",
      mediaType: "text/plain",
      content: bytes("bbbb"),
      id: fixedId,
    });
    await expect(storage.publish(staged2)).rejects.toMatchObject({ code: "STORAGE_PUBLISH_FAILED" });
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

    // staging 目录下无残留 .part 文件。
    assertStagingEmpty(root);
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

    // staging 目录下无残留 .part 文件。
    assertStagingEmpty(root);
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
    // staging 目录下无残留 .part 文件。
    assertStagingEmpty(root);
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
