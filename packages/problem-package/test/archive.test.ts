import { describe, expect, it } from "vitest";
import {
  createSafeArchive,
  UnsafeArchiveError,
  validateArchiveMetadata,
  type ArchiveSourceEntry
} from "../src";

const text = new TextEncoder().encode("test");

function file(path: string, content: Uint8Array = text): ArchiveSourceEntry {
  return {
    path,
    kind: "file",
    compressedSize: content.byteLength,
    uncompressedSize: content.byteLength,
    content
  };
}

function directory(path: string): ArchiveSourceEntry {
  return {
    path,
    kind: "directory",
    compressedSize: 0,
    uncompressedSize: 0
  };
}

describe("archive safety", () => {
  it.each(["../secret", "/absolute", "C:/windows", "judge\\testdata\\001.in"])(
    "rejects unsafe path %s",
    (path) => {
      const result = validateArchiveMetadata([file(path)]);
      expect(result.isSafe).toBe(false);
      expect(result.issues.some((issue) => issue.code === "invalid_path")).toBe(true);
    }
  );

  it("rejects symlinks before reading content", () => {
    const result = validateArchiveMetadata([
      {
        path: "assets/link",
        kind: "symlink",
        compressedSize: 4,
        uncompressedSize: 4
      }
    ]);
    expect(result.isSafe).toBe(false);
    expect(result.issues.some((issue) => issue.code === "unsupported_entry_type")).toBe(true);
  });

  it("rejects duplicate and case-conflicting paths", () => {
    const result = validateArchiveMetadata([
      file("assets/a.png"),
      file("assets/a.png"),
      file("Assets/A.png")
    ]);
    expect(result.isSafe).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("duplicate_path");
    expect(result.issues.map((issue) => issue.code)).toContain("case_collision");
  });

  it("counts directory entries when applying the entry limit", () => {
    const result = validateArchiveMetadata(
      [directory("one/"), directory("two/"), directory("three/")],
      { maxEntries: 2 }
    );
    expect(result.isSafe).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(["too_many_entries"]);
    expect(result.summary.entries).toHaveLength(2);
  });

  it.each([
    [file("attachments/public/readme"), file("attachments/public/readme/image.png")],
    [file("attachments/public/readme/image.png"), file("attachments/public/readme")]
  ])("rejects a file path that is also another path's parent", (...entries) => {
    const result = validateArchiveMetadata(entries);
    expect(result.isSafe).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("path_conflict");
  });

  it("rejects excessive compression ratios before extraction", () => {
    const result = validateArchiveMetadata([
      {
        path: "judge/testdata/001.in",
        kind: "file",
        compressedSize: 1,
        uncompressedSize: 10_000
      }
    ], { maxCompressionRatio: 20 });
    expect(result.isSafe).toBe(false);
    expect(result.issues.some((issue) => issue.code === "compression_ratio_too_high")).toBe(true);
  });

  it("rejects a nested ZIP by its file signature", () => {
    const nestedZip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]);
    expect(() => createSafeArchive([file("attachments/public/nested.zip", nestedZip)])).toThrow(
      UnsafeArchiveError
    );
  });
});
