import { randomUUID } from "node:crypto";
import {
  createLocalDatabase,
  createPostgresDatabase,
  migrateDatabase,
  seedCoreDatabase
} from "@urmotiv/database";
import { CasClient, UstcOAuthClient } from "@urmotiv/auth";
import {
  JobWorker,
  LocalJobQueue,
  registerProblemPackageHandlers
} from "@urmotiv/jobs";
import { createFileStorage } from "@urmotiv/storage";
import { createApp } from "./app";
import { InMemoryEmailVerificationOutbox } from "./email-verification";
import { DatabaseContestStore } from "./database-contest-store";
import { databaseDemoUserIds, seedDatabaseDemoData } from "./database-demo";
import { DatabaseDataStore } from "./database-store";
import { DatabaseAdminSettingsStore } from "./admin-service";
import { DatabaseRoleManagementStore } from "./admin-role-service";
import { DatabasePluginStore } from "./database-plugin-store";
import {
  DatabaseProblemPackageJobStore,
  ProblemPackageJobCoordinator
} from "./problem-package-job-store";
import { DatabaseProblemPackageAuditWriter } from "./problem-package-audit";
import {
  DatabaseFixedRevisionExportReader,
  DatabaseImportedProblemWriter,
  ServiceImportExecutionAuthorization,
  ServiceExportReadAuthorization,
  StorageExportArtifactWriter,
  StorageVerifiedImportArchiveReader
} from "./problem-package-runtime";
import { ProblemFileStore } from "./problem-file-store";
import { ProblemService } from "./service";
import { TransferService } from "./transfer-service";
import {
  anklangEmbeddingApiKeySecretName,
  anklangPluginId,
  anklangServiceTokenSecretName,
  createBuiltinPluginDefinitions,
  type AnklangHookRuntime
} from "./builtin-plugins";
import { DatabaseReviewItemStore } from "./review-item-store";
import { DatabaseRobotStore } from "./robot-store";
import { DatabaseServiceAccountTokenStore } from "./service-account-store";
import { DatabaseTagCatalogService } from "./tag-catalog-service";
import {
  InMemoryLoginRateLimiterStorage,
  LoginRateLimiter
} from "./login-rate-limiter";
import { createPluginSecretBox, TrustedPluginHost } from "./plugin-host";
import { TrustedProblemFormatAdapterCatalog } from "./problem-format-adapters";
import {
  readServerAuthenticationOptions,
  readServerDatabaseOptions,
  readServerOptions,
  readServerStorageOptions
} from "./server-config";
import { assertAdminBootstrapReadyForServer } from "./bootstrap-admin";

const appOptions = readServerOptions(process.env);
const authenticationOptions = readServerAuthenticationOptions(process.env);
const databaseOptions = readServerDatabaseOptions(process.env);
const storageOptions = readServerStorageOptions(process.env);
const fileStorage = createFileStorage(storageOptions);
const database =
  databaseOptions.kind === "postgres"
    ? createPostgresDatabase({
        connectionString: databaseOptions.connectionString,
        applicationName: "urmotiv-api"
      })
    : createLocalDatabase({ dataDirectory: databaseOptions.dataDirectory });

