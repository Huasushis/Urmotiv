import { isSafeArchivePath } from "./schema";

export const archiveEntryKinds = ["file", "directory", "symlink", "device", "other"] as const;

export type ArchiveEntryKind = (typeof archiveEntryKinds)[number];

export interface ArchiveEntrySummary {
  readonly path: string;
  readonly kind: ArchiveEntryKind;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
}

export interface ArchiveSourceEntry extends ArchiveEntrySummary {
  readonly content?: Uint8Array;
}

export interface SafeArchiveEntry extends Omit<ArchiveEntrySummary, "kind"> {
  readonly kind: "file";
  readonly content: Uint8Array;
}

export interface ArchiveSummary {
  readonly entries: readonly ArchiveEntrySummary[];
  readonly compressedSize: number;
  readonly uncompressedSize: number;
}

export interface ArchiveSafetyLimits {
  readonly maxEntries: number;
  readonly maxPathDepth: number;
  readonly maxPathLength: number;
  readonly maxSingleFileBytes: number;
  readonly maxTotalUncompressedBytes: number;
  readonly maxCompressionRatio: number;
  readonly allowNestedArchives: boolean;
}

export const defaultArchiveSafetyLimits: ArchiveSafetyLimits = {
  maxEntries: 10_000,
  maxPathDepth: 16,
  maxPathLength: 240,
  maxSingleFileBytes: 128 * 1024 * 1024,
  maxTotalUncompressedBytes: 1024 * 1024 * 1024,
  maxCompressionRatio: 200,
  allowNestedArchives: false
};

export type ArchiveIssueSeverity = "error" | "warning";

export interface ArchiveIssue {
  readonly severity: ArchiveIssueSeverity;
  readonly code:
    | "invalid_path"
    | "unsupported_entry_type"
    | "duplicate_path"
    | "case_collision"
    | "path_conflict"
    | "too_many_entries"
    | "file_too_large"
    | "archive_too_large"
    | "compression_ratio_too_high"
    | "invalid_size"
    | "missing_content"
    | "size_mismatch"
    | "nested_archive"
    | "empty_file"
    | "not_a_zip_archive"
    | "unsupported_archive_feature";
  readonly path?: string;
  readonly message: string;
}

export interface ArchiveValidationResult {
  readonly summary: ArchiveSummary;
  readonly issues: readonly ArchiveIssue[];
  readonly isSafe: boolean;
}

export class UnsafeArchiveError extends Error {
  public readonly issues: readonly ArchiveIssue[];

  public constructor(issues: readonly ArchiveIssue[]) {
    super("题目包没有通过文件安全检查。");
    this.name = "UnsafeArchiveError";
    this.issues = issues;
  }
}

const safeArchiveConstructorToken = Symbol("safe-archive-constructor");

/**
 * This class represents an archive only after a ZIP reader has supplied entry
 * metadata and bytes and the safety checks have passed. ZIP readers must call
 * validateArchiveMetadata before extracting entries to disk.
 */
export class SafeArchive {
  readonly #entries: ReadonlyMap<string, SafeArchiveEntry>;
  readonly summary: ArchiveSummary;

  public constructor(entries: readonly SafeArchiveEntry[], token: symbol) {
    if (token !== safeArchiveConstructorToken) {
      throw new UnsafeArchiveError([
        {
          severity: "error",
          code: "unsupported_entry_type",
          message: "SafeArchive 只能由完整的文件安全检查创建。"
        }
      ]);
    }
    this.#entries = new Map(
      entries.map((entry) => [
        entry.path,
        Object.freeze({ ...entry, content: new Uint8Array(entry.content) })
      ])
    );
    this.summary = summarizeArchive(entries);
  }

  public list(): readonly SafeArchiveEntry[] {
    return [...this.#entries.values()].map((entry) => ({
      ...entry,
      content: new Uint8Array(entry.content)
    }));
  }

  public has(path: string): boolean {
    return this.#entries.has(path);
  }

  public read(path: string): Uint8Array | undefined {
    const entry = this.#entries.get(path);
    return entry === undefined ? undefined : new Uint8Array(entry.content);
  }
}

export function summarizeArchive(entries: readonly ArchiveEntrySummary[]): ArchiveSummary {
  let compressedSize = 0;
  let uncompressedSize = 0;

  for (const entry of entries) {
    compressedSize += Number.isSafeInteger(entry.compressedSize) ? entry.compressedSize : 0;
    uncompressedSize += Number.isSafeInteger(entry.uncompressedSize) ? entry.uncompressedSize : 0;
  }

  return {
    entries: entries.map((entry) => ({
      path: entry.path,
      kind: entry.kind,
      compressedSize: entry.compressedSize,
      uncompressedSize: entry.uncompressedSize
    })),
    compressedSize,
    uncompressedSize
  };
}

