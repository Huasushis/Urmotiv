import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";
import {
  SafeArchive,
  UnsafeArchiveError,
  createSafeArchive,
  defaultArchiveSafetyLimits,
  looksLikeZipArchive,
  validateArchiveMetadata,
  type ArchiveEntryKind,
  type ArchiveEntrySummary,
  type ArchiveSafetyLimits,
  type ArchiveSourceEntry
} from "./archive";
import type { GeneratedArchiveFile } from "./adapter";
import { isSafeArchivePath } from "./schema";

/**
 * 这里只使用 Node 自带的 zlib：解析压缩包目录由本文件完成，因此可以在解压任何数据前
 * 拒绝符号链接、加密、分卷、zip64 和明显撒谎的大小信息；解压时再用输出上限挡住
 * “小包解出超大内容”的压缩炸弹。
 */

const endOfCentralDirectorySignature = 0x06054b50;
const centralDirectoryEntrySignature = 0x02014b50;
const localFileHeaderSignature = 0x04034b50;
const dataDescriptorSignature = 0x08074b50;
const encryptedFlagMask = 0x2041;
const commonSupportedFlagMask = 0x0808;
const deflateOptionFlagMask = 0x0006;
/** EOCD 固定 22 字节，注释最长 65535 字节，所以只需要向前扫描这么多。 */
const maximumEndRecordScanBytes = 22 + 65_535;
const zip64MarkerU16 = 0xffff;
const zip64MarkerU32 = 0xffffffff;
/** 生成的包使用固定时间戳（2026-01-01 00:00:00），保证同样内容得到同样的字节。 */
const fixedDosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;
const fixedDosTime = 0;

interface EndOfCentralDirectory {
  readonly entryCount: number;
  readonly centralDirectoryOffset: number;
  readonly centralDirectorySize: number;
}

interface CentralDirectoryEntry {
  readonly path: string;
  readonly nameBytes: Uint8Array;
  readonly kind: ArchiveEntryKind;
  readonly flags: number;
  readonly compressionMethod: number;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
}

interface LocalFileRecord {
  readonly entry: CentralDirectoryEntry;
  readonly dataStart: number;
  readonly dataEnd: number;
  readonly recordEnd: number;
}

function rejected(
  code:
    | "archive_too_large"
    | "invalid_path"
    | "nested_archive"
    | "not_a_zip_archive"
    | "size_mismatch"
    | "too_many_entries"
    | "unsupported_archive_feature",
  message: string,
  path?: string
): UnsafeArchiveError {
  return new UnsafeArchiveError([
    { severity: "error", code, message, ...(path === undefined ? {} : { path }) }
  ]);
}

function resolveArchiveLimits(limits: Partial<ArchiveSafetyLimits>): ArchiveSafetyLimits {
  const resolved: ArchiveSafetyLimits = {
    ...defaultArchiveSafetyLimits,
    ...limits
  };
  // Reuse the common validation without parsing or allocating archive entries.
  validateArchiveMetadata([], resolved);
  return resolved;
}