try {
  if (databaseOptions.migrate) {
    await migrateDatabase(database);
  }
  await assertAdminBootstrapReadyForServer(database);
  await seedCoreDatabase(database);
  if (databaseOptions.seedDemoData) {
    await seedDatabaseDemoData(database);
  }
  const pluginSecretBox = createPluginSecretBox(process.env.URMOTIV_PLUGIN_SECRET_KEY);
  let pluginHostReference: TrustedPluginHost | undefined;
  const anklangRuntime: AnklangHookRuntime = {
    readSettings: async () => pluginHostReference?.readEnabledPluginSettings(anklangPluginId),
    readToken: async () => {
      if (pluginHostReference === undefined) {
        return undefined;
      }
      return pluginHostReference.readSecretForPlugin(
        anklangPluginId,
        anklangServiceTokenSecretName
      );
    },
    readEmbeddingApiKey: async () => {
      if (pluginHostReference === undefined) {
        return undefined;
      }
      return pluginHostReference.readSecretForPlugin(
        anklangPluginId,
        anklangEmbeddingApiKeySecretName
      );
    },
    cache: createProcessAnklangCache()
  };
  const pluginHost = new TrustedPluginHost(
    createBuiltinPluginDefinitions({ anklang: anklangRuntime }),
    new DatabasePluginStore(database),
    pluginSecretBox
  );
  pluginHostReference = pluginHost;
  const problemFormatAdapters = new TrustedProblemFormatAdapterCatalog(pluginHost);
  const store = new DatabaseDataStore(database);
  const serviceAccountTokens = new DatabaseServiceAccountTokenStore(database);
  const problemFileStore = new ProblemFileStore(database);
  const problemService = new ProblemService(store);
  const packageAudit = new DatabaseProblemPackageAuditWriter(database);
  const packageJobStore = new DatabaseProblemPackageJobStore(database, packageAudit);
  const packageQueue = new LocalJobQueue();
  const packageCoordinator = new ProblemPackageJobCoordinator(packageJobStore, packageQueue);
  const exportReader = new DatabaseFixedRevisionExportReader({
    database,
    metadata: problemFileStore,
    storage: fileStorage
  });
  const packageWorker = new JobWorker(packageQueue, {
    workerId: `api-embedded-${randomUUID()}`
  });
  registerProblemPackageHandlers(packageWorker, {
    import: {
      jobs: packageJobStore,
      adapterCatalog: problemFormatAdapters,
      authorization: new ServiceImportExecutionAuthorization({
        getUser: (userId) => store.getUser(userId)
      }),
      archives: new StorageVerifiedImportArchiveReader(problemFileStore, fileStorage),
      writer: new DatabaseImportedProblemWriter({
        database,
        store,
        metadata: problemFileStore,
        storage: fileStorage,
        audit: packageAudit
      })
    },
    export: {
      jobs: packageJobStore,
      adapterCatalog: problemFormatAdapters,
      source: exportReader,
      authorization: new ServiceExportReadAuthorization({
        getUser: (userId) => store.getUser(userId),
        service: problemService
      }),
      artifacts: new StorageExportArtifactWriter({
        database,
        metadata: problemFileStore,
        storage: fileStorage,
        audit: packageAudit
      })
    }
  });
  const transferService = new TransferService({
    database,
    service: problemService,
    metadata: problemFileStore,
    storage: fileStorage,
    audit: packageAudit,
    jobs: packageJobStore,
    coordinator: packageCoordinator,
    exportReader,
    adapterCatalog: problemFormatAdapters
  });
  const casClient = authenticationOptions.cas === undefined
    ? undefined
    : new CasClient({
        configuration: authenticationOptions.cas.configuration,
        stateSecret: authenticationOptions.cas.stateSecret,
        states: {
          put: (nonceDigest, expiresAt) => store.putLoginState(nonceDigest, expiresAt),
          consume: (nonceDigest, now) => store.consumeLoginState(nonceDigest, now)
        }
      });
  const ustcOAuthClient = authenticationOptions.ustcOAuth === undefined
    ? undefined
    : new UstcOAuthClient({
        configuration: authenticationOptions.ustcOAuth.configuration,
        ...(appOptions.allowLoopbackInsecureCookies
          ? { allowLoopbackInsecureRedirect: true }
          : {}),
        stateSecret: authenticationOptions.ustcOAuth.stateSecret,
        states: {
          put: (nonceDigest, expiresAt) => store.putLoginState(nonceDigest, expiresAt),
          consume: (nonceDigest, now) => store.consumeLoginState(nonceDigest, now)
        }
      });
  const emailVerificationOptions = authenticationOptions.emailVerification;

  // 只按来源地址限制登录尝试；生产使用真实时钟与进程内存储。
  const loginRateLimiter = new LoginRateLimiter({
    maxFailedAttempts: 20,
    windowMs: 60_000,
    storage: new InMemoryLoginRateLimiterStorage(),
    now: () => Date.now()
  });

  const app = await createApp({
    ...appOptions,
    ...authenticationOptions,
    ...(emailVerificationOptions === undefined
      ? {}
      : {
          emailVerificationDelivery: new InMemoryEmailVerificationOutbox(),
          emailVerificationWebUrl: emailVerificationOptions.webUrl
        }),
    ...(casClient === undefined ? {} : { casClient }),
    ...(ustcOAuthClient === undefined ? {} : { ustcOAuthClient }),
    store,
    contestStore: new DatabaseContestStore(database),
    pluginHost,
    demoUserIds: Object.values(databaseDemoUserIds),
    demoLoginUserIds: databaseDemoUserIds,
    problemFiles: {
      metadata: problemFileStore,
      storage: fileStorage
    },
    transfer: transferService,
    adminSettingsStore: new DatabaseAdminSettingsStore(database, pluginSecretBox),
    roleManagementStore: new DatabaseRoleManagementStore(database),
    serviceAccountTokenConfigured: async (userId) => {
      const tokens = await serviceAccountTokens.listTokens(userId);
      return tokens !== undefined && tokens.items.length > 0;
    },
    reviewItems: new DatabaseReviewItemStore(database),
    loginRateLimiter,
    robots: new DatabaseRobotStore(database),
    serviceAccountTokens,
    tagCatalog: new DatabaseTagCatalogService(database)
  });
  void packageWorker.run();
  app.addHook("onClose", async () => {
    await packageWorker.stop().catch(() => undefined);
    await packageQueue.close().catch(() => undefined);
    await database.close();
  });

  const configuredPort = process.env.URMOTIV_API_PORT ?? process.env.PORT ?? "3000";
  const port = Number.parseInt(configuredPort, 10);
  await app.listen({ port: Number.isFinite(port) ? port : 3000, host: "0.0.0.0" });
} catch (error) {
  await database.close().catch(() => undefined);
  throw error;
}
function createProcessAnklangCache(): {
  get(contentHash: string): Promise<unknown | undefined>;
  set(contentHash: string, result: unknown, expiresAt: string): Promise<void>;
} {
  const entries = new Map<string, { value: unknown; expiresAtMs: number }>();
  return {
    async get(contentHash) {
      const entry = entries.get(contentHash);
      if (entry === undefined || entry.expiresAtMs <= Date.now()) {
        entries.delete(contentHash);
        return undefined;
      }
      return entry.value;
    },
    async set(contentHash, result, expiresAt) {
      const expiresAtMs = Date.parse(expiresAt);
      if (Number.isFinite(expiresAtMs)) {
        entries.set(contentHash, { value: result, expiresAtMs });
        if (entries.size > 500) {
          const currentMs = Date.now();
          for (const [key, entry] of entries) {
            if (entry.expiresAtMs <= currentMs || entries.size > 400) {
              entries.delete(key);
            }
            if (entries.size <= 400) {
              break;
            }
          }
        }
      }
    }
  };
}
