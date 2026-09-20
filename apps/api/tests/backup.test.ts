import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { createApp } from "../src/app";
import { createDemoUsers, demoTags } from "../src/demo-data";
import { InMemoryDataStore } from "../src/repository";
import { AesGcmPluginSecretBox } from "../src/plugin-host";
import { BackupService, type BackupEngine } from "../src/backup/service";
import { WebDavClient, BackupError } from "../src/backup/webdav";
import {
  entryStream,
  openBackupArchive,
  verifyBackupEntries,
  writeBackupArchive,
} from "../src/backup/archive";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function temporary() {
  const directory = await mkdtemp(join(tmpdir(), "urmotiv-backup-test-"));
  directories.push(directory);
  return directory;
}
const password = "synthetic-independent-backup-password";
it("完整包加密往返包含数据库与二进制/空附件，错误密码和篡改不得通过", async () => {
  const dir = await temporary(),
    database = join(dir, "database.dump"),
    target = join(dir, "complete.urb");
  const sql = Buffer.from("synthetic-user-password-hash-and-private-statement");
  await writeFile(database, sql);
  const data = [Buffer.from([0, 255, 100, 0, 128]), Buffer.alloc(0)];
  const files = data.map((value, index) => ({
    id: randomUUID(),
    originalName: `合成附件-${index}`,
    mediaType: "application/octet-stream",
    byteSize: value.length,
    sha256: createHash("sha256").update(value).digest("hex"),
    storageKey: "synthetic/" + index,
  }));
  await writeBackupArchive({
    target,
    password,
    databaseFile: database,
    manifest: {
      format: 1,
      createdAt: new Date().toISOString(),
      schemaVersion: 1,
      secretKey: "synthetic-key",
      fileCount: 2,
      kind: "manual",
    },
    files,
    openFile: async (file) =>
      Readable.from([data[files.findIndex((item) => item.id === file.id)]!]),
  });
  const bytes = await readFile(target);
  expect(bytes.includes(sql)).toBe(false);
  expect(bytes.includes(Buffer.from("synthetic-key"))).toBe(false);
  const opened = await openBackupArchive(
    target,
    password,
    join(dir, "open.pack"),
  );
  await verifyBackupEntries(opened);
  expect(opened.files).toHaveLength(2);
  const parts = [];
  for await (const chunk of entryStream(opened, opened.database))
    parts.push(chunk);
  expect(Buffer.concat(parts)).toEqual(sql);
  await expect(
    openBackupArchive(target, "wrong-password", join(dir, "wrong.pack")),
  ).rejects.toMatchObject({ code: "BACKUP_PASSWORD_OR_INTEGRITY" });
  bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
  await writeFile(join(dir, "tampered.urb"), bytes);
  await expect(
    openBackupArchive(
      join(dir, "tampered.urb"),
      password,
      join(dir, "tampered.pack"),
    ),
  ).rejects.toMatchObject({ code: "BACKUP_PASSWORD_OR_INTEGRITY" });
});
it("附件缺失/摘要不一致不会形成成功备份", async () => {
  const dir = await temporary(),
    dump = join(dir, "db");
  await writeFile(dump, "database");
  await expect(
    writeBackupArchive({
      target: join(dir, "bad.urb"),
      password,
      databaseFile: dump,
      manifest: {
        format: 1,
        createdAt: new Date().toISOString(),
        schemaVersion: 1,
        secretKey: "k",
        fileCount: 1,
        kind: "manual",
      },
      files: [
        {
          id: randomUUID(),
          originalName: "synthetic",
          mediaType: "text/plain",
          byteSize: 5,
          sha256: "a".repeat(64),
          storageKey: "key",
        },
      ],
      openFile: async () => Readable.from([Buffer.from("short")]),
    }),
  ).rejects.toMatchObject({ code: "BACKUP_FILE_CHANGED" });
});
it("WebDAV 创建正确子目录、验证读写移动并清理探针；凭据失败与跨站重定向被拒绝", async () => {
  const files = new Map<string, Buffer>();
  let directory = false;
  let redirect = false;
  const authorization =
    "Basic " + Buffer.from("synthetic:secret").toString("base64");
  const server = createServer(async (req, res) => {
    if (redirect) {
      res.writeHead(302, { Location: "http://127.0.0.1:1/leak" });
      res.end();
      return;
    }
    if (req.headers.authorization !== authorization) {
      res.writeHead(401);
      res.end();
      return;
    }
    const path = req.url!;
    if (req.method === "PROPFIND") {
      res.writeHead(directory ? 207 : 404, {
        "Content-Type": "application/xml",
      });
      res.end(
        directory ? '<d:multistatus xmlns:d="DAV:"></d:multistatus>' : "",
      );
      return;
    }
    if (req.method === "MKCOL") {
      expect(path).toBe("/dav/urmotiv/");
      directory = true;
      res.writeHead(201);
      res.end();
      return;
    }
    if (req.method === "PUT") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      files.set(path, Buffer.concat(chunks));
      res.writeHead(201);
      res.end();
      return;
    }
    if (req.method === "MOVE") {
      const destination = new URL(String(req.headers.destination)).pathname;
      files.set(destination, files.get(path)!);
      files.delete(path);
      res.writeHead(201);
      res.end();
      return;
    }
    if (req.method === "GET") {
      res.writeHead(files.has(path) ? 200 : 404);
      res.end(files.get(path));
      return;
    }
    if (req.method === "DELETE") {
      files.delete(path);
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(405);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = `http://127.0.0.1:${(server.address() as { port: number }).port}/dav`;
    const client = new WebDavClient({
      address,
      username: "synthetic",
      password: "secret",
    });
    await client.verify();
    expect(directory).toBe(true);
    expect(files.size).toBe(0);
    await expect(
      new WebDavClient({
        address,
        username: "synthetic",
        password: "wrong",
      }).verify(),
    ).rejects.toMatchObject({ code: "WEBDAV_AUTH_FAILED" });
    redirect = true;
    await expect(client.verify()).rejects.toMatchObject({
      code: "WEBDAV_UNAVAILABLE",
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

async function fixture() {
  const directory = await temporary();
  let failVerification = false;
  const events: string[] = [];
  class FakeDav extends WebDavClient {
    override async verify() {
      if (failVerification)
        throw new BackupError("WEBDAV_AUTH_FAILED", "验证失败");
    }
    override async upload(name: string) {
      events.push("upload:" + name);
    }
    override async download(_name: string, path: string) {
      await writeFile(path, "synthetic");
    }
    override async list() {
      return [];
    }
  }
  const engine: BackupEngine = {
    create: async (target) => {
      events.push("create");
      await writeFile(target, "encrypted");
    },
    prepareRestore: async (_source, input) => {
      if (input !== password)
        throw new BackupError("BACKUP_PASSWORD_OR_INTEGRITY", "密码错误");
      events.push("prepare");
      return {
        apply: async () => {
          events.push("apply");
        },
        dispose: async () => {
          events.push("dispose");
        },
      };
    },
  };
  const service = await BackupService.open({
    directory,
    secretBox: new AesGcmPluginSecretBox(randomBytes(32)),
    engine,
    client: (credentials) => new FakeDav(credentials),
    maintenance: {
      enter: async () => {
        events.push("maintenance");
      },
      leave: () => events.push("resume"),
    },
  });
  const config = {
    expectedRevision: 1,
    enabled: true,
    address: "https://backup.example.test/dav",
    username: "synthetic",
    password: "synthetic-webdav-password",
    encryptionPassword: password,
    intervalHours: null,
  };
  return {
    service,
    config,
    events,
    directory,
    fail: () => {
      failVerification = true;
    },
  };
}
it("验证通过才保存且不回显密钥，验证失败保留旧配置；恢复前备份成功后才替换", async () => {
  const { service, config, events, directory, fail } = await fixture();
  await service.configure(config);
  expect(JSON.stringify(service.view())).not.toContain(password);
  expect(
    await readFile(join(directory, "settings.json"), "utf8"),
  ).not.toContain(password);
  fail();
  await expect(
    service.configure({
      ...config,
      expectedRevision: 2,
      address: "https://wrong.example.test",
    }),
  ).rejects.toMatchObject({ code: "WEBDAV_AUTH_FAILED" });
  expect(service.view().address).toBe(config.address);
  expect(service.view().revision).toBe(2);
  await service.startRestore("synthetic.urb", password);
  await service.close();
  expect(service.view().job?.status).toBe("succeeded");
  expect(events.findIndex((value) => value.startsWith("upload:"))).toBeLessThan(
    events.indexOf("apply"),
  );
  expect(events).toContain("resume");
  expect(service.view().job?.safetyBackupName).toContain("before-restore");
});
it("恢复密码失败不进入维护模式、不覆盖数据库，不伪造成功时间", async () => {
  const { service, config, events } = await fixture();
  await service.configure(config);
  await service.startRestore("synthetic.urb", "wrong");
  await service.close();
  expect(service.view().job?.status).toBe("failed");
  expect(service.view().lastSuccessAt).toBeNull();
  expect(events).not.toContain("maintenance");
  expect(events).not.toContain("apply");
});
it("完整备份接口只允许直接登录的 root，普通管理员与机器人不能读取或操作", async () => {
  const { service } = await fixture();
  const users = createDemoUsers();
  users.push({
    id: "0",
    nickname: "root",
    accountType: "human",
    isRoot: true,
    disabled: false,
    roles: ["root"],
    grants: [
      { permission: "auth.login", effect: "allow", scope: "global" },
      { permission: "system.manage", effect: "allow", scope: "global" },
    ],
  });
  const store = new InMemoryDataStore(users, demoTags);
  const app = await createApp({
    store,
    backup: service,
    demoAuthEnabled: true,
    demoUserIds: users.map((user) => user.id),
  });
  try {
    for (const id of ["administrator", "robot", "0"]) {
      const login = await app.inject({
        method: "POST",
        url: "/api/v1/auth/demo-login",
        headers: { origin: "http://localhost:5173" },
        payload: { userId: id },
      });
      const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/admin/backups",
        headers: { cookie },
      });
      expect(response.statusCode).toBe(id === "0" ? 200 : 404);
      if (id !== "0")
        for (const endpoint of ["run", "restore"]) {
          const denied = await app.inject({
            method: "POST",
            url: "/api/v1/admin/backups/" + endpoint,
            headers: { cookie, origin: "http://localhost:5173" },
            payload: {},
          });
          expect(denied.statusCode).toBe(404);
        }
    }
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/admin/backups" }))
        .statusCode,
    ).toBe(401);
  } finally {
    await app.close();
    await service.close();
  }
});