/**
 * Validates the central-directory information before a worker decompresses or
 * writes anything. Directory records are ignored after their path is checked;
 * symlinks, devices and other non-regular entries are always rejected.
 */
export function validateArchiveMetadata(
  entries: readonly ArchiveEntrySummary[],
  suppliedLimits: Partial<ArchiveSafetyLimits> = {}
): ArchiveValidationResult {
  const limits = resolveSafetyLimits(suppliedLimits);
  const issues: ArchiveIssue[] = [];
  if (entries.length > limits.maxEntries) {
    issues.push({
      severity: "error",
      code: "too_many_entries",
      message: "压缩包中的条目数量超过限制，目录也计入数量。"
    });
    // The archive is already rejected, so keep the failure preview bounded too.
    return {
      summary: summarizeArchive(entries.slice(0, limits.maxEntries)),
      issues,
      isSafe: false
    };
  }

  const exactPaths = new Set<string>();
  const foldedPaths = new Map<string, string>();
  const filePaths = new Set<string>();
  const parentPaths = new Set<string>();
  let totalUncompressed = 0;
  let totalCompressed = 0;

  for (const entry of entries) {
    if (typeof entry.path !== "string") {
      issues.push({
        severity: "error",
        code: "invalid_path",
        message: "压缩包中的文件路径不合法。"
      });
      continue;
    }
    const path = pathForValidation(entry);

    if (!hasValidSizes(entry)) {
      issues.push({
        severity: "error",
        code: "invalid_size",
        path: entry.path,
        message: "压缩包中的文件大小信息不合法。"
      });
      continue;
    }

    if (
      !isSafeArchivePath(path) ||
      path.length > limits.maxPathLength ||
      path.split("/").length > limits.maxPathDepth
    ) {
      issues.push({
        severity: "error",
        code: "invalid_path",
        path: entry.path,
        message: "压缩包包含不安全的文件路径。"
      });
      continue;
    }

    if (entry.kind !== "file" && entry.kind !== "directory") {
      issues.push({
        severity: "error",
        code: "unsupported_entry_type",
        path: entry.path,
        message: "压缩包只允许普通文件，不能包含链接、设备或其他特殊文件。"
      });
      continue;
    }

    if (exactPaths.has(path)) {
      issues.push({
        severity: "error",
        code: "duplicate_path",
        path,
        message: "压缩包中有重复的规范文件路径。"
      });
    }
    exactPaths.add(path);

    const folded = path.normalize("NFC").toLowerCase();
    const previous = foldedPaths.get(folded);
    if (previous !== undefined && previous !== path) {
      issues.push({
        severity: "error",
        code: "case_collision",
        path,
        message: "压缩包中有只靠大小写或 Unicode 形式不同的冲突路径。"
      });
    } else {
      foldedPaths.set(folded, path);
    }

    const parents = parentArchivePaths(folded);
    if (
      parents.some((parent) => filePaths.has(parent)) ||
      (entry.kind === "file" && parentPaths.has(folded))
    ) {
      issues.push({
        severity: "error",
        code: "path_conflict",
        path,
        message: "压缩包中的普通文件路径同时被当作目录使用。"
      });
    }
    for (const parent of parents) {
      parentPaths.add(parent);
    }
    if (entry.kind === "file") {
      filePaths.add(folded);
    }

    if (entry.kind === "directory") {
      continue;
    }

    totalUncompressed += entry.uncompressedSize;
    totalCompressed += entry.compressedSize;

    if (entry.uncompressedSize > limits.maxSingleFileBytes) {
      issues.push({
        severity: "error",
        code: "file_too_large",
        path,
        message: "压缩包中有超过单文件大小限制的文件。"
      });
    }

    const ratio = entry.uncompressedSize / Math.max(1, entry.compressedSize);
    if (
      entry.uncompressedSize > 0 &&
      (entry.compressedSize === 0 || ratio > limits.maxCompressionRatio)
    ) {
      issues.push({
        severity: "error",
        code: "compression_ratio_too_high",
        path,
        message: "压缩包中的文件压缩比例过高，可能消耗异常多的资源。"
      });
    }

    if (entry.uncompressedSize === 0) {
      issues.push({
        severity: "warning",
        code: "empty_file",
        path,
        message: "压缩包中有空文件，请确认这是预期内容。"
      });
    }
  }

  if (totalUncompressed > limits.maxTotalUncompressedBytes) {
    issues.push({
      severity: "error",
      code: "archive_too_large",
      message: "压缩包解压后的总大小超过限制。"
    });
  }

  const totalRatio = totalUncompressed / Math.max(1, totalCompressed);
  if (totalUncompressed > 0 && totalRatio > limits.maxCompressionRatio) {
    issues.push({
      severity: "error",
      code: "compression_ratio_too_high",
      message: "压缩包整体压缩比例过高，可能消耗异常多的资源。"
    });
  }

  const summary = summarizeArchive(entries);
  return { summary, issues, isSafe: !issues.some((issue) => issue.severity === "error") };
}