/** 把整个 ZIP 字节读成经过全部安全检查的内存包。 */
export function readZipArchive(
  bytes: Uint8Array,
  limits: Partial<ArchiveSafetyLimits> = {}
): SafeArchive {
  const resolvedLimits = resolveArchiveLimits(limits);
  if (bytes.byteLength > resolvedLimits.maxArchiveBytes) {
    throw rejected("archive_too_large", "压缩包原始大小超过限制。");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endRecord = findEndOfCentralDirectory(bytes, view);
  if (endRecord.entryCount > resolvedLimits.maxEntries) {
    throw rejected("too_many_entries", "压缩包中的条目数量超过限制，目录也计入数量。");
  }
  const entries = parseCentralDirectory(bytes, view, endRecord, resolvedLimits);

  const summaries: ArchiveEntrySummary[] = entries.map((entry) => ({
    path: entry.path,
    kind: entry.kind,
    compressedSize: entry.compressedSize,
    uncompressedSize: entry.uncompressedSize
  }));
  const metadata = validateArchiveMetadata(summaries, resolvedLimits);
  if (!metadata.isSafe) {
    throw new UnsafeArchiveError(metadata.issues);
  }
  const localRecords = validateLocalFileRecords(bytes, view, entries, endRecord);

  const sources: ArchiveSourceEntry[] = [];
  for (const [index, entry] of entries.entries()) {
    const summary = summaries[index];
    const localRecord = localRecords[index];
    if (summary === undefined) {
      throw rejected("not_a_zip_archive", "压缩包目录读取不完整。");
    }
    if (localRecord === undefined) {
      throw rejected("not_a_zip_archive", "压缩包数据读取不完整。");
    }
    if (entry.kind !== "file") {
      sources.push(summary);
      continue;
    }
    sources.push({ ...summary, content: extractFileContent(bytes, entry, localRecord) });
  }

  return createSafeArchive(sources, resolvedLimits);
}

/**
 * 把已经过路径检查的文件列表打成一个 ZIP。读取和写出可共用同一组安全限制；
 * 多题导出外层包需要嵌套单题 ZIP 时，读取外层包也必须显式允许嵌套包。
 */
export function writeZipArchive(
  files: readonly GeneratedArchiveFile[],
  limits: Partial<ArchiveSafetyLimits> = {}
): Uint8Array {
  const resolvedLimits = resolveArchiveLimits(limits);
  if (files.length > resolvedLimits.maxEntries) {
    throw rejected("too_many_entries", "生成的压缩包条目数量超过限制。");
  }
  if (files.length >= zip64MarkerU16) {
    throw new Error("生成的压缩包条目数量超出支持范围。");
  }

  const inputSummaries: ArchiveEntrySummary[] = files.map((file) => ({
    path: file.path,
    kind: "file",
    compressedSize: file.content.byteLength,
    uncompressedSize: file.content.byteLength
  }));
  const inputMetadata = validateArchiveMetadata(inputSummaries, resolvedLimits);
  if (!inputMetadata.isSafe) {
    throw new UnsafeArchiveError(inputMetadata.issues);
  }
  if (!resolvedLimits.allowNestedArchives) {
    for (const file of files) {
      if (looksLikeZipArchive(file.content)) {
        throw rejected("nested_archive", "生成的压缩包不能包含嵌套压缩包。", file.path);
      }
    }
  }

  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  const outputSummaries: ArchiveEntrySummary[] = [];
  let localOffset = 0;
  let centralSize = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.path);
    if (nameBytes.byteLength >= zip64MarkerU16) {
      throw new Error("生成的压缩包中有过长的文件路径。");
    }
    const content = file.content;
    const deflated = deflateRawSync(content);
    const deflatedRatio = content.byteLength / Math.max(1, deflated.byteLength);
    const useStore =
      deflated.byteLength >= content.byteLength ||
      deflatedRatio > resolvedLimits.maxCompressionRatio;
    const stored = useStore ? content : deflated;
    const method = useStore ? 0 : 8;
    const checksum = crc32(content) >>> 0;
    if (
      content.byteLength >= zip64MarkerU32 ||
      stored.byteLength >= zip64MarkerU32 ||
      localOffset >= zip64MarkerU32
    ) {
      throw new Error("生成的压缩包超出支持的大小范围。");
    }

    const localHeader = new Uint8Array(30 + nameBytes.byteLength);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, localFileHeaderSignature, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, method, true);
    localView.setUint16(10, fixedDosTime, true);
    localView.setUint16(12, fixedDosDate, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, stored.byteLength, true);
    localView.setUint32(22, content.byteLength, true);
    localView.setUint16(26, nameBytes.byteLength, true);
    localView.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);

    const centralHeader = new Uint8Array(46 + nameBytes.byteLength);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, centralDirectoryEntrySignature, true);
    centralView.setUint16(4, 0x031e, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, method, true);
    centralView.setUint16(12, fixedDosTime, true);
    centralView.setUint16(14, fixedDosDate, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, stored.byteLength, true);
    centralView.setUint32(24, content.byteLength, true);
    centralView.setUint16(28, nameBytes.byteLength, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0o100644 << 16, true);
    centralView.setUint32(42, localOffset, true);
    centralHeader.set(nameBytes, 46);

    const nextLocalOffset = localOffset + localHeader.byteLength + stored.byteLength;
    const nextCentralSize = centralSize + centralHeader.byteLength;
    if (nextLocalOffset + nextCentralSize + 22 > resolvedLimits.maxArchiveBytes) {
      throw rejected("archive_too_large", "生成的压缩包原始大小超过限制。");
    }
    localParts.push(localHeader, stored);
    centralParts.push(centralHeader);
    outputSummaries.push({
      path: file.path,
      kind: "file",
      compressedSize: stored.byteLength,
      uncompressedSize: content.byteLength
    });
    localOffset = nextLocalOffset;
    centralSize = nextCentralSize;
  }

  const outputMetadata = validateArchiveMetadata(outputSummaries, resolvedLimits);
  if (!outputMetadata.isSafe) {
    throw new UnsafeArchiveError(outputMetadata.issues);
  }
  if (localOffset >= zip64MarkerU32 || centralSize >= zip64MarkerU32) {
    throw new Error("生成的压缩包超出支持的大小范围。");
  }
  const endRecord = new Uint8Array(22);
  const endView = new DataView(endRecord.buffer);
  endView.setUint32(0, endOfCentralDirectorySignature, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, localOffset, true);
  endView.setUint16(20, 0, true);

  const totalLength = localOffset + centralSize + endRecord.byteLength;
  if (totalLength > resolvedLimits.maxArchiveBytes) {
    throw rejected("archive_too_large", "生成的压缩包原始大小超过限制。");
  }
  const archive = new Uint8Array(totalLength);
  let cursor = 0;
  for (const part of [...localParts, ...centralParts, endRecord]) {
    archive.set(part, cursor);
    cursor += part.byteLength;
  }
  return archive;
}

