import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  defaultArchiveSafetyLimits,
  UnsafeArchiveError,
  readZipArchive,
  validateArchiveMetadata,
  writeZipArchive
} from "../src";

const encoder = new TextEncoder();

function issuesOf(
  run: () => unknown
): readonly { code: string; path?: string; message: string }[] {
  try {
    run();
  } catch (error) {
    if (error instanceof UnsafeArchiveError) {
      return error.issues;
    }
    throw error;
  }
  throw new Error("预期抛出 UnsafeArchiveError，但没有抛出。");
}

interface RawEntryOptions {
  readonly path: string;
  readonly content?: Uint8Array;
  readonly compressionMethod?: number;
  readonly storedBytes?: Uint8Array;
  readonly declaredUncompressedSize?: number;
  readonly declaredCrc32?: number;
  readonly externalAttributes?: number;
  readonly flags?: number;
  readonly dataDescriptor?: "with-signature" | "without-signature";
  readonly dataDescriptorLength?: number;
}

/**
 * 直接按 ZIP 结构手工拼一个包，用来构造正常工具不会生成的攻击样例。
 */
function buildRawZip(entries: readonly RawEntryOptions[]): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.path);
    const content = entry.content ?? new Uint8Array(0);
    const method = entry.compressionMethod ?? 8;
    const stored =
      entry.storedBytes ?? (method === 0 ? content : new Uint8Array(deflateRawSync(content)));
    const declaredSize = entry.declaredUncompressedSize ?? content.byteLength;
    const checksum = entry.declaredCrc32 ?? crc32Of(content);
    const flags = entry.flags ?? (entry.dataDescriptor === undefined ? 0x0800 : 0x0808);
    const usesDataDescriptor = (flags & 0x0008) !== 0;

    const local = new Uint8Array(30 + nameBytes.byteLength);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, flags, true);
    localView.setUint16(8, method, true);
    localView.setUint32(14, usesDataDescriptor ? 0 : checksum, true);
    localView.setUint32(18, usesDataDescriptor ? 0 : stored.byteLength, true);
    localView.setUint32(22, usesDataDescriptor ? 0 : declaredSize, true);
    localView.setUint16(26, nameBytes.byteLength, true);
    local.set(nameBytes, 30);

    const central = new Uint8Array(46 + nameBytes.byteLength);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 0x031e, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, flags, true);
    centralView.setUint16(10, method, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, stored.byteLength, true);
    centralView.setUint32(24, declaredSize, true);
    centralView.setUint16(28, nameBytes.byteLength, true);
    centralView.setUint32(38, entry.externalAttributes ?? 0o100644 << 16, true);
    centralView.setUint32(42, offset, true);
    central.set(nameBytes, 46);

    let descriptor = new Uint8Array(0);
    if (entry.dataDescriptor !== undefined) {
      const hasSignature = entry.dataDescriptor === "with-signature";
      const complete = new Uint8Array(hasSignature ? 16 : 12);
      const descriptorView = new DataView(complete.buffer);
      const valueOffset = hasSignature ? 4 : 0;
      if (hasSignature) {
        descriptorView.setUint32(0, 0x08074b50, true);
      }
      descriptorView.setUint32(valueOffset, checksum, true);
      descriptorView.setUint32(valueOffset + 4, stored.byteLength, true);
      descriptorView.setUint32(valueOffset + 8, declaredSize, true);
      descriptor = complete.subarray(0, entry.dataDescriptorLength ?? complete.byteLength);
    }

    localParts.push(local, stored, descriptor);
    centralParts.push(central);
    offset += local.byteLength + stored.byteLength + descriptor.byteLength;
  }

  const centralSize = centralParts.reduce((total, part) => total + part.byteLength, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);

  const archive = new Uint8Array(offset + centralSize + 22);
  let cursor = 0;
  for (const part of [...localParts, ...centralParts, end]) {
    archive.set(part, cursor);
    cursor += part.byteLength;
  }
  return archive;
}

