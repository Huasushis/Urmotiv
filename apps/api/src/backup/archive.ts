import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt,
} from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import { createGzip, createGunzip } from "node:zlib";
import { z } from "zod";
import { BackupError } from "./webdav";

const magic = Buffer.from("URMOTIV1");
const prefixLength = 36;
export const maximumBackupBytes = 20 * 1024 * 1024 * 1024;
export const backupManifestSchema = z
  .object({
    format: z.literal(1),
    createdAt: z.string().datetime(),
    schemaVersion: z.number().int().nonnegative(),
    secretKey: z.string().max(200),
    fileCount: z.number().int().min(0).max(1_000_000),
    kind: z.enum(["manual", "scheduled", "before-restore"]),
  })
  .strict();
export type BackupManifest = z.infer<typeof backupManifestSchema>;
export const backupFileSchema = z
  .object({
    id: z.string().uuid(),
    originalName: z.string().min(1).max(500),
    mediaType: z.string().min(3).max(255),
    byteSize: z.number().int().min(0).max(maximumBackupBytes),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    storageKey: z.string().min(1).max(1024),
  })
  .strict();
export type BackupFile = z.infer<typeof backupFileSchema>;
const entrySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("database"),
      bytes: z.number().int().positive().max(maximumBackupBytes),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
  z.object({ kind: z.literal("file"), file: backupFileSchema }).strict(),
  z.object({ kind: z.literal("end") }).strict(),
]);

function keyFor(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(
      password,
      salt,
      32,
      { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );
}
function header(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > 65_536)
    throw new BackupError("BACKUP_METADATA_INVALID", "备份目录记录超限。");
  const size = Buffer.alloc(4);
  size.writeUInt32BE(body.length);
  return Buffer.concat([size, body]);
}
export async function hashStream(
  source: AsyncIterable<Uint8Array>,
): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of source) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  return { sha256: hash.digest("hex"), bytes };
}
export async function writeBackupArchive(input: {
  target: string;
  password: string;
  manifest: BackupManifest;
  databaseFile: string;
  files: BackupFile[];
  openFile: (file: BackupFile) => Promise<AsyncIterable<Uint8Array>>;
  onFile?: (completed: number, total: number) => void;
}): Promise<void> {
  const manifest = backupManifestSchema.parse(input.manifest);
  if (manifest.fileCount !== input.files.length)
    throw new BackupError("BACKUP_METADATA_INVALID", "备份附件数量不一致。");
  const databaseHash = await hashStream(createReadStream(input.databaseFile));
  async function* records() {
    yield header(manifest);
    yield header({
      kind: "database",
      bytes: databaseHash.bytes,
      sha256: databaseHash.sha256,
    });
    yield* createReadStream(input.databaseFile);
    let completed = 0;
    for (const file of input.files) {
      backupFileSchema.parse(file);
      yield header({ kind: "file", file });
      const hash = createHash("sha256");
      let bytes = 0;
      for await (const chunk of await input.openFile(file)) {
        bytes += chunk.length;
        if (bytes > file.byteSize)
          throw new BackupError(
            "BACKUP_FILE_CHANGED",
            "附件在备份期间发生变化，本次备份未完成。",
          );
        hash.update(chunk);
        yield chunk;
      }
      if (bytes !== file.byteSize || hash.digest("hex") !== file.sha256)
        throw new BackupError(
          "BACKUP_FILE_CHANGED",
          "附件内容与数据库记录不一致，本次备份未完成。",
        );
      input.onFile?.(++completed, input.files.length);
    }
    yield header({ kind: "end" });
  }
  const salt = randomBytes(16),
    nonce = randomBytes(12),
    cipher = createCipheriv(
      "aes-256-gcm",
      await keyFor(input.password, salt),
      nonce,
    );
  const output = createWriteStream(input.target, { flags: "wx", mode: 0o600 });
  output.write(Buffer.concat([magic, salt, nonce]));
  let expanded = 0;
  const limit = new Transform({
    transform(chunk, encoding, callback) {
      expanded += chunk.length;
      callback(
        expanded > maximumBackupBytes - 1024 * 1024
          ? new BackupError(
              "BACKUP_TOO_LARGE",
              "完整备份超过当前支持的 20 GiB，请使用部署工具备份。",
            )
          : null,
        chunk,
      );
    },
  });
  try {
    await pipeline(
      Readable.from(records()),
      limit,
      createGzip(),
      cipher,
      output,
      { end: false },
    );
    output.end(cipher.getAuthTag());
    await finished(output);
  } catch (error) {
    output.destroy();
    throw error;
  }
}

export interface BackupEntry {
  offset: number;
  bytes: number;
  sha256: string;
  file?: BackupFile;
}
export interface OpenBackup {
  manifest: BackupManifest;
  plainFile: string;
  database: BackupEntry;
  files: BackupEntry[];
}

