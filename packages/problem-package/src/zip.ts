import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";
import {
  SafeArchive,
  UnsafeArchiveError,
  createSafeArchive,
  validateArchiveMetadata,
  type ArchiveEntryKind,
  type ArchiveEntrySummary,
  type ArchiveSafetyLimits,
  type ArchiveSourceEntry
} from "./archive";
import type { GeneratedArchiveFile } from "./adapter";

/**
 * 这里只使用 Node 自带的 zlib：解析压缩包目录由本文件完成，因此可以在解压任何数据前
 * 拒绝符号链接、加密、分卷、zip64 和明显撒谎的大小信息；解压时再用输出上限挡住
 * “小包解出超大内容”的压缩炸弹。
 */

const endOfCentralDirectorySignature = 0x06054b50;
const centralDirectoryEntrySignature = 0x02014b50;
const localFileHeaderSignature = 0x04034b50;
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
  readonly kind: ArchiveEntryKind;
  readonly compressionMethod: number;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
}

function rejected(
  code: "not_a_zip_archive" | "unsupported_archive_feature" | "size_mismatch",
  message: string,
  path?: string
): UnsafeArchiveError {
  return new UnsafeArchiveError([
    { severity: "error", code, message, ...(path === undefined ? {} : { path }) }
  ]);
}

/** 把整个 ZIP 字节读成经过全部安全检查的内存包。 */
export function readZipArchive(
  bytes: Uint8Array,
  limits: Partial<ArchiveSafetyLimits> = {}
): SafeArchive {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endRecord = findEndOfCentralDirectory(bytes, view);
  const entries = parseCentralDirectory(bytes, view, endRecord);

  const summaries: ArchiveEntrySummary[] = entries.map((entry) => ({
    path: entry.path,
    kind: entry.kind,
    compressedSize: entry.compressedSize,
    uncompressedSize: entry.uncompressedSize
  }));
  const metadata = validateArchiveMetadata(summaries, limits);
  if (!metadata.isSafe) {
    throw new UnsafeArchiveError(metadata.issues);
  }

  const sources: ArchiveSourceEntry[] = [];
  for (const [index, entry] of entries.entries()) {
    const summary = summaries[index];
    if (summary === undefined) {
      throw rejected("not_a_zip_archive", "压缩包目录读取不完整。");
    }
    if (entry.kind !== "file") {
      sources.push(summary);
      continue;
    }
    sources.push({ ...summary, content: extractFileContent(bytes, view, entry) });
  }

  return createSafeArchive(sources, limits);
}

/** 把已经过路径检查的文件列表打成一个 ZIP。 */
export function writeZipArchive(files: readonly GeneratedArchiveFile[]): Uint8Array {
  if (files.length >= zip64MarkerU16) {
    throw new Error("生成的压缩包条目数量超出支持范围。");
  }

  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.path);
    if (nameBytes.byteLength >= zip64MarkerU16) {
      throw new Error("生成的压缩包中有过长的文件路径。");
    }
    const content = file.content;
    const deflated = deflateRawSync(content);
    const useStore = deflated.byteLength >= content.byteLength;
    const stored = useStore ? content : new Uint8Array(deflated);
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

    localParts.push(localHeader, stored);
    centralParts.push(centralHeader);
    localOffset += localHeader.byteLength + stored.byteLength;
  }

  const centralSize = centralParts.reduce((total, part) => total + part.byteLength, 0);
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
  endRecord: EndOfCentralDirectory
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

    if ((flags & 0x0001) !== 0 || (flags & 0x0040) !== 0) {
      throw rejected("unsupported_archive_feature", "不支持加密的压缩包。");
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
    if (nameStart + nameLength > directoryEnd) {
      throw rejected("not_a_zip_archive", "压缩包目录不完整，文件可能已损坏。");
    }
    let path: string;
    try {
      path = utf8.decode(bytes.subarray(nameStart, nameStart + nameLength));
    } catch {
      throw rejected("not_a_zip_archive", "压缩包中的文件名不是有效的 UTF-8 文本。");
    }

    const kind = entryKindOf(path, externalAttributes);
    if (kind === "file" && compressionMethod !== 0 && compressionMethod !== 8) {
      throw rejected(
        "unsupported_archive_feature",
        "压缩包使用了不支持的压缩方式。",
        path
      );
    }

    entries.push({
      path,
      kind,
      compressionMethod,
      crc32: checksum,
      compressedSize,
      uncompressedSize,
      localHeaderOffset
    });
    cursor = nameStart + nameLength + extraLength + commentLength;
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

function extractFileContent(
  bytes: Uint8Array,
  view: DataView,
  entry: CentralDirectoryEntry
): Uint8Array {
  const headerOffset = entry.localHeaderOffset;
  if (headerOffset + 30 > bytes.byteLength) {
    throw rejected("not_a_zip_archive", "压缩包数据不完整，文件可能已损坏。", entry.path);
  }
  if (view.getUint32(headerOffset, true) !== localFileHeaderSignature) {
    throw rejected("not_a_zip_archive", "压缩包数据位置不正确，文件可能已损坏。", entry.path);
  }
  const nameLength = view.getUint16(headerOffset + 26, true);
  const extraLength = view.getUint16(headerOffset + 28, true);
  const dataStart = headerOffset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > bytes.byteLength) {
    throw rejected("not_a_zip_archive", "压缩包数据不完整，文件可能已损坏。", entry.path);
  }

  const compressed = bytes.subarray(dataStart, dataEnd);
  let content: Uint8Array;
  if (entry.compressionMethod === 0) {
    content = new Uint8Array(compressed);
  } else {
    try {
      content = new Uint8Array(
        inflateRawSync(compressed, {
          maxOutputLength: Math.max(1, entry.uncompressedSize)
        })
      );
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