function crc32Of(content: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function copyWithView(
  archive: Uint8Array,
  mutate: (view: DataView, bytes: Uint8Array) => void
): Uint8Array {
  const copy = new Uint8Array(archive);
  mutate(new DataView(copy.buffer, copy.byteOffset, copy.byteLength), copy);
  return copy;
}

function endRecordOffsetOf(archive: Uint8Array): number {
  return archive.byteLength - 22;
}

function centralDirectoryOffsetOf(view: DataView, archive: Uint8Array): number {
  return view.getUint32(endRecordOffsetOf(archive) + 16, true);
}

function nextCentralEntryOffset(view: DataView, offset: number): number {
  return (
    offset +
    46 +
    view.getUint16(offset + 28, true) +
    view.getUint16(offset + 30, true) +
    view.getUint16(offset + 32, true)
  );
}

function withZipPrefix(archive: Uint8Array, prefix: Uint8Array): Uint8Array {
  const result = new Uint8Array(prefix.byteLength + archive.byteLength);
  result.set(prefix, 0);
  result.set(archive, prefix.byteLength);
  const view = new DataView(result.buffer);
  const endOffset = endRecordOffsetOf(result);
  const entryCount = view.getUint16(endOffset + 10, true);
  let centralOffset = view.getUint32(endOffset + 16, true) + prefix.byteLength;
  view.setUint32(endOffset + 16, centralOffset, true);

  for (let index = 0; index < entryCount; index += 1) {
    const localOffset = view.getUint32(centralOffset + 42, true);
    view.setUint32(centralOffset + 42, localOffset + prefix.byteLength, true);
    centralOffset = nextCentralEntryOffset(view, centralOffset);
  }
  return result;
}

describe("ZIP 读写", () => {
  it("写出的压缩包可以完整读回，相同输入的字节完全一致", () => {
    const files = [
      { path: "manifest.yaml", content: encoder.encode("format: urmotiv-problem\n") },
      { path: "content/basic-statement.md", content: encoder.encode("题面 statement ".repeat(50)) },
      { path: "judge/testdata/001.in", content: encoder.encode("1 2\n") }
    ];
    const first = writeZipArchive(files);
    const second = writeZipArchive(files);
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);

    const archive = readZipArchive(first);
    expect(archive.list().map((entry) => entry.path).sort()).toEqual([
      "content/basic-statement.md",
      "judge/testdata/001.in",
      "manifest.yaml"
    ]);
    for (const file of files) {
      expect(Buffer.from(archive.read(file.path) ?? new Uint8Array()).toString("utf8")).toBe(
        Buffer.from(file.content).toString("utf8")
      );
    }
  });

  it("默认内存限制保持在可控范围，写出的小额度边界与读取一致", () => {
    expect(defaultArchiveSafetyLimits).toMatchObject({
      maxArchiveBytes: 128 * 1024 * 1024,
      maxSingleFileBytes: 128 * 1024 * 1024,
      maxTotalUncompressedBytes: 128 * 1024 * 1024
    });

    const files = [{ path: "a.txt", content: encoder.encode("small") }];
    const normal = writeZipArchive(files);
    expect(
      issuesOf(() => writeZipArchive(files, { maxArchiveBytes: normal.byteLength - 1 }))
    ).toEqual([expect.objectContaining({ code: "archive_too_large" })]);
    const exact = writeZipArchive(files, { maxArchiveBytes: normal.byteLength });
    expect(exact.byteLength).toBe(normal.byteLength);
    expect(readZipArchive(exact, { maxArchiveBytes: exact.byteLength }).has("a.txt")).toBe(true);

    const compressible = [{ path: "zeros.bin", content: new Uint8Array(100_000) }];
    expect(readZipArchive(writeZipArchive(compressible)).has("zeros.bin")).toBe(true);

    const smallLimits = {
      maxSingleFileBytes: 3,
      maxTotalUncompressedBytes: 5
    };
    const smallFiles = [
      { path: "three.bin", content: new Uint8Array(3) },
      { path: "two.bin", content: new Uint8Array(2) }
    ];
    const smallArchive = writeZipArchive(smallFiles, smallLimits);
    expect(readZipArchive(smallArchive, smallLimits).list()).toHaveLength(2);
    expect(
      issuesOf(() =>
        writeZipArchive(
          [{ path: "four.bin", content: new Uint8Array(4) }],
          smallLimits
        )
      )
    ).toEqual([expect.objectContaining({ code: "file_too_large", path: "four.bin" })]);
    expect(
      issuesOf(() =>
        writeZipArchive(smallFiles, {
          maxSingleFileBytes: 3,
          maxTotalUncompressedBytes: 4
        })
      )
    ).toEqual([expect.objectContaining({ code: "archive_too_large" })]);

    const inner = writeZipArchive(files);
    const prefixedInner = withZipPrefix(inner, encoder.encode("MZ-prefix"));
    const prefixedAndTrailedInner = new Uint8Array(prefixedInner.byteLength + 7);
    prefixedAndTrailedInner.set(prefixedInner);
    prefixedAndTrailedInner.set(encoder.encode("trailer"), prefixedInner.byteLength);
    expect(readZipArchive(prefixedInner).has("a.txt")).toBe(true);
    for (const content of [inner, prefixedInner, prefixedAndTrailedInner]) {
      expect(
        issuesOf(() => writeZipArchive([{ path: "problem.zip", content }]))
      ).toEqual([
        expect.objectContaining({ code: "nested_archive", path: "problem.zip" })
      ]);
    }
    const outerLimits = { allowNestedArchives: true };
    const outer = writeZipArchive(
      [{ path: "problem.zip", content: prefixedInner }],
      outerLimits
    );
    expect(issuesOf(() => readZipArchive(outer))).toEqual([
      expect.objectContaining({ code: "nested_archive", path: "problem.zip" })
    ]);
    expect(readZipArchive(outer, outerLimits).has("problem.zip")).toBe(true);
  });

  it("带前缀的 ZIP64、分卷、不可解析目录和伪结束记录也按嵌套包拒绝", () => {
    const inner = writeZipArchive([
      { path: "a.txt", content: encoder.encode("nested content") }
    ]);
    const prefixed = withZipPrefix(inner, encoder.encode("MZ-prefix"));
    const zip64 = copyWithView(prefixed, (view, bytes) => {
      const endOffset = endRecordOffsetOf(bytes);
      view.setUint16(endOffset + 8, 0xffff, true);
      view.setUint16(endOffset + 10, 0xffff, true);
      view.setUint32(endOffset + 12, 0xffffffff, true);
      view.setUint32(endOffset + 16, 0xffffffff, true);
    });
    const split = copyWithView(prefixed, (view, bytes) => {
      const endOffset = endRecordOffsetOf(bytes);
      view.setUint16(endOffset + 4, 1, true);
      view.setUint16(endOffset + 6, 1, true);
    });
    const unreadableDirectory = copyWithView(prefixed, (view, bytes) => {
      const centralOffset = centralDirectoryOffsetOf(view, bytes);
      view.setUint32(centralOffset, 0x05054b50, true);
    });

    const fakeEndRecord = new Uint8Array(prefixed.byteLength + 22);
    fakeEndRecord.set(prefixed);
    const fakeView = new DataView(fakeEndRecord.buffer);
    const realEndOffset = endRecordOffsetOf(prefixed);
    fakeView.setUint16(realEndOffset + 20, 22, true);
    const fakeOffset = prefixed.byteLength;
    fakeView.setUint32(fakeOffset, 0x06054b50, true);
    fakeView.setUint16(fakeOffset + 8, 1, true);
    fakeView.setUint16(fakeOffset + 10, 1, true);
    fakeView.setUint32(fakeOffset + 12, 46, true);
    fakeView.setUint32(fakeOffset + 16, 0x7ffffff0, true);

    for (const content of [zip64, split, unreadableDirectory, fakeEndRecord]) {
      expect(
        issuesOf(() => writeZipArchive([{ path: "problem.zip", content }]))
      ).toEqual([
        expect.objectContaining({ code: "nested_archive", path: "problem.zip" })
      ]);
    }
  });

  it("拒绝不是 ZIP 的内容和被截断的包", () => {
    expect(issuesOf(() => readZipArchive(encoder.encode("plain text")))).toEqual([
      expect.objectContaining({ code: "not_a_zip_archive" })
    ]);
    const valid = writeZipArchive([{ path: "a.txt", content: encoder.encode("hello") }]);
    expect(issuesOf(() => readZipArchive(valid.subarray(0, valid.byteLength - 30)))).toEqual([
      expect.objectContaining({ code: "not_a_zip_archive" })
    ]);
  });

  it("在读取目录前限制原始包大小和目录声明的条目数", () => {
    const valid = buildRawZip([{ path: "a.txt", content: encoder.encode("x") }]);
    expect(
      issuesOf(() => readZipArchive(valid, { maxArchiveBytes: valid.byteLength - 1 }))
    ).toEqual([expect.objectContaining({ code: "archive_too_large" })]);
    expect(readZipArchive(valid, { maxArchiveBytes: valid.byteLength }).has("a.txt")).toBe(true);

    const forgedCount = copyWithView(valid, (view, bytes) => {
      const endOffset = endRecordOffsetOf(bytes);
      view.setUint16(endOffset + 8, 4, true);
      view.setUint16(endOffset + 10, 4, true);
    });
    expect(issuesOf(() => readZipArchive(forgedCount, { maxEntries: 3 }))).toEqual([
      expect.objectContaining({ code: "too_many_entries" })
    ]);
  });

  it("拒绝声明长度没有被目录条目精确占满的中央目录", () => {
    const valid = buildRawZip([{ path: "a.txt", content: encoder.encode("x") }]);
    const oldEndOffset = endRecordOffsetOf(valid);
    const padded = new Uint8Array(valid.byteLength + 1);
    padded.set(valid.subarray(0, oldEndOffset), 0);
    padded[oldEndOffset] = 0;
    padded.set(valid.subarray(oldEndOffset), oldEndOffset + 1);
    const view = new DataView(padded.buffer);
    const newEndOffset = endRecordOffsetOf(padded);
    view.setUint32(newEndOffset + 12, view.getUint32(newEndOffset + 12, true) + 1, true);

    expect(issuesOf(() => readZipArchive(padded))).toEqual([
      expect.objectContaining({ code: "not_a_zip_archive" })
    ]);
  });

  it("在解压前拒绝目录跳转和绝对路径", () => {
    for (const path of ["../escape.txt", "/etc/passwd", "a/../../b.txt", "a\\b.txt"]) {
      const zip = buildRawZip([{ path, content: encoder.encode("x") }]);
      expect(issuesOf(() => readZipArchive(zip))).toEqual([
        expect.objectContaining({ code: "invalid_path" })
      ]);
    }
  });

  it("危险名称不会出现在错误详情中，未声明 UTF-8 的非 ASCII 名称会被拒绝", () => {
    for (const path of ["hidden\nname.bin", "a".repeat(241)]) {
      const zip = buildRawZip([
        { path, content: encoder.encode("x"), compressionMethod: 99 }
      ]);
      const issues = issuesOf(() => readZipArchive(zip));
      expect(issues).toEqual([expect.objectContaining({ code: "invalid_path" })]);
      expect(issues.every((issue) => issue.path === undefined)).toBe(true);
      expect(issues.map((issue) => issue.message).join("\n")).not.toContain(path);
    }

    const unmarkedUtf8 = buildRawZip([
      { path: "中文.txt", content: encoder.encode("x"), flags: 0 }
    ]);
    const issues = issuesOf(() => readZipArchive(unmarkedUtf8));
    expect(issues).toEqual([
      expect.objectContaining({ code: "unsupported_archive_feature" })
    ]);
    expect(issues.every((issue) => issue.path === undefined)).toBe(true);
    expect(issues.map((issue) => issue.message).join("\n")).not.toContain("中文.txt");
  });

  it("路径不安全时先拒绝路径，不回显同时存在的非法大小或条目类型", () => {
    const unsafePath = "private\nname.txt";
    const entries = [
      {
        path: unsafePath,
        kind: "file" as const,
        compressedSize: Number.NaN,
        uncompressedSize: 1
      },
      {
        path: unsafePath,
        kind: "file" as const,
        compressedSize: -1,
        uncompressedSize: -1
      },
      {
        path: unsafePath,
        kind: "other" as const,
        compressedSize: 1,
        uncompressedSize: 1
      }
    ];

    for (const entry of entries) {
      const result = validateArchiveMetadata([entry]);
      expect(result.issues).toEqual([
        expect.objectContaining({ code: "invalid_path" })
      ]);
      expect(result.issues.every((issue) => issue.path === undefined)).toBe(true);
      expect(result.issues.map((issue) => issue.message).join("\n")).not.toContain(unsafePath);
      expect(result.summary.entries).toEqual([]);
    }

    const tooMany = validateArchiveMetadata(
      [entries[0]!, { path: "safe.txt", kind: "file", compressedSize: 1, uncompressedSize: 1 }],
      { maxEntries: 1 }
    );
    expect(tooMany.issues).toEqual([
      expect.objectContaining({ code: "too_many_entries" })
    ]);
    expect(tooMany.summary.entries).toEqual([]);
  });

  it("拒绝符号链接、设备文件和重复路径", () => {
    const symlink = buildRawZip([
      {
        path: "link.txt",
        content: encoder.encode("target"),
        externalAttributes: 0o120777 << 16
      }
    ]);
    expect(issuesOf(() => readZipArchive(symlink))).toEqual([
      expect.objectContaining({ code: "unsupported_entry_type", path: "link.txt" })
    ]);

    const device = buildRawZip([
      { path: "dev.bin", content: encoder.encode("x"), externalAttributes: 0o020644 << 16 }
    ]);
    expect(issuesOf(() => readZipArchive(device))).toEqual([
      expect.objectContaining({ code: "unsupported_entry_type" })
    ]);

    const duplicated = buildRawZip([
      { path: "same.txt", content: encoder.encode("one") },
      { path: "same.txt", content: encoder.encode("two") }
    ]);
    expect(issuesOf(() => readZipArchive(duplicated))).toEqual([
      expect.objectContaining({ code: "duplicate_path", path: "same.txt" })
    ]);
  });

  it("拒绝加密、zip64 和不支持的压缩方式", () => {
    for (const flags of [0x0801, 0x0840, 0x2800]) {
      const encrypted = buildRawZip([
        { path: "secret.txt", content: encoder.encode("x"), flags }
      ]);
      const issues = issuesOf(() => readZipArchive(encrypted));
      expect(issues).toEqual([
        expect.objectContaining({ code: "unsupported_archive_feature" })
      ]);
      expect(issues.every((issue) => issue.path === undefined)).toBe(true);
    }

    const unknownMethod = buildRawZip([
      { path: "odd.bin", content: encoder.encode("x"), compressionMethod: 99 }
    ]);
    expect(issuesOf(() => readZipArchive(unknownMethod))).toEqual([
      expect.objectContaining({ code: "unsupported_archive_feature", path: "odd.bin" })
    ]);

    const zip64 = buildRawZip([
      { path: "big.bin", content: encoder.encode("x"), declaredUncompressedSize: 0xffffffff }
    ]);
    expect(issuesOf(() => readZipArchive(zip64))).toEqual([
      expect.objectContaining({ code: "unsupported_archive_feature" })
    ]);
  });

  it("只接受已实现的通用标志位，压缩选项只用于 deflate", () => {
    for (const flags of [0x0800, 0x0802, 0x0804, 0x0806]) {
      const supported = buildRawZip([
        { path: `supported-${flags}.txt`, content: encoder.encode("content"), flags }
      ]);
      expect(readZipArchive(supported).has(`supported-${flags}.txt`)).toBe(true);
    }

    for (const { flags, method } of [
      { flags: 0x0802, method: 0 },
      { flags: 0x0810, method: 8 },
      { flags: 0x0820, method: 8 },
      { flags: 0x0880, method: 8 },
      { flags: 0x1800, method: 8 },
      { flags: 0x4800, method: 8 }
    ]) {
      const unsupported = buildRawZip([
        {
          path: "unsupported-flag.txt",
          content: encoder.encode("content"),
          compressionMethod: method,
          flags
        }
      ]);
      const issues = issuesOf(() => readZipArchive(unsupported));
      expect(issues).toEqual([
        expect.objectContaining({ code: "unsupported_archive_feature" })
      ]);
      expect(issues.every((issue) => issue.path === undefined)).toBe(true);
    }
  });

  it("拒绝本地头与中央目录中的名称、标志、压缩方式、校验值或大小不一致", () => {
    const valid = buildRawZip([
      { path: "a.txt", content: encoder.encode("x"), compressionMethod: 0 }
    ]);
    const mutations: readonly ((view: DataView, bytes: Uint8Array) => void)[] = [
      (view) => view.setUint16(6, view.getUint16(6, true) ^ 0x0800, true),
      (view) => view.setUint16(8, 8, true),
      (view) => view.setUint32(14, view.getUint32(14, true) ^ 1, true),
      (view) => view.setUint32(18, view.getUint32(18, true) + 1, true),
      (view) => view.setUint32(22, view.getUint32(22, true) + 1, true),
      (_view, bytes) => {
        bytes[30] = "b".charCodeAt(0);
      }
    ];

    for (const mutate of mutations) {
      const changed = copyWithView(valid, mutate);
      expect(issuesOf(() => readZipArchive(changed))).toEqual([
        expect.objectContaining({ code: "not_a_zip_archive", path: "a.txt" })
      ]);
    }

    const invalidUtf8 = copyWithView(valid, (_view, bytes) => {
      bytes[30] = 0xff;
    });
    expect(issuesOf(() => readZipArchive(invalidUtf8))).toEqual([
      expect.objectContaining({ code: "not_a_zip_archive", path: "a.txt" })
    ]);
  });

  it("支持带签名或不带签名的数据描述区，并校验其中的校验值和大小", () => {
    for (const dataDescriptor of ["with-signature", "without-signature"] as const) {
      const valid = buildRawZip([
        {
          path: `${dataDescriptor}.txt`,
          content: encoder.encode("descriptor content"),
          dataDescriptor
        }
      ]);
      expect(readZipArchive(valid).has(`${dataDescriptor}.txt`)).toBe(true);
    }

    const descriptorBase = buildRawZip([
      {
        path: "mismatch.txt",
        content: encoder.encode("x"),
        compressionMethod: 0,
        dataDescriptor: "without-signature"
      }
    ]);
    for (const valueOffset of [0, 4, 8]) {
      const mismatched = copyWithView(descriptorBase, (view) => {
        const descriptorStart = 30 + encoder.encode("mismatch.txt").byteLength + 1;
        const offset = descriptorStart + valueOffset;
        view.setUint32(offset, view.getUint32(offset, true) ^ 1, true);
      });
      expect(issuesOf(() => readZipArchive(mismatched))).toEqual([
        expect.objectContaining({ code: "size_mismatch", path: "mismatch.txt" })
      ]);
    }
  });

  it("拒绝缺失、截断或与另一条本地记录重叠的数据描述区", () => {
    const missing = buildRawZip([
      {
        path: "missing.txt",
        content: encoder.encode("x"),
        compressionMethod: 0,
        flags: 0x0808
      }
    ]);
    expect(issuesOf(() => readZipArchive(missing))).toEqual([
      expect.objectContaining({ code: "not_a_zip_archive", path: "missing.txt" })
    ]);

    const truncated = buildRawZip([
      {
        path: "truncated.txt",
        content: encoder.encode("x"),
        compressionMethod: 0,
        dataDescriptor: "without-signature",
        dataDescriptorLength: 8
      }
    ]);
    expect(issuesOf(() => readZipArchive(truncated))).toEqual([
      expect.objectContaining({ code: "not_a_zip_archive", path: "truncated.txt" })
    ]);

    const secondContent = encoder.encode("123456789012345");
    const overlapping = copyWithView(
      buildRawZip([
        {
          path: "a",
          content: encoder.encode("x"),
          compressionMethod: 0,
          flags: 0x0808
        },
        { path: "b", content: secondContent, compressionMethod: 0 }
      ]),
      (view, bytes) => {
        const centralOffset = centralDirectoryOffsetOf(view, bytes);
        view.setUint32(centralOffset + 16, crc32Of(secondContent), true);
        view.setUint32(centralOffset + 20, 15, true);
        view.setUint32(centralOffset + 24, 15, true);
      }
    );
    expect(issuesOf(() => readZipArchive(overlapping))).toEqual([
      expect.objectContaining({ code: "not_a_zip_archive", path: "b" })
    ]);
  });

  it("拒绝越过中央目录或与另一条本地记录重叠的数据", () => {
    const crossing = copyWithView(
      buildRawZip([{ path: "a", content: encoder.encode("x"), compressionMethod: 0 }]),
      (view, bytes) => {
        const centralOffset = centralDirectoryOffsetOf(view, bytes);
        view.setUint32(18, 2, true);
        view.setUint32(22, 2, true);
        view.setUint32(centralOffset + 20, 2, true);
        view.setUint32(centralOffset + 24, 2, true);
      }
    );
    expect(issuesOf(() => readZipArchive(crossing))).toEqual([
      expect.objectContaining({ code: "not_a_zip_archive", path: "a" })
    ]);

    const overlapping = copyWithView(
      buildRawZip([
        { path: "a", content: encoder.encode("x"), compressionMethod: 0 },
        { path: "b", content: encoder.encode("y"), compressionMethod: 0 }
      ]),
      (view, bytes) => {
        const centralOffset = centralDirectoryOffsetOf(view, bytes);
        view.setUint32(18, 2, true);
        view.setUint32(22, 2, true);
        view.setUint32(centralOffset + 20, 2, true);
        view.setUint32(centralOffset + 24, 2, true);
      }
    );
    expect(issuesOf(() => readZipArchive(overlapping))).toEqual([
      expect.objectContaining({ code: "not_a_zip_archive", path: "b" })
    ]);

    const sharedLocalHeader = copyWithView(
      buildRawZip([
        { path: "a", content: encoder.encode("x"), compressionMethod: 0 },
        { path: "b", content: encoder.encode("y"), compressionMethod: 0 }
      ]),
      (view, bytes) => {
        const firstCentral = centralDirectoryOffsetOf(view, bytes);
        const secondCentral = nextCentralEntryOffset(view, firstCentral);
        view.setUint32(secondCentral + 42, 0, true);
      }
    );
    expect(issuesOf(() => readZipArchive(sharedLocalHeader))).toEqual([
      expect.objectContaining({ code: "not_a_zip_archive", path: "b" })
    ]);
  });

  it("在解压之前根据目录信息拒绝压缩炸弹", () => {
    const bomb = buildRawZip([
      {
        path: "bomb.bin",
        storedBytes: new Uint8Array(deflateRawSync(new Uint8Array(1024 * 1024))),
        declaredUncompressedSize: 1024 * 1024,
        declaredCrc32: crc32Of(new Uint8Array(1024 * 1024))
      }
    ]);
    const issues = issuesOf(() =>
      readZipArchive(bomb, { maxCompressionRatio: 50 })
    );
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((issue) => issue.code === "compression_ratio_too_high")).toBe(true);
  });

  it("实际内容与目录声称不符时拒绝，包括伪造小尺寸", () => {
    const real = encoder.encode("actual content that is longer than declared");
    const lying = buildRawZip([
      {
        path: "liar.txt",
        storedBytes: new Uint8Array(deflateRawSync(real)),
        declaredUncompressedSize: 4,
        declaredCrc32: crc32Of(real)
      }
    ]);
    expect(issuesOf(() => readZipArchive(lying))).toEqual([
      expect.objectContaining({ code: "size_mismatch", path: "liar.txt" })
    ]);

    const wrongCrc = buildRawZip([
      {
        path: "broken.txt",
        content: encoder.encode("content"),
        declaredCrc32: 0x12345678
      }
    ]);
    expect(issuesOf(() => readZipArchive(wrongCrc))).toEqual([
      expect.objectContaining({ code: "size_mismatch", path: "broken.txt" })
    ]);
  });

  it("拒绝嵌套压缩包和超过数量限制的包", () => {
    const inner = writeZipArchive([{ path: "inner.txt", content: encoder.encode("x") }]);
    const nested = buildRawZip([{ path: "nested.zip", content: inner }]);
    expect(issuesOf(() => readZipArchive(nested))).toEqual([
      expect.objectContaining({ code: "nested_archive", path: "nested.zip" })
    ]);

    const crowded = buildRawZip(
      Array.from({ length: 4 }, (_, index) => ({
        path: `file-${index}.txt`,
        content: encoder.encode(String(index))
      }))
    );
    expect(issuesOf(() => readZipArchive(crowded, { maxEntries: 3 }))).toEqual([
      expect.objectContaining({ code: "too_many_entries" })
    ]);
  });

  it("目录条目被接受但不产生文件内容", () => {
    const directoryWithContent = buildRawZip([
      {
        path: "folder/",
        content: encoder.encode("x"),
        compressionMethod: 0,
        externalAttributes: (0o040755 << 16) | 0x10
      }
    ]);
    expect(issuesOf(() => readZipArchive(directoryWithContent))).toEqual([
      expect.objectContaining({ code: "size_mismatch", path: "folder/" })
    ]);

    const withDirectory = buildRawZip([
      {
        path: "folder/",
        content: new Uint8Array(0),
        compressionMethod: 0,
        externalAttributes: (0o040755 << 16) | 0x10
      },
      { path: "folder/data.txt", content: encoder.encode("content") }
    ]);
    const archive = readZipArchive(withDirectory);
    expect(archive.list().map((entry) => entry.path)).toEqual(["folder/data.txt"]);
  });
});
