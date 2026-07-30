import { createHash } from "node:crypto";
import { SafeArchive } from "./archive";
import { isSafeArchivePath } from "./schema";

export const checksumFilePath = "checksums.sha256";

export interface ChecksumEntry {
  readonly path: string;
  readonly sha256: string;
}

export class ChecksumValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ChecksumValidationError";
  }
}

export function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export function renderChecksums(entries: readonly ChecksumEntry[]): string {
  const seen = new Set<string>();
  const lines = [...entries]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((entry) => {
      if (!isSafeArchivePath(entry.path) || entry.path === checksumFilePath) {
        throw new ChecksumValidationError("校验值文件中有不允许的路径。");
      }
      if (!/^[a-f0-9]{64}$/.test(entry.sha256)) {
        throw new ChecksumValidationError("校验值不是 SHA-256 十六进制字符串。");
      }
      if (seen.has(entry.path)) {
        throw new ChecksumValidationError("校验值文件中有重复路径。");
      }
      seen.add(entry.path);
      return `${entry.sha256}  ${entry.path}`;
    });

  return `${lines.join("\n")}\n`;
}

export function parseChecksums(content: Uint8Array): readonly ChecksumEntry[] {
  const text = decodeUtf8(content, "校验值文件不是 UTF-8 文本。");
  const lines = text.split("\n");
  const entries: ChecksumEntry[] = [];
  const seen = new Set<string>();

  for (const rawLine of lines) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0) {
      continue;
    }
    const match = /^([a-f0-9]{64})  (.+)$/i.exec(line);
    if (match === null) {
      throw new ChecksumValidationError("校验值文件格式不正确。");
    }

    const sha256Value = match[1]?.toLowerCase();
    const path = match[2];
    if (
      sha256Value === undefined ||
      path === undefined ||
      !isSafeArchivePath(path) ||
      path === checksumFilePath
    ) {
      throw new ChecksumValidationError("校验值文件中有不安全的路径。");
    }
    if (seen.has(path)) {
      throw new ChecksumValidationError("校验值文件中有重复路径。");
    }
    seen.add(path);
    entries.push({ path, sha256: sha256Value });
  }

  return entries;
}

/**
 * Checks every file before package content is parsed. The checksum file itself
 * is intentionally excluded because it cannot contain its own stable digest.
 */
export function verifyArchiveChecksums(archive: SafeArchive): void {
  const checksumContent = archive.read(checksumFilePath);
  if (checksumContent === undefined) {
    throw new ChecksumValidationError("题目包缺少 checksums.sha256。");
  }

  const listed = parseChecksums(checksumContent);
  const listedByPath = new Map(listed.map((entry) => [entry.path, entry.sha256]));
  const actualEntries = archive.list().filter((entry) => entry.path !== checksumFilePath);

  if (listedByPath.size !== actualEntries.length) {
    throw new ChecksumValidationError("校验值文件没有完整列出题目包中的文件。");
  }

  for (const entry of actualEntries) {
    const expected = listedByPath.get(entry.path);
    if (expected === undefined) {
      throw new ChecksumValidationError("校验值文件缺少题目包中的文件。");
    }
    if (sha256(entry.content) !== expected) {
      throw new ChecksumValidationError("题目包中的文件与校验值不一致。 ");
    }
  }

  for (const entry of listed) {
    if (!archive.has(entry.path)) {
      throw new ChecksumValidationError("校验值文件引用了不存在的文件。 ");
    }
  }
}

export function checksumsForFiles(
  files: ReadonlyMap<string, Uint8Array>
): readonly ChecksumEntry[] {
  return [...files.entries()].map(([path, content]) => ({ path, sha256: sha256(content) }));
}

export function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function decodeUtf8(content: Uint8Array, message: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content);
  } catch {
    throw new ChecksumValidationError(message);
  }
}