function findEndOfCentralDirectory(bytes: Uint8Array, view: DataView): EndOfCentralDirectory {
  if (bytes.byteLength < 22) {
    throw rejected("not_a_zip_archive", "这个文件不是 ZIP 压缩包。");
  }

  const scanStart = Math.max(0, bytes.byteLength - maximumEndRecordScanBytes);
  for (let offset = bytes.byteLength - 22; offset >= scanStart; offset -= 1) {
    if (view.getUint32(offset, true) !== endOfCentralDirectorySignature) {
      continue;
    }
    const commentLength = view.getUint16(offset + 20, true);
    if (offset + 22 + commentLength !== bytes.byteLength) {
      continue;
    }

    const diskNumber = view.getUint16(offset + 4, true);
    const centralDirectoryDisk = view.getUint16(offset + 6, true);
    const entryCountOnDisk = view.getUint16(offset + 8, true);
    const entryCount = view.getUint16(offset + 10, true);
    const centralDirectorySize = view.getUint32(offset + 12, true);
    const centralDirectoryOffset = view.getUint32(offset + 16, true);

    if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entryCountOnDisk !== entryCount) {
      throw rejected("unsupported_archive_feature", "不支持分卷压缩包。");
    }
    if (
      entryCount === zip64MarkerU16 ||
      centralDirectorySize === zip64MarkerU32 ||
      centralDirectoryOffset === zip64MarkerU32
    ) {
      throw rejected("unsupported_archive_feature", "不支持 zip64 格式的压缩包。");
    }
    if (
      centralDirectoryOffset + centralDirectorySize > offset ||
      centralDirectoryOffset > bytes.byteLength
    ) {
      throw rejected("not_a_zip_archive", "压缩包目录位置不正确，文件可能已损坏。");
    }
    return { entryCount, centralDirectoryOffset, centralDirectorySize };
  }

  throw rejected("not_a_zip_archive", "这个文件不是 ZIP 压缩包。");
}

