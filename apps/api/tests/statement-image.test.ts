import { randomUUID } from "node:crypto";
import type { FileStorage, StorageError } from "@urmotiv/storage";
import { describe, expect, it, vi } from "vitest";
import type { StoredUser } from "../src/domain";
import type { ProblemFileStore } from "../src/problem-file-store";
import { ProblemFileService } from "../src/problem-file-service";
import type { ProblemService } from "../src/service";
import {
  InvalidStatementImageError,
  prepareStatementImage,
  StatementImageReadError
} from "../src/statement-image";

function controlledSource(next: () => Promise<IteratorResult<Uint8Array>>) {
  const close = vi.fn(async (): Promise<IteratorResult<Uint8Array>> => ({
    done: true,
    value: undefined
  }));
  return {
    close,
    source: {
      [Symbol.asyncIterator]: () => ({ next, return: close })
    } satisfies AsyncIterable<Uint8Array>
  };
}

describe("题面图片文件头检查", () => {
  it("不支持的声明类型会在读取前关闭上传流", async () => {
    const next = vi.fn(async (): Promise<IteratorResult<Uint8Array>> => ({
      done: false,
      value: new Uint8Array([1])
    }));
    const controlled = controlledSource(next);

    await expect(
      prepareStatementImage("image/svg+xml", ["assets/image.svg"], controlled.source)
    ).rejects.toBeInstanceOf(InvalidStatementImageError);
    expect(next).not.toHaveBeenCalled();
    expect(controlled.close).toHaveBeenCalledOnce();

    const wrongExtensionNext = vi.fn(async (): Promise<IteratorResult<Uint8Array>> => ({
      done: false,
      value: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    }));
    const wrongExtension = controlledSource(wrongExtensionNext);
    await expect(
      prepareStatementImage("image/png", ["assets/image.svg"], wrongExtension.source)
    ).rejects.toBeInstanceOf(InvalidStatementImageError);
    expect(wrongExtensionNext).not.toHaveBeenCalled();
    expect(wrongExtension.close).toHaveBeenCalledOnce();
  });

  it("签名不符、截断和读取异常都会关闭上传流", async () => {
    const cases: Array<{
      readonly next: () => Promise<IteratorResult<Uint8Array>>;
      readonly error: typeof InvalidStatementImageError | typeof StatementImageReadError;
    }> = [
      {
        next: vi.fn(async () => ({
          done: false as const,
          value: new Uint8Array([0xff, 0xd8, 0xff, 0x00])
        })),
        error: InvalidStatementImageError
      },
      {
        next: vi
          .fn<() => Promise<IteratorResult<Uint8Array>>>()
          .mockResolvedValueOnce({ done: false, value: new Uint8Array([0x89, 0x50]) })
          .mockResolvedValueOnce({ done: true, value: undefined }),
        error: InvalidStatementImageError
      },
      {
        next: vi.fn(() => Promise.reject(new Error("synthetic-read-failure"))),
        error: StatementImageReadError
      }
    ];

    for (const testCase of cases) {
      const controlled = controlledSource(testCase.next);
      await expect(
        prepareStatementImage("image/png", ["assets/image.png"], controlled.source)
      ).rejects.toBeInstanceOf(testCase.error);
      expect(controlled.close).toHaveBeenCalledOnce();
    }
  });

  it("连续空数据块有固定上限且不会无限空转", async () => {
    const next = vi.fn(async (): Promise<IteratorResult<Uint8Array>> => ({
      done: false,
      value: new Uint8Array(0)
    }));
    const controlled = controlledSource(next);

    await expect(
      prepareStatementImage("image/png", ["assets/image.png"], controlled.source)
    ).rejects.toBeInstanceOf(InvalidStatementImageError);
    expect(next).toHaveBeenCalledTimes(1025);
    expect(controlled.close).toHaveBeenCalledOnce();

    let afterPrefixCalls = 0;
    const afterPrefix = controlledSource(async () => {
      afterPrefixCalls += 1;
      return {
        done: false,
        value:
          afterPrefixCalls === 1
            ? new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
            : new Uint8Array(0)
      };
    });
    const prepared = await prepareStatementImage(
      "image/png",
      ["assets/image.png"],
      afterPrefix.source
    );
    const consume = async () => {
      for await (const _chunk of prepared.content) {
        // 消费重放流，验证文件头之后的空块保护。
      }
    };
    await expect(consume()).rejects.toEqual(
      expect.objectContaining<Partial<StorageError>>({ code: "INVALID_STREAM" })
    );
    expect(afterPrefix.close).toHaveBeenCalledOnce();
  });

  it("分块文件头只预读所需字节并完整重放内容", async () => {
    const chunks = [
      new Uint8Array(Buffer.from("R")),
      new Uint8Array(Buffer.from("IF")),
      new Uint8Array([0x46, 0x04, 0x00, 0x00, 0x00, 0x57]),
      new Uint8Array(Buffer.from("EBPpayload"))
    ];
    let position = 0;
    const next = vi.fn(async (): Promise<IteratorResult<Uint8Array>> => {
      const value = chunks[position];
      position += 1;
      return value === undefined ? { done: true, value: undefined } : { done: false, value };
    });
    const controlled = controlledSource(next);

    const prepared = await prepareStatementImage(
      "image/webp",
      ["assets/image.webp"],
      controlled.source
    );
    expect(next).toHaveBeenCalledTimes(4);
    const replayed: Uint8Array[] = [];
    for await (const chunk of prepared.content) {
      replayed.push(chunk);
    }
    expect(Buffer.concat(replayed)).toEqual(Buffer.concat(chunks));
    expect(next).toHaveBeenCalledTimes(5);
  });

  it("存储层在消费重放流前失败也会关闭底层上传流", async () => {
    const next = vi.fn(async (): Promise<IteratorResult<Uint8Array>> => ({
      done: false,
      value: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    }));
    const controlled = controlledSource(next);
    const publish = vi.fn();
    const files = new ProblemFileService({
      service: {
        getProblemForFileAccess: vi.fn(async () => ({
          problem: { revisionId: randomUUID() },
          capabilities: { canEdit: true, canReadTestdata: false, canWriteTestdata: false }
        }))
      } as unknown as ProblemService,
      metadata: {} as ProblemFileStore,
      storage: {
        stage: vi.fn(async () => {
          throw new Error("synthetic-stage-failure");
        }),
        publish
      } as unknown as FileStorage
    });

    await expect(
      files.uploadFile({ id: "1" } as StoredUser, "1", {
        expectedRevision: 1,
        category: "statement_image",
        logicalPath: "assets/image.png",
        position: 0,
        originalName: "image.png",
        mediaType: "image/png",
        replaceExisting: false,
        bindJudgeProgram: false
      }, controlled.source)
    ).rejects.toMatchObject({ statusCode: 500, code: "STORAGE_FAILED" });
    expect(controlled.close).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
  });
});
