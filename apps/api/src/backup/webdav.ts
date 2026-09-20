import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";

export class BackupError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BackupError";
  }
}
export interface WebDavCredentials {
  address: string;
  username: string;
  password: string;
}

/** 所有路径由本站生成，凭据不跟随重定向，也不进入错误信息。 */
export class WebDavClient {
  private readonly base: URL;
  constructor(
    private readonly credentials: WebDavCredentials,
    private readonly request: typeof fetch = fetch,
  ) {
    try {
      this.base = new URL(credentials.address);
      if (
        !["http:", "https:"].includes(this.base.protocol) ||
        this.base.username ||
        this.base.password ||
        this.base.search ||
        this.base.hash
      )
        throw Error();
      this.base.pathname = this.base.pathname.replace(/\/*$/, "/");
    } catch {
      throw new BackupError(
        "WEBDAV_ADDRESS_INVALID",
        "WebDAV 地址须为不含账号密码、查询参数或片段的 HTTP/HTTPS 地址。",
      );
    }
  }
  private url(path: string): URL {
    if (!/^(?:urmotiv\/)?[a-zA-Z0-9._-]*\/?$/.test(path) || path.includes(".."))
      throw new BackupError("BACKUP_PATH_INVALID", "备份路径无效。");
    return new URL(path, this.base);
  }
  private async call(
    path: string,
    method: string,
    headers: Record<string, string> = {},
    body?: BodyInit,
    timeoutMs = 60_000,
  ): Promise<Response> {
    try {
      const response = await this.request(this.url(path), {
        method,
        headers: {
          Authorization:
            "Basic " +
            Buffer.from(
              this.credentials.username + ":" + this.credentials.password,
            ).toString("base64"),
          ...headers,
        },
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
        ...(body === undefined ? {} : { body, duplex: "half" }),
      } as RequestInit);
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        throw new BackupError(
          "WEBDAV_AUTH_FAILED",
          "WebDAV 登录失败或没有读写权限。",
        );
      }
      return response;
    } catch (error) {
      if (error instanceof BackupError) throw error;
      throw new BackupError(
        "WEBDAV_UNAVAILABLE",
        "无法连接 WebDAV，请检查地址、网络和服务状态。",
      );
    }
  }
  async ensureDirectory(): Promise<void> {
    const found = await this.call("urmotiv/", "PROPFIND", { Depth: "0" });
    await found.body?.cancel();
    if (found.status === 207 || found.ok) return;
    if (found.status !== 404)
      throw new BackupError(
        "WEBDAV_READ_FAILED",
        "无法读取 WebDAV 下的 urmotiv 文件夹。",
      );
    const created = await this.call("urmotiv/", "MKCOL");
    await created.body?.cancel();
    if (!created.ok && created.status !== 405)
      throw new BackupError(
        "WEBDAV_CREATE_FAILED",
        "无法创建 WebDAV 下的 urmotiv 文件夹，请检查权限。",
      );
  }
  async verify(): Promise<void> {
    await this.ensureDirectory();
    const nonce = randomBytes(18).toString("hex");
    const first = "urmotiv/.check-" + nonce;
    const moved = first + "-moved";
    try {
      const put = await this.call(
        first,
        "PUT",
        { "Content-Type": "application/octet-stream" },
        nonce,
      );
      await put.body?.cancel();
      if (!put.ok)
        throw new BackupError(
          "WEBDAV_WRITE_FAILED",
          "WebDAV 文件写入验证失败，未保存新配置。",
        );
      const move = await this.call(first, "MOVE", {
        Destination: this.url(moved).href,
        Overwrite: "F",
      });
      await move.body?.cancel();
      if (!move.ok)
        throw new BackupError(
          "WEBDAV_MOVE_FAILED",
          "WebDAV 不支持安全完成备份所需的文件移动操作。",
        );
      const read = await this.call(moved, "GET");
      if (!read.ok) {
        await read.body?.cancel();
        throw new BackupError(
          "WEBDAV_READ_FAILED",
          "WebDAV 文件读取验证失败。",
        );
      }
      const bytes = await this.readLimited(read, 1024);
      if (Buffer.from(bytes).toString("utf8") !== nonce)
        throw new BackupError(
          "WEBDAV_VERIFY_FAILED",
          "WebDAV 返回内容与写入内容不一致，未保存配置。",
        );
    } finally {
      for (const path of [first, moved]) {
        const removed = await this.call(path, "DELETE").catch(() => undefined);
        await removed?.body?.cancel();
      }
    }
  }
  async upload(name: string, file: string): Promise<void> {
    const size = (await stat(file)).size;
    const response = await this.call(
      "urmotiv/" + name + ".partial",
      "PUT",
      {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(size),
      },
      Readable.toWeb(createReadStream(file)) as ReadableStream,
      3_600_000,
    );
    await response.body?.cancel();
    if (!response.ok)
      throw new BackupError(
        "WEBDAV_UPLOAD_FAILED",
        "备份上传失败，未标记为成功。",
      );
    const moved = await this.call("urmotiv/" + name + ".partial", "MOVE", {
      Destination: this.url("urmotiv/" + name).href,
      Overwrite: "F",
    });
    await moved.body?.cancel();
    if (!moved.ok)
      throw new BackupError(
        "WEBDAV_MOVE_FAILED",
        "备份上传完成，但未能提交为完整备份。",
      );
  }
  async download(
    name: string,
    target: string,
    maximumBytes: number,
  ): Promise<void> {
    const response = await this.call(
      "urmotiv/" + name,
      "GET",
      {},
      undefined,
      3_600_000,
    );
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new BackupError("WEBDAV_DOWNLOAD_FAILED", "无法下载所选备份。");
    }
    if (Number(response.headers.get("content-length") ?? 0) > maximumBytes) {
      await response.body.cancel();
      throw new BackupError("BACKUP_TOO_LARGE", "备份超过服务器允许的大小。");
    }
    let size = 0;
    async function* bounded() {
      for await (const chunk of Readable.fromWeb(response.body! as never)) {
        size += chunk.length;
        if (size > maximumBytes)
          throw new BackupError(
            "BACKUP_TOO_LARGE",
            "备份超过服务器允许的大小。",
          );
        yield chunk;
      }
    }
    await pipeline(
      bounded(),
      createWriteStream(target, { flags: "wx", mode: 0o600 }),
    );
  }
  async list(): Promise<
    Array<{ name: string; bytes: number; modifiedAt: string | null }>
  > {
    const response = await this.call("urmotiv/", "PROPFIND", { Depth: "1" });
    if (response.status !== 207 && !response.ok) {
      await response.body?.cancel();
      throw new BackupError("WEBDAV_LIST_FAILED", "无法读取远端备份列表。");
    }
    const xml = Buffer.from(
      await this.readLimited(response, 8 * 1024 * 1024),
    ).toString("utf8");
    const readTag = (body: string, tag: string) =>
      new RegExp(
        `<(?:(?:[\\w-]+):)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:(?:[\\w-]+):)?${tag}>`,
        "i",
      )
        .exec(body)?.[1]
        ?.trim();
    const output = [];
    for (const match of xml.matchAll(
      /<(?:[\w-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?response>/gi,
    )) {
      const href = readTag(match[1]!, "href");
      if (!href) continue;
      let name: string;
      try {
        name = decodeURIComponent(
          href.replace(/&amp;/g, "&").split("/").at(-1) ?? "",
        );
      } catch {
        continue;
      }
      if (!/^[a-zA-Z0-9_-]+\.urb$/.test(name)) continue;
      const bytes = Number(readTag(match[1]!, "getcontentlength") ?? 0);
      const date = Date.parse(readTag(match[1]!, "getlastmodified") ?? "");
      if (!Number.isSafeInteger(bytes) || bytes < 0) continue;
      output.push({
        name,
        bytes,
        modifiedAt: Number.isFinite(date) ? new Date(date).toISOString() : null,
      });
    }
    return output.sort((a, b) => b.name.localeCompare(a.name));
  }
  private async readLimited(
    response: Response,
    limit: number,
  ): Promise<Uint8Array> {
    if (!response.body) return new Uint8Array();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > limit) {
          await reader.cancel();
          throw new BackupError(
            "WEBDAV_RESPONSE_TOO_LARGE",
            "WebDAV 响应超过允许大小。",
          );
        }
        chunks.push(value);
      }
      return Buffer.concat(chunks);
    } finally {
      reader.releaseLock();
    }
  }
}