function parseCentralDirectory(
  bytes: Uint8Array,
  view: DataView,
  endRecord: EndOfCentralDirectory,
  limits: ArchiveSafetyLimits
): CentralDirectoryEntry[] {
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  const entries: CentralDirectoryEntry[] = [];
  let cursor = endRecord.centralDirectoryOffset;
  const directoryEnd = endRecord.centralDirectoryOffset + endRecord.centralDirectorySize;

  for (let index = 0; index < endRecord.entryCount; index += 1) {
    if (cursor + 46 > directoryEnd) {
      throw rejected("not_a_zip_archive", "压缩包目录不完整，文件可能已损坏。");
    }
    if (view.getUint32(cursor, true) !== centralDirectoryEntrySignature) {
      throw rejected("not_a_zip_archive", "压缩包目录内容不正确，文件可能已损坏。");
    }

    const flags = view.getUint16(cursor + 8, true);
    const compressionMethod = view.getUint16(cursor + 10, true);
    const checksum = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const diskStart = view.getUint16(cursor + 34, true);
    const externalAttributes = view.getUint32(cursor + 38, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);

    if ((flags & encryptedFlagMask) !== 0) {
      throw rejected("unsupported_archive_feature", "不支持加密的压缩包。");
    }
    const supportedFlags =
      commonSupportedFlagMask |
      (compressionMethod === 8 ? deflateOptionFlagMask : 0);
    if ((flags & ~supportedFlags) !== 0) {
      throw rejected("unsupported_archive_feature", "压缩包使用了不支持的功能标志。");
    }
    if (diskStart !== 0) {
      throw rejected("unsupported_archive_feature", "不支持分卷压缩包。");
    }
    if (
      compressedSize === zip64MarkerU32 ||
      uncompressedSize === zip64MarkerU32 ||
      localHeaderOffset === zip64MarkerU32
    ) {
      throw rejected("unsupported_archive_feature", "不支持 zip64 格式的压缩包。");
    }

    const nameStart = cursor + 46;
    const entryEnd = nameStart + nameLength + extraLength + commentLength;
    if (entryEnd > directoryEnd) {
      throw rejected("not_a_zip_archive", "压缩包目录不完整，文件可能已损坏。");
    }
    const nameBytes = bytes.subarray(nameStart, nameStart + nameLength);
    let path: string;
    try {
      path = utf8.decode(nameBytes);
    } catch {
      throw rejected("not_a_zip_archive", "压缩包中的文件名不是有效的 UTF-8 文本。");
    }

    const kind = entryKindOf(path, externalAttributes);
    const pathForSafety =
      kind === "directory" && path.endsWith("/") ? path.slice(0, -1) : path;
    if (
      !isSafeArchivePath(pathForSafety) ||
      pathForSafety.length > limits.maxPathLength ||
      pathForSafety.split("/").length > limits.maxPathDepth
    ) {
      throw rejected("invalid_path", "压缩包包含不安全的文件路径。");
    }
    if ((flags & 0x0800) === 0 && nameBytes.some((byte) => byte >= 0x80)) {
      throw rejected(
        "unsupported_archive_feature",
        "压缩包中的非 ASCII 文件名没有声明 UTF-8 编码。"
      );
    }
    if (kind === "directory" && (compressedSize !== 0 || uncompressedSize !== 0)) {
      throw rejected("size_mismatch", "压缩包中的目录不能声明文件内容。", path);
    }
    if (kind === "file" && compressionMethod !== 0 && compressionMethod !== 8) {
      throw rejected(
        "unsupported_archive_feature",
        "压缩包使用了不支持的压缩方式。",
        path
      );
    }

    entries.push({
      path,
      nameBytes: new Uint8Array(nameBytes),
      kind,
      flags,
      compressionMethod,
      crc32: checksum,
      compressedSize,
      uncompressedSize,
      localHeaderOffset
    });
    cursor = entryEnd;
  }

  if (cursor !== directoryEnd) {
    throw rejected("not_a_zip_archive", "压缩包目录长度与记录不一致，文件可能已损坏。");
  }

  return entries;
}

function entryKindOf(path: string, externalAttributes: number): ArchiveEntryKind {
  const unixMode = externalAttributes >>> 16;
  const unixType = unixMode & 0xf000;
  if (unixType === 0o120000) {
    return "symlink";
  }
  if (unixType === 0o040000 || path.endsWith("/") || (externalAttributes & 0x10) !== 0) {
    return "directory";
  }
  if (unixType !== 0 && unixType !== 0o100000) {
    return "device";
  }
  return "file";
}

