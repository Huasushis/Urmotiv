import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  UnsafeArchiveError,
  readZipArchive,
  writeZipArchive
} from "../src";

const encoder = new TextEncoder();

function issuesOf(run: () => unknown): readonly { code: string; path?: string }[] {
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

    const local = new Uint8Array(30 + nameBytes.byteLength);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, entry.flags ?? 0x0800, true);
    localView.setUint16(8, method, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, stored.byteLength, true);
    localView.setUint32(22, declaredSize, true);
    localView.setUint16(26, nameBytes.byteLength, true);
    local.set(nameBytes, 30);

    const central = new Uint8Array(46 + nameBytes.byteLength);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 0x031e, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, entry.flags ?? 0x0800, true);
    centralView.setUint16(10, method, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, stored.byteLength, true);
    centralView.setUint32(24, declaredSize, true);
    centralView.setUint16(28, nameBytes.byteLength, true);
    centralView.setUint32(38, entry.externalAttributes ?? 0o100644 << 16, true);
    centralView.setUint32(42, offset, true);
    central.set(nameBytes, 46);

    localParts.push(local, stored);
    centralParts.push(central);
    offset += local.byteLength + stored.byteLength;
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

  it("拒绝不是 ZIP 的内容和被截断的包", () => {
    expect(issuesOf(() => readZipArchive(encoder.encode("plain text")))).toEqual([
      expect.objectContaining({ code: "not_a_zip_archive" })
    ]);
    const valid = writeZipArchive([{ path: "a.txt", content: encoder.encode("hello") }]);
    expect(issuesOf(() => readZipArchive(valid.subarray(0, valid.byteLength - 30)))).toEqual([
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
    const encrypted = buildRawZip([
      { path: "secret.txt", content: encoder.encode("x"), flags: 0x0801 }
    ]);
    expect(issuesOf(() => readZipArchive(encrypted))).toEqual([
      expect.objectContaining({ code: "unsupported_archive_feature" })
    ]);

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
