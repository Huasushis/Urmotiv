import {
  UnsafeArchiveError,
  createSafeArchive,
  defaultArchiveSafetyLimits,
  validateArchiveMetadata,
  type ArchiveSafetyLimits,
  type SafeArchive
} from "./archive";
import { readZipArchive } from "./zip";

export const problemPackageInputKinds = ["zip", "single_file"] as const;
export type ProblemPackageInputKind = (typeof problemPackageInputKinds)[number];

export const zipProblemPackageMediaType = "application/zip";
export const xmlProblemPackageMediaType = "application/xml";

/**
 * A single source file is deliberately given a fixed name before an adapter
 * sees it. The uploaded name is only used to choose the transport type and is
 * never exposed through SafeArchive.
 */
export const singleFileProblemPackagePath = "problem.xml";

export type SafeProblemPackageInput =
  | {
      readonly kind: "zip";
      readonly mediaType: typeof zipProblemPackageMediaType;
      readonly archive: SafeArchive;
    }
  | {
      readonly kind: "single_file";
      readonly mediaType: typeof xmlProblemPackageMediaType;
      readonly archive: SafeArchive;
    };

/**
 * Reads the two supported ways of carrying a problem package. The file name
 * chooses one branch and the bytes must pass that branch's own checks; this
 * function never tries the other branch after a failure.
 */
export function readProblemPackageInput(
  input: {
    readonly originalName: string;
    readonly content: Uint8Array;
  },
  suppliedLimits: Partial<ArchiveSafetyLimits> = {}
): SafeProblemPackageInput {
  validateArchiveMetadata([], suppliedLimits);
  const maximumArchiveBytes =
    suppliedLimits.maxArchiveBytes ?? defaultArchiveSafetyLimits.maxArchiveBytes;
  if (input.content.byteLength > maximumArchiveBytes) {
    throw rejected("archive_too_large", "题目包原始大小超过限制。");
  }
  const lowerName = input.originalName.toLowerCase();

  // Before single-file support, uploaded ZIP files were not required to use a
  // .zip suffix. Keep that behavior: only .xml selects the new branch.
  if (!lowerName.endsWith(".xml")) {
    return {
      kind: "zip",
      mediaType: zipProblemPackageMediaType,
      archive: readZipArchive(input.content, suppliedLimits)
    };
  }

  if (containsZipRecordSignature(input.content)) {
    throw rejected(
      "input_type_mismatch",
      "文件名表示 XML，但文件内容是 ZIP 压缩包。"
    );
  }
  if (!hasValidUtf8(input.content) || !looksLikeXmlDocument(input.content)) {
    throw rejected("not_an_xml_file", "这个文件不是可识别的 XML 文件。");
  }

  const archive = createSafeArchive(
    [
      {
        path: singleFileProblemPackagePath,
        kind: "file",
        compressedSize: input.content.byteLength,
        uncompressedSize: input.content.byteLength,
        content: input.content
      }
    ],
    suppliedLimits
  );
  return {
    kind: "single_file",
    mediaType: xmlProblemPackageMediaType,
    archive
  };
}

