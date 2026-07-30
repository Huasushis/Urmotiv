import { describe, expect, it } from "vitest";
import {
  UnsafeArchiveError,
  readProblemPackageInput,
  singleFileProblemPackagePath,
  writeZipArchive
} from "../src";

const encoder = new TextEncoder();

function issuesOf(
  run: () => unknown
): readonly { readonly code: string; readonly path?: string; readonly message: string }[] {
  try {
    run();
  } catch (error) {
    if (error instanceof UnsafeArchiveError) {
      return error.issues;
    }
    throw error;
  }
  throw new Error("预期文件安全检查失败，但读取成功。");
}

describe("problem package input", () => {
  it("保留旧 ZIP 文件名行为并明确标记 ZIP", () => {
    const bytes = writeZipArchive([
      { path: "manifest.yaml", content: encoder.encode("format: example\n") }
    ]);
    const input = readProblemPackageInput({
      originalName: "旧系统导出的文件.data",
      content: bytes
    });

    expect(input.kind).toBe("zip");
    expect(input.mediaType).toBe("application/zip");
    expect(input.archive.has("manifest.yaml")).toBe(true);
  });

  it("只把带 XML 文件头的 .xml 文件放进固定安全路径", () => {
    const original = encoder.encode("\ufeff \n<?xml version=\"1.0\"?><fps />");
    const input = readProblemPackageInput({
      originalName: "可能包含题目名称.XML",
      content: original
    });

    expect(input.kind).toBe("single_file");
    expect(input.mediaType).toBe("application/xml");
    expect(input.archive.list().map((entry) => entry.path)).toEqual([
      singleFileProblemPackagePath
    ]);
    expect(input.archive.summary.entries).not.toContainEqual(
      expect.objectContaining({ path: "可能包含题目名称.XML" })
    );

    original.fill(0);
    expect(new TextDecoder().decode(input.archive.read(singleFileProblemPackagePath))).toContain(
      "<fps />"
    );
  });

  it("拒绝把完整或截断的 ZIP 政名为 XML", () => {
    const complete = writeZipArchive([
      { path: "problem.xml", content: encoder.encode("<fps />") }
    ]);
    const truncated = complete.subarray(0, 8);
    const xmlPrefix = encoder.encode("<?xml version=\"1.0\"?><fps>");
    const prefixedTruncated = new Uint8Array(xmlPrefix.byteLength + truncated.byteLength);
    prefixedTruncated.set(xmlPrefix);
    prefixedTruncated.set(truncated, xmlPrefix.byteLength);

    for (const content of [complete, truncated, prefixedTruncated]) {
      expect(
        issuesOf(() =>
          readProblemPackageInput({ originalName: "problem.xml", content })
        )
      ).toEqual([expect.objectContaining({ code: "input_type_mismatch" })]);
    }
  });

  it("XML 改成其他扩展名、其他内容和损坏 ZIP 都不会回退猜测", () => {
    const xml = encoder.encode("<?xml version=\"1.0\"?><fps />");
    const validZip = writeZipArchive([
      { path: "manifest.yaml", content: encoder.encode("format: example\n") }
    ]);
    const inputs = [
      { originalName: "problem.zip", content: xml },
      { originalName: "problem.txt", content: encoder.encode("plain text") },
      {
        originalName: "problem.zip",
        content: validZip.subarray(0, validZip.byteLength - 12)
      }
    ];

    for (const input of inputs) {
      expect(issuesOf(() => readProblemPackageInput(input))).toEqual([
        expect.objectContaining({ code: "not_a_zip_archive" })
      ]);
    }
  });

  it("拒绝文件头看似 XML 但后续不是严格 UTF-8 的内容", () => {
    const prefix = encoder.encode("<?xml version=\"1.0\"?><fps>");
    const suffix = encoder.encode("</fps>");
    const invalid = new Uint8Array(prefix.byteLength + 1 + suffix.byteLength);
    invalid.set(prefix);
    invalid[prefix.byteLength] = 0xff;
    invalid.set(suffix, prefix.byteLength + 1);

    expect(
      issuesOf(() =>
        readProblemPackageInput({
          originalName: "problem.xml",
          content: invalid
        })
      )
    ).toEqual([expect.objectContaining({ code: "not_an_xml_file" })]);
  });

  it("在检查 XML 文件头前先应用原始文件大小限制", () => {
    expect(
      issuesOf(() =>
        readProblemPackageInput(
          {
            originalName: "problem.xml",
            content: encoder.encode("<?xml version=\"1.0\"?><fps />")
          },
          { maxArchiveBytes: 8 }
        )
      )
    ).toEqual([expect.objectContaining({ code: "archive_too_large" })]);
  });
});