function validateLocalFileRecords(
  bytes: Uint8Array,
  view: DataView,
  entries: readonly CentralDirectoryEntry[],
  endRecord: EndOfCentralDirectory
): LocalFileRecord[] {
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  const records = entries.map((entry): LocalFileRecord => {
    const headerOffset = entry.localHeaderOffset;
    if (headerOffset + 30 > endRecord.centralDirectoryOffset) {
      throw rejected(
        "not_a_zip_archive",
        "压缩包数据越过目录边界，文件可能已损坏。",
        entry.path
      );
    }
    if (view.getUint32(headerOffset, true) !== localFileHeaderSignature) {
      throw rejected(
        "not_a_zip_archive",
        "压缩包数据位置不正确，文件可能已损坏。",
        entry.path
      );
    }

    const flags = view.getUint16(headerOffset + 6, true);
    const compressionMethod = view.getUint16(headerOffset + 8, true);
    const checksum = view.getUint32(headerOffset + 14, true);
    const compressedSize = view.getUint32(headerOffset + 18, true);
    const uncompressedSize = view.getUint32(headerOffset + 22, true);
    const nameLength = view.getUint16(headerOffset + 26, true);
    const extraLength = view.getUint16(headerOffset + 28, true);
    const nameStart = headerOffset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (
      dataStart > endRecord.centralDirectoryOffset ||
      dataEnd > endRecord.centralDirectoryOffset
    ) {
      throw rejected(
        "not_a_zip_archive",
        "压缩包数据越过目录边界，文件可能已损坏。",
        entry.path
      );
    }

    const localNameBytes = bytes.subarray(nameStart, nameStart + nameLength);
    let localPath: string;
    try {
      localPath = utf8.decode(localNameBytes);
    } catch {
      throw rejected(
        "not_a_zip_archive",
        "压缩包本地记录中的文件名不是有效的 UTF-8 文本。",
        entry.path
      );
    }
    if (
      localPath !== entry.path ||
      !equalBytes(localNameBytes, entry.nameBytes) ||
      flags !== entry.flags ||
      compressionMethod !== entry.compressionMethod
    ) {
      throw rejected(
        "not_a_zip_archive",
        "压缩包本地记录与目录记录不一致，文件可能已损坏。",
        entry.path
      );
    }

    const usesDataDescriptor = (entry.flags & 0x0008) !== 0;
    const localSizesAreEmpty =
      checksum === 0 && compressedSize === 0 && uncompressedSize === 0;
    const localSizesMatch =
      checksum === entry.crc32 &&
      compressedSize === entry.compressedSize &&
      uncompressedSize === entry.uncompressedSize;
    if (usesDataDescriptor ? !localSizesAreEmpty && !localSizesMatch : !localSizesMatch) {
      throw rejected(
        "not_a_zip_archive",
        "压缩包本地记录与目录记录不一致，文件可能已损坏。",
        entry.path
      );
    }

    const recordEnd = usesDataDescriptor
      ? validateDataDescriptor(view, dataEnd, endRecord.centralDirectoryOffset, entry)
      : dataEnd;
    return { entry, dataStart, dataEnd, recordEnd };
  });

  const ordered = [...records].sort(
    (left, right) => left.entry.localHeaderOffset - right.entry.localHeaderOffset
  );
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      current.entry.localHeaderOffset < previous.recordEnd
    ) {
      throw rejected(
        "not_a_zip_archive",
        "压缩包中的文件区段相互重叠，文件可能已损坏。",
        current.entry.path
      );
    }
  }
  return records;
}

function validateDataDescriptor(
  view: DataView,
  descriptorStart: number,
  centralDirectoryOffset: number,
  entry: CentralDirectoryEntry
): number {
  if (descriptorStart + 12 > centralDirectoryOffset) {
    throw rejected(
      "not_a_zip_archive",
      "压缩包的数据描述区缺失或被截断。",
      entry.path
    );
  }

  if (
    view.getUint32(descriptorStart, true) === dataDescriptorSignature &&
    descriptorStart + 16 <= centralDirectoryOffset &&
    dataDescriptorMatches(view, descriptorStart + 4, entry)
  ) {
    return descriptorStart + 16;
  }
  if (dataDescriptorMatches(view, descriptorStart, entry)) {
    return descriptorStart + 12;
  }
  throw rejected(
    "size_mismatch",
    "压缩包的数据描述区与目录记录不一致。",
    entry.path
  );
}

function dataDescriptorMatches(
  view: DataView,
  valuesOffset: number,
  entry: CentralDirectoryEntry
): boolean {
  return (
    view.getUint32(valuesOffset, true) === entry.crc32 &&
    view.getUint32(valuesOffset + 4, true) === entry.compressedSize &&
    view.getUint32(valuesOffset + 8, true) === entry.uncompressedSize
  );
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function extractFileContent(
  bytes: Uint8Array,
  entry: CentralDirectoryEntry,
  record: LocalFileRecord
): Uint8Array {
  const compressed = bytes.subarray(record.dataStart, record.dataEnd);
  let content: Uint8Array;
  if (entry.compressionMethod === 0) {
    content = compressed;
  } else {
    try {
      content = inflateRawSync(compressed, {
        maxOutputLength: Math.max(1, entry.uncompressedSize)
      });
    } catch {
      throw rejected(
        "size_mismatch",
        "压缩包中的文件无法按记录的大小解压，可能是损坏或伪造的内容。",
        entry.path
      );
    }
  }

  if (content.byteLength !== entry.uncompressedSize) {
    throw rejected("size_mismatch", "文件实际大小与压缩包记录不一致。", entry.path);
  }
  if ((crc32(content) >>> 0) !== (entry.crc32 >>> 0)) {
    throw rejected("size_mismatch", "文件校验值与压缩包记录不一致。", entry.path);
  }
  return content;
}