/** 先验证整个密文的认证标签，再读取目录；错误密码或截断文件不会进入数据库恢复。 */
export async function openBackupArchive(
  source: string,
  password: string,
  plainFile: string,
): Promise<OpenBackup> {
  const size = (await stat(source)).size;
  if (size <= prefixLength + 16 || size > maximumBackupBytes)
    throw new BackupError("BACKUP_INVALID", "备份文件格式或大小无效。");
  const handle = await open(source, "r");
  const prefix = Buffer.alloc(prefixLength),
    tag = Buffer.alloc(16);
  try {
    await handle.read(prefix, 0, prefix.length, 0);
    await handle.read(tag, 0, 16, size - 16);
  } finally {
    await handle.close();
  }
  if (!prefix.subarray(0, 8).equals(magic))
    throw new BackupError(
      "BACKUP_INVALID",
      "这不是受支持的 Urmotiv 完整备份。",
    );
  const decipher = createDecipheriv(
    "aes-256-gcm",
    await keyFor(password, prefix.subarray(8, 24)),
    prefix.subarray(24, 36),
  );
  decipher.setAuthTag(tag);
  let expanded = 0;
  const limit = new Transform({
    transform(chunk, encoding, callback) {
      expanded += chunk.length;
      callback(
        expanded > maximumBackupBytes
          ? new BackupError(
              "BACKUP_TOO_LARGE",
              "解压后备份超过服务器允许大小。",
            )
          : null,
        chunk,
      );
    },
  });
  try {
    await pipeline(
      createReadStream(source, { start: prefixLength, end: size - 17 }),
      decipher,
      createGunzip(),
      limit,
      createWriteStream(plainFile, { flags: "wx", mode: 0o600 }),
    );
  } catch (error) {
    if (error instanceof BackupError) throw error;
    throw new BackupError(
      "BACKUP_PASSWORD_OR_INTEGRITY",
      "备份密码错误，或文件不完整/已损坏。在线数据没有被替换。",
    );
  }
  return readBackupIndex(plainFile);
}

async function readBackupIndex(plainFile: string): Promise<OpenBackup> {
  const handle = await open(plainFile, "r"),
    size = (await handle.stat()).size;
  let offset = 0;
  async function readHeader(): Promise<unknown> {
    const prefix = Buffer.alloc(4);
    if ((await handle.read(prefix, 0, 4, offset)).bytesRead !== 4)
      throw Error();
    offset += 4;
    const count = prefix.readUInt32BE();
    if (count < 2 || count > 65536 || offset + count > size) throw Error();
    const json = Buffer.alloc(count);
    if ((await handle.read(json, 0, count, offset)).bytesRead !== count)
      throw Error();
    offset += count;
    return JSON.parse(json.toString("utf8"));
  }
  try {
    const manifest = backupManifestSchema.parse(await readHeader());
    let database: BackupEntry | undefined;
    const files: BackupEntry[] = [];
    const seen = new Set<string>();
    for (let index = 0; index <= manifest.fileCount + 1; index++) {
      const entry = entrySchema.parse(await readHeader());
      if (entry.kind === "end") {
        if (!database || files.length !== manifest.fileCount || offset !== size)
          throw Error();
        return { manifest, plainFile, database, files };
      }
      const bytes =
        entry.kind === "database" ? entry.bytes : entry.file.byteSize;
      if (!Number.isSafeInteger(offset + bytes) || offset + bytes > size)
        throw Error();
      if (entry.kind === "database") {
        if (database || files.length) throw Error();
        database = { offset, bytes, sha256: entry.sha256 };
      } else {
        if (!database || seen.has(entry.file.id)) throw Error();
        seen.add(entry.file.id);
        files.push({
          offset,
          bytes,
          sha256: entry.file.sha256,
          file: entry.file,
        });
      }
      offset += bytes;
    }
    throw Error();
  } catch {
    throw new BackupError(
      "BACKUP_INVALID",
      "备份目录或数据长度无效。在线数据没有被替换。",
    );
  } finally {
    await handle.close();
  }
}

export function entryStream(
  backup: OpenBackup,
  entry: BackupEntry,
): AsyncIterable<Uint8Array> {
  return entry.bytes === 0
    ? Readable.from([])
    : createReadStream(backup.plainFile, {
        start: entry.offset,
        end: entry.offset + entry.bytes - 1,
      });
}
export async function verifyBackupEntries(backup: OpenBackup): Promise<void> {
  for (const entry of [backup.database, ...backup.files]) {
    const checked = await hashStream(entryStream(backup, entry));
    if (checked.bytes !== entry.bytes || checked.sha256 !== entry.sha256)
      throw new BackupError(
        "BACKUP_CONTENT_MISMATCH",
        "备份内容校验失败。在线数据没有被替换。",
      );
  }
}