function containsZipRecordSignature(content: Uint8Array): boolean {
  for (let index = 0; index + 3 < content.byteLength; index += 1) {
    if (content[index] !== 0x50 || content[index + 1] !== 0x4b) {
      continue;
    }
    const third = content[index + 2];
    const fourth = content[index + 3];
    if (
      (third === 0x03 && fourth === 0x04) ||
      (third === 0x01 && fourth === 0x02) ||
      (third === 0x05 && fourth === 0x06) ||
      (third === 0x07 && fourth === 0x08) ||
      (third === 0x06 && (fourth === 0x06 || fourth === 0x07))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Checks UTF-8 without first allocating a second, potentially very large
 * JavaScript string. XML adapters still perform their own XML character and
 * structure checks.
 */
function hasValidUtf8(content: Uint8Array): boolean {
  for (let index = 0; index < content.byteLength; index += 1) {
    const first = content[index];
    if (first === undefined) return false;
    if (first <= 0x7f) continue;

    const second = content[index + 1];
    if (first >= 0xc2 && first <= 0xdf) {
      if (!isContinuationByte(second)) return false;
      index += 1;
      continue;
    }

    const third = content[index + 2];
    if (first === 0xe0) {
      if (
        second === undefined ||
        second < 0xa0 ||
        second > 0xbf ||
        !isContinuationByte(third)
      ) {
        return false;
      }
      index += 2;
      continue;
    }
    if (
      (first >= 0xe1 && first <= 0xec) ||
      (first >= 0xee && first <= 0xef)
    ) {
      if (!isContinuationByte(second) || !isContinuationByte(third)) return false;
      index += 2;
      continue;
    }
    if (first === 0xed) {
      if (
        second === undefined ||
        second < 0x80 ||
        second > 0x9f ||
        !isContinuationByte(third)
      ) {
        return false;
      }
      index += 2;
      continue;
    }

    const fourth = content[index + 3];
    if (first === 0xf0) {
      if (
        second === undefined ||
        second < 0x90 ||
        second > 0xbf ||
        !isContinuationByte(third) ||
        !isContinuationByte(fourth)
      ) {
        return false;
      }
      index += 3;
      continue;
    }
    if (first >= 0xf1 && first <= 0xf3) {
      if (
        !isContinuationByte(second) ||
        !isContinuationByte(third) ||
        !isContinuationByte(fourth)
      ) {
        return false;
      }
      index += 3;
      continue;
    }
    if (first === 0xf4) {
      if (
        second === undefined ||
        second < 0x80 ||
        second > 0x8f ||
        !isContinuationByte(third) ||
        !isContinuationByte(fourth)
      ) {
        return false;
      }
      index += 3;
      continue;
    }
    return false;
  }
  return true;
}

function isContinuationByte(value: number | undefined): boolean {
  return value !== undefined && value >= 0x80 && value <= 0xbf;
}

function looksLikeXmlDocument(content: Uint8Array): boolean {
  let cursor = 0;
  if (
    content.byteLength >= 3 &&
    content[0] === 0xef &&
    content[1] === 0xbb &&
    content[2] === 0xbf
  ) {
    cursor = 3;
  }
  while (cursor < content.byteLength && isXmlWhitespace(content[cursor])) {
    cursor += 1;
  }
  if (content[cursor] !== 0x3c) {
    return false;
  }

  const firstNameByte = content[cursor + 1];
  if (firstNameByte === undefined) {
    return false;
  }
  if (firstNameByte >= 0x80 || isAsciiNameStart(firstNameByte)) {
    return true;
  }
  if (firstNameByte === 0x3f) {
    return matchesAscii(content, cursor + 2, "xml");
  }
  if (firstNameByte === 0x21) {
    return (
      matchesAscii(content, cursor + 2, "--") ||
      matchesAscii(content, cursor + 2, "DOCTYPE")
    );
  }
  return false;
}

function isXmlWhitespace(value: number | undefined): boolean {
  return value === 0x20 || value === 0x09 || value === 0x0a || value === 0x0d;
}

function isAsciiNameStart(value: number): boolean {
  return (
    (value >= 0x41 && value <= 0x5a) ||
    (value >= 0x61 && value <= 0x7a) ||
    value === 0x3a ||
    value === 0x5f
  );
}

function matchesAscii(content: Uint8Array, start: number, expected: string): boolean {
  for (let index = 0; index < expected.length; index += 1) {
    if (content[start + index] !== expected.charCodeAt(index)) {
      return false;
    }
  }
  return true;
}

function rejected(
  code:
    | "archive_too_large"
    | "input_type_mismatch"
    | "not_an_xml_file"
    | "unsupported_input_type",
  message: string
): UnsafeArchiveError {
  return new UnsafeArchiveError([{ severity: "error", code, message }]);
}