/**
 * Converts already-read regular files into an immutable archive. This is kept
 * separate from ZIP parsing so callers can reject dangerous metadata before
 * decompression and before any path reaches the file system.
 */
export function createSafeArchive(
  entries: readonly ArchiveSourceEntry[],
  suppliedLimits: Partial<ArchiveSafetyLimits> = {}
): SafeArchive {
  const metadata = validateArchiveMetadata(entries, suppliedLimits);
  if (!metadata.isSafe) {
    throw new UnsafeArchiveError(metadata.issues);
  }
  const limits = resolveSafetyLimits(suppliedLimits);
  const issues = [...metadata.issues];
  const safeEntries: SafeArchiveEntry[] = [];

  for (const entry of entries) {
    if (entry.kind === "directory") {
      continue;
    }
    if (entry.kind !== "file") {
      continue;
    }
    if (typeof entry.path !== "string") {
      continue;
    }

    const path = pathForValidation(entry);
    if (!(entry.content instanceof Uint8Array)) {
      issues.push({
        severity: "error",
        code: "missing_content",
        path,
        message: "文件安全检查后缺少文件内容。"
      });
      continue;
    }
    if (entry.content.byteLength !== entry.uncompressedSize) {
      issues.push({
        severity: "error",
        code: "size_mismatch",
        path,
        message: "文件实际大小与压缩包记录不一致。"
      });
      continue;
    }
    if (!limits.allowNestedArchives && looksLikeZip(entry.content)) {
      issues.push({
        severity: "error",
        code: "nested_archive",
        path,
        message: "题目包不允许包含嵌套压缩包。"
      });
      continue;
    }

    safeEntries.push({
      path,
      kind: "file",
      compressedSize: entry.compressedSize,
      uncompressedSize: entry.uncompressedSize,
      content: new Uint8Array(entry.content)
    });
  }

  if (issues.some((issue) => issue.severity === "error")) {
    throw new UnsafeArchiveError(issues);
  }

  return new SafeArchive(safeEntries, safeArchiveConstructorToken);
}

function pathForValidation(entry: ArchiveEntrySummary): string {
  if (entry.kind === "directory" && entry.path.endsWith("/")) {
    return entry.path.slice(0, -1);
  }
  return entry.path;
}

function parentArchivePaths(path: string): readonly string[] {
  const segments = path.split("/");
  const parents: string[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    parents.push(segments.slice(0, index).join("/"));
  }
  return parents;
}

function hasValidSizes(entry: ArchiveEntrySummary): boolean {
  return (
    Number.isSafeInteger(entry.compressedSize) &&
    Number.isSafeInteger(entry.uncompressedSize) &&
    entry.compressedSize >= 0 &&
    entry.uncompressedSize >= 0
  );
}

function looksLikeZip(content: Uint8Array): boolean {
  return (
    content.byteLength >= 4 &&
    content[0] === 0x50 &&
    content[1] === 0x4b &&
    ((content[2] === 0x03 && content[3] === 0x04) ||
      (content[2] === 0x05 && content[3] === 0x06) ||
      (content[2] === 0x07 && content[3] === 0x08))
  );
}

function resolveSafetyLimits(suppliedLimits: Partial<ArchiveSafetyLimits>): ArchiveSafetyLimits {
  const limits: ArchiveSafetyLimits = { ...defaultArchiveSafetyLimits, ...suppliedLimits };
  const positiveIntegers: readonly (keyof Pick<
    ArchiveSafetyLimits,
    | "maxEntries"
    | "maxPathDepth"
    | "maxPathLength"
    | "maxSingleFileBytes"
    | "maxTotalUncompressedBytes"
  >)[] = [
    "maxEntries",
    "maxPathDepth",
    "maxPathLength",
    "maxSingleFileBytes",
    "maxTotalUncompressedBytes"
  ];
  for (const key of positiveIntegers) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0) {
      throw new TypeError(`文件安全限制 ${key} 必须是正整数。`);
    }
  }
  if (!Number.isFinite(limits.maxCompressionRatio) || limits.maxCompressionRatio < 1) {
    throw new TypeError("文件安全限制 maxCompressionRatio 必须至少为 1。"
    );
  }
  if (typeof limits.allowNestedArchives !== "boolean") {
    throw new TypeError("文件安全限制 allowNestedArchives 必须是布尔值。"
    );
  }
  return limits;
}
