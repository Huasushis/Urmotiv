import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLocalDatabase,
  migrateDatabase,
  type LocalDatabaseHandle,
  seedCoreDatabase
} from "@urmotiv/database";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import {
  DatabaseAdminSettingsStore,
  type StoredGeneralSettings,
  type StoredUstcOAuthSettings
} from "../src/admin-service";
import { AesGcmPluginSecretBox } from "../src/plugin-host";

let database: LocalDatabaseHandle;
let temporaryDirectory = "";

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "urmotiv-admin-security-"));
  database = createLocalDatabase({ dataDirectory: temporaryDirectory });
  await migrateDatabase(database);
  await seedCoreDatabase(database);
});

afterEach(async () => {
  await database.close();
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("管理员设置修订号隔离", () => {
  it("数据库尚未保存公开地址时使用当前部署的 Web origin", async () => {
    const store = new DatabaseAdminSettingsStore(
      database,
      new AesGcmPluginSecretBox(Buffer.alloc(32, 4)),
      "http://127.0.0.1:8080"
    );

    await expect(store.getGeneralSettings()).resolves.toEqual(
      expect.objectContaining({ publicSiteUrl: "http://127.0.0.1:8080" })
    );
  });

  it("普通设置修订号变化不阻塞或改变 OAuth override", async () => {
    const store = new DatabaseAdminSettingsStore(
      database,
      new AesGcmPluginSecretBox(Buffer.alloc(32, 4))
    );
    const general = await store.getGeneralSettings();
    const oauth = await store.getUstcOAuthSettings();
    const savedGeneral: StoredGeneralSettings = {
      ...general,
      publicRegistrationEnabled: true,
      revision: general.revision + 1
    };
    await store.updateGeneralSettings(general.revision, savedGeneral, {
      actorUserId: "0",
      requestId: "00000000-0000-4000-8000-000000000001",
      action: "test.general",
      objectType: "system_settings",
      objectId: "global",
      result: "success"
    });

    const savedOAuth: StoredUstcOAuthSettings = {
      ...oauth,
      enabled: false,
      revision: oauth.revision + 1,
      overrideConfigured: true
    };
    await expect(
      store.updateUstcOAuthSettings(oauth.revision, savedOAuth, {
        actorUserId: "0",
        requestId: "00000000-0000-4000-8000-000000000002",
        action: "test.oauth",
        objectType: "system_oauth_settings",
        objectId: "global",
        result: "success"
      })
    ).resolves.toEqual(savedOAuth);
    expect(await store.getGeneralSettings()).toEqual(savedGeneral);
    expect(await store.getUstcOAuthSettings()).toEqual(savedOAuth);
  });
});
