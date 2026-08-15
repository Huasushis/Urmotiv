import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import {
  applyReviewSuggestionsInputSchema,
  casCallbackQuerySchema,
  casStartQuerySchema,
  confirmTagDeactivationInputSchema,
  claimRobotReviewTasksInputSchema,
  claimRobotReviewTasksResponseSchema,
  completeRobotReviewTaskInputSchema,
  renewRobotReviewTaskInputSchema,
  renewRobotReviewTaskResponseSchema,
  robotReviewTaskCompletionSchema,
  robotReviewTaskSchema,
  createContestInputSchema,
  createTagAliasInputSchema,
  createTagCatalogItemInputSchema,
  createProblemInputSchema,
  demoLoginInputSchema,
  deleteTagAliasInputSchema,
  emailRegistrationInputSchema,
  emailVerificationInputSchema,
  forceFrozenFieldEditInputSchema,
  loginInputSchema,
  manualReviewDecisionInputSchema,
  createExportJobRequestSchema,
  createImportJobRequestSchema,
  exportPreviewRequestSchema,
  fileOriginalNameSchema,
  importPreviewRequestSchema,
  problemAccessHeartbeatInputSchema,
  problemListQuerySchema,
  removeProblemFileInputSchema,
  reviewInputSchema,
  resendEmailVerificationInputSchema,
  submitProblemInputSchema,
  tagDeactivationPreviewInputSchema,
  updatePluginInputSchema,
  updateContestInputSchema,
  updateProblemInputSchema,
  updateReviewPolicyInputSchema,
  updateProfileInputSchema,
  updateTagAliasInputSchema,
  updateTagCatalogItemInputSchema,
  uploadProblemFileQuerySchema,
  withdrawProblemInputSchema
} from "@urmotiv/contracts";
import {
  CasAuthenticationError,
  casBrowserBindingCookieName,
  createEmailVerificationToken,
  digestSecretToken,
  type CasClient,
  hashPassword,
  normalizeEmail,
  verifyPassword
} from "@urmotiv/auth";
import type { FileStorage } from "@urmotiv/storage";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import { ContestService } from "./contest-service";
import { InMemoryContestStore, type ContestStore } from "./contest-store";
import { createDemoUsers, demoTags } from "./demo-data";
import { ApiError, conflict, forbidden, notFound, unauthorized } from "./errors";
import type { StoredUser } from "./domain";
import {
  createProblemPermissionFilter,
  createProblemVisibility,
  hasPermission,
} from "./permissions";
import { InMemoryDataStore, type DataStore } from "./repository";
import {
  createEmailVerificationUrl,
  type EmailVerificationDelivery
} from "./email-verification";
import type { ProblemFileStore } from "./problem-file-store";
import {
  ProblemFileService,
  synchronizeJudgeProgramFiles
} from "./problem-file-service";
import { ProblemService, type SubmitCheckRunner } from "./service";
import type { TransferService } from "./transfer-service";
import {
  anklangCheckId,
  anklangCompletionStatus,
  type AnklangCache,
  type AnklangCompletionStatus
} from "@urmotiv/plugin-anklang";
import {
  anklangPluginId,
  anklangServiceTokenSecretName,
  createBuiltinPluginDefinitions,
  type AnklangHookRuntime
} from "./builtin-plugins";
import {
  InMemoryReviewItemStore,
  type ReviewItemStore,
  type StoredReviewItemInput
} from "./review-item-store";
import {
  InMemoryPluginStore,
  PluginConfigurationError,
  PluginRevisionConflictError,
  TrustedPluginHost,
  type PluginUpdateFailureReason
} from "./plugin-host";
import { computeProblemContentHash } from "./database-store";
import { resolveClientAddress } from "./client-address";
import { avatarMaxBytes } from "./avatar";
import * as profile from "./profile-service";
import {
  DatabaseRobotStore,
  digestRobotOperationPayload,
  type RobotCompletionResult,
  type RobotTokenIdentity,
} from "./robot-store";
import { PluginReviewDecisionRunner } from "./review-decision";
import { ReviewPolicyService } from "./review-policy-service";
import { DatabaseTagCatalogService } from "./tag-catalog-service";

const sessionCookieName = "urmotiv_session";
const sessionLifetimeSeconds = 60 * 60 * 12;
const emailVerificationLifetimeSeconds = 30 * 60;
const casBrowserBindingCookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: "lax" as const,
  path: "/"
};
const problemFileUploadRouteBodyLimitBytes = 512 * 1024 * 1024;
const problemIdSchema = z.string().refine(
  (value) => /^(0|[1-9]\d*)$/.test(value) || z.string().uuid().safeParse(value).success
);
const contestIdSchema = z.string().regex(/^[1-9]\d*$/);
const fileIdSchema = z.string().uuid();
const adminPluginIdSchema = z
  .string()
  .min(3)
  .max(160)
  .regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/);
const tagCatalogItemIdSchema = z
  .string()
  .max(120)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u);

export interface ProblemFilePartsOptions {
  /** 文件元数据仓库，需要数据库存储。 */
  metadata: ProblemFileStore;
  /** 文件内容存储；权限判断永远发生在它之外。 */
  storage: FileStorage;
}

export interface ApiAppOptions {
  store?: DataStore;
  contestStore?: ContestStore;
  allowedOrigins?: string[];
  secureCookies?: boolean;
  demoAuthEnabled?: boolean;
  emailLoginEnabled?: boolean;
  emailRegistrationEnabled?: boolean;
  emailVerificationDelivery?: EmailVerificationDelivery;
  emailVerificationWebUrl?: string;
  casClient?: CasClient;
  demoUserIds?: readonly string[];
  demoLoginUserIds?: Readonly<Record<string, string>>;
  pluginHost?: TrustedPluginHost;
  problemFiles?: ProblemFilePartsOptions;
  transfer?: TransferService;
  reviewItems?: ReviewItemStore;
  robots?: DatabaseRobotStore;
  tagCatalog?: DatabaseTagCatalogService;
  trustedProxyCidrs?: readonly string[];
  /** 对外抓取（如 QQ 头像 CDN）使用的实现；默认 globalThis.fetch，测试可注入。 */
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

interface AppDependencies {
  store: DataStore;
  service: ProblemService;
  contestService: ContestService;
  reviewPolicyService: ReviewPolicyService;
  allowedOrigins: string[];
  secureCookies: boolean;
  demoAuthEnabled: boolean;
  emailLoginEnabled: boolean;
  emailRegistrationEnabled: boolean;
  emailVerificationDelivery?: EmailVerificationDelivery;
  emailVerificationWebUrl?: string;
  casClient?: CasClient;
  demoUserIds: ReadonlySet<string>;
  demoLoginUserIds: ReadonlyMap<string, string>;
  now: () => Date;
  pluginHost: TrustedPluginHost;
  problemFiles?: ProblemFileService;
  transfer?: TransferService;
  reviewItemStore: ReviewItemStore;
  robots?: DatabaseRobotStore;
  tagCatalog?: DatabaseTagCatalogService;
  trustedProxyCidrs: readonly string[];
  fetchImpl: typeof fetch;
}

function formatZodErrors(error: ZodError): Record<string, string[]> {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const field = issue.path.join(".") || "body";
    (fieldErrors[field] ??= []).push(issue.message);
  }
  return fieldErrors;
}

function getClientErrorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) {
    return undefined;
  }

  const statusCode = error.statusCode;
  return typeof statusCode === "number" && statusCode >= 400 && statusCode < 500
    ? statusCode
    : undefined;
}

function sendError(reply: FastifyReply, requestId: string, error: ApiError): void {
  reply.code(error.statusCode).send({
    error: {
      code: error.code,
      message: error.message,
      requestId,
      ...(error.fieldErrors === undefined ? {} : { fieldErrors: error.fieldErrors })
    }
  });
}

function parseProblemId(request: FastifyRequest): string {
  const params = request.params as { problemId?: unknown };
  const result = problemIdSchema.safeParse(params.problemId);
  if (!result.success) {
    throw new ApiError(404, "NOT_FOUND", "未找到请求的资源。");
  }
  return result.data;
}

function parseContestId(request: FastifyRequest): string {
  const params = request.params as { contestId?: unknown };
  const result = contestIdSchema.safeParse(params.contestId);
  if (!result.success) {
    throw notFound();
  }
  return result.data;
}

function readUnambiguousCookie(
  request: FastifyRequest,
  cookieName: string
): string | undefined {
  const rawCookieHeader = request.headers.cookie;
  if (rawCookieHeader === undefined) {
    return undefined;
  }
  let occurrences = 0;
  for (const segment of rawCookieHeader.split(";")) {
    const equalsIndex = segment.indexOf("=");
    if (equalsIndex > 0 && segment.slice(0, equalsIndex).trim() === cookieName) {
      occurrences += 1;
    }
  }
  return occurrences === 1 ? request.cookies[cookieName] : undefined;
}

function parseFileId(request: FastifyRequest): string {
  const params = request.params as { fileId?: unknown };
  const result = fileIdSchema.safeParse(params.fileId);
  if (!result.success) {
    throw notFound();
  }
  return result.data;
}

function parseAssignmentId(request: FastifyRequest): string {
  const params = request.params as { assignmentId?: unknown };
  const result = fileIdSchema.safeParse(params.assignmentId);
  if (!result.success) {
    throw notFound();
  }
  return result.data;
}

function parseTagCatalogItemId(request: FastifyRequest): string {
  const params = request.params as { tagId?: unknown };
  const result = tagCatalogItemIdSchema.safeParse(params.tagId);
  if (!result.success) {
    throw notFound();
  }
  return result.data;
}

function parseTagAliasId(request: FastifyRequest): string {
  const params = request.params as { aliasId?: unknown };
  const result = fileIdSchema.safeParse(params.aliasId);
  if (!result.success) {
    throw notFound();
  }
  return result.data;
}

function parseJobId(request: FastifyRequest): string {
  const params = request.params as { jobId?: unknown };
  const result = fileIdSchema.safeParse(params.jobId);
  if (!result.success) {
    throw notFound();
  }
  return result.data;
}

/**
 * 下载文件名头部：ASCII 之外的字符走 RFC 5987 编码，另给旧客户端一个安全替代名。
 */
function contentDispositionFor(originalName: string): string {
  const fallback = originalName.replace(/[^\u0020-\u007e]|["\\]/gu, "_");
  const encoded = encodeURIComponent(originalName).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function isByteStream(value: unknown): value is AsyncIterable<Uint8Array> {
  return typeof value === "object" && value !== null && Symbol.asyncIterator in value;
}

function requestContentLengthExceeds(
  request: FastifyRequest,
  maximumBytes: number
): boolean {
  const rawLength = request.headers["content-length"];
  if (typeof rawLength !== "string" || !/^\d+$/.test(rawLength)) {
    return false;
  }
  return BigInt(rawLength) > BigInt(maximumBytes);
}

/**
 * 依次运行指定的已启用提交前检查。正常提交使用管理员配置的完整顺序；
 * 手动原题检索只运行 Anklang，避免其他插件的失败冒充检索结果。
 */
function createSubmitCheckRunner(host: TrustedPluginHost): SubmitCheckRunner {
  const runSelected = async (
    input: Parameters<SubmitCheckRunner["run"]>[0],
    checkIds: readonly string[]
  ): ReturnType<SubmitCheckRunner["run"]> => {
    const collected: StoredReviewItemInput[] = [];
    let similarityStatus: AnklangCompletionStatus | undefined = checkIds.includes(anklangCheckId)
      ? "unavailable"
      : undefined;
    for (const checkId of checkIds) {
      const result = await host.runBeforeSubmit(input, [checkId]);
      if (result.decision === "block") {
        return {
          blocked: { code: result.code, message: result.message },
          reviewItems: [],
          checksRun: checkIds.length,
          ...(checkId === anklangCheckId
            ? {
                similarityStatus:
                  result.code === "anklang_partial_same_problem"
                    ? ("partial" as const)
                    : result.code === "anklang_similar_problem"
                      ? ("complete" as const)
                      : ("unavailable" as const)
              }
            : similarityStatus === undefined
              ? {}
              : { similarityStatus })
        };
      }
      const pluginId = host.pluginIdForCheckId(checkId);
      for (const item of result.reviewItems ?? []) {
        if (pluginId === anklangPluginId) {
          similarityStatus = anklangCompletionStatus(item.data) ?? "unavailable";
        }
        collected.push({
          type: item.type,
          source: pluginId === anklangPluginId ? "anklang" : "plugin",
          sourcePluginId: pluginId,
          visibility: item.visibility === "admin" ? "administrator" : item.visibility,
          summary: item.summary.slice(0, 500),
          data: item.data,
          contentHash: item.contentHash,
          ...(item.expiresAt === undefined ? {} : { expiresAt: item.expiresAt })
        });
      }
    }
    return {
      reviewItems: collected,
      checksRun: checkIds.length,
      ...(similarityStatus === undefined ? {} : { similarityStatus })
    };
  };

  return {
    async run(input) {
      return runSelected(input, await host.listEnabledBeforeSubmitCheckIds());
    },
    async runSimilarity(input) {
      const enabled = await host.listEnabledBeforeSubmitCheckIds();
      return runSelected(input, enabled.includes(anklangCheckId) ? [anklangCheckId] : []);
    }
  };
}

/** 进程内查重缓存；复合键绑定接口、服务地址、本地保留上限和内容摘要。 */
function createInMemoryAnklangCache(now: () => Date): AnklangCache {
  const entries = new Map<string, { value: unknown; expiresAtMs: number }>();
  return {
    async get(contentHash) {
      const entry = entries.get(contentHash);
      if (entry === undefined) {
        return undefined;
      }
      if (entry.expiresAtMs <= now().getTime()) {
        entries.delete(contentHash);
        return undefined;
      }
      return entry.value;
    },
    async set(contentHash, result, expiresAt) {
      const expiresAtMs = Date.parse(expiresAt);
      if (!Number.isFinite(expiresAtMs)) {
        return;
      }
      entries.set(contentHash, { value: result, expiresAtMs });
      if (entries.size > 500) {
        const currentMs = now().getTime();
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
  };
}

function createDependencies(options: ApiAppOptions): AppDependencies {
  const now = options.now ?? (() => new Date());
  const demoAuthEnabled = options.demoAuthEnabled ?? false;
  const defaultDemoUsers = demoAuthEnabled && options.store === undefined ? createDemoUsers() : [];
  const store =
    options.store ??
    new InMemoryDataStore(
      defaultDemoUsers,
      demoAuthEnabled ? demoTags : []
    );
  const contestStore = options.contestStore ?? new InMemoryContestStore();
  const reviewItems = options.reviewItems ?? new InMemoryReviewItemStore(now);
  // Anklang 钩子在运行时读取设置与密钥；宿主创建完成后再回填引用。
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
    cache: createInMemoryAnklangCache(now)
  };
  const pluginHost = options.pluginHost ?? new TrustedPluginHost(
    createBuiltinPluginDefinitions({ anklang: anklangRuntime }),
    new InMemoryPluginStore()
  );
  pluginHostReference = pluginHost;
  const submitChecks = createSubmitCheckRunner(pluginHost);
  const reviewDecisions = new PluginReviewDecisionRunner(pluginHost);
  const emailRegistrationEnabled = options.emailRegistrationEnabled ?? false;
  if (
    emailRegistrationEnabled &&
    (options.emailVerificationDelivery === undefined || options.emailVerificationWebUrl === undefined)
  ) {
    throw new Error("启用邮箱注册前必须配置服务端邮件投递和验证页面地址。");
  }
  const service = new ProblemService(store, {
    now,
    submitChecks,
    reviewItems,
    reviewDecisions,
    ...(options.problemFiles === undefined
      ? {}
      : {
          judgeConfigRevisionAction: (problem, revisionId, executor) =>
            synchronizeJudgeProgramFiles(
              options.problemFiles!.metadata,
              problem,
              revisionId,
              executor
            )
        })
  });
  return {
    store,
    service,
    reviewPolicyService: new ReviewPolicyService(store, reviewDecisions, now),
    contestService: new ContestService(store, contestStore, { now }),
    ...(options.problemFiles === undefined
      ? {}
      : {
          problemFiles: new ProblemFileService({
            service,
            metadata: options.problemFiles.metadata,
            storage: options.problemFiles.storage
          })
        }),
    ...(options.transfer === undefined ? {} : { transfer: options.transfer }),
    reviewItemStore: reviewItems,
    ...(options.robots === undefined ? {} : { robots: options.robots }),
    ...(options.tagCatalog === undefined ? {} : { tagCatalog: options.tagCatalog }),
    trustedProxyCidrs: options.trustedProxyCidrs ?? [],
    allowedOrigins: options.allowedOrigins ?? [
      "http://localhost:5173",
      "http://127.0.0.1:5173"
    ],
    secureCookies: options.secureCookies ?? false,
    demoAuthEnabled,
    emailLoginEnabled: options.emailLoginEnabled ?? true,
    emailRegistrationEnabled,
    ...(options.emailVerificationDelivery === undefined
      ? {}
      : { emailVerificationDelivery: options.emailVerificationDelivery }),
    ...(options.emailVerificationWebUrl === undefined
      ? {}
      : { emailVerificationWebUrl: options.emailVerificationWebUrl }),
    ...(options.casClient === undefined ? {} : { casClient: options.casClient }),
    demoUserIds: new Set(options.demoUserIds ?? defaultDemoUsers.map((user) => user.id)),
    demoLoginUserIds: new Map(Object.entries(options.demoLoginUserIds ?? {})),
    pluginHost,
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    now
  };
}

export async function createApp(options: ApiAppOptions = {}): Promise<FastifyInstance> {
  const dependencies = createDependencies(options);
  await dependencies.pluginHost.initialize();
  const app = Fastify({
    logger: false,
    genReqId: () => randomUUID(),
    trustProxy: false
  });

  await app.register(cors, {
    origin: dependencies.allowedOrigins,
  });
  await app.register(cookie);
  // 原始字节上传（题目文件、传输包、头像）都依赖该透传解析器；无条件注册。
  app.addContentTypeParser(
    "application/octet-stream",
    (_request, payload, done) => done(null, payload)
  );
  // 全局缓存头：所有 API 响应默认不可缓存。端点如需更强的策略可自行覆盖，
  // 此钩子只在未设置 cache-control 时回填 no-store，保证认证/错误/敏感 JSON 统一覆盖。
  app.addHook("onSend", (request, reply, payload, done) => {
    if (reply.getHeader("cache-control") === undefined) {
      reply.header("cache-control", "no-store");
    }
    if (reply.getHeader("x-content-type-options") === undefined) {
      reply.header("x-content-type-options", "nosniff");
    }
    done(null, payload);
  });
  app.addHook("preHandler", async (request) => {
    if (!new Set(["POST", "PUT", "PATCH", "DELETE"]).has(request.method)) {
      return;
    }

    const routeUrl = request.routeOptions.url;
    const writesSessionCookie =
      routeUrl === "/api/v1/auth/demo-login" ||
      routeUrl === "/api/v1/auth/email-login" ||
      routeUrl === "/api/v1/auth/email-register" ||
      routeUrl === "/api/v1/auth/email-verification/verify" ||
      routeUrl === "/api/v1/auth/email-verification/resend" ||
      routeUrl === "/api/v1/auth/logout" ||
      routeUrl === "/api/v1/auth/logout-all";
    const usesSessionCookie = request.cookies[sessionCookieName] !== undefined;
    if (!writesSessionCookie && !usesSessionCookie) {
      return;
    }

    const origin = request.headers.origin;
    if (origin === undefined || !dependencies.allowedOrigins.includes(origin)) {
      throw forbidden("当前来源不允许执行写入操作。");
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (reply.raw.headersSent) {
      reply.raw.destroy();
      return;
    }
    if (error instanceof ApiError) {
      sendError(reply, request.id, error);
      return;
    }

    if (error instanceof ZodError) {
      sendError(
        reply,
        request.id,
        new ApiError(422, "INVALID_INPUT", "提交的信息不符合要求。", formatZodErrors(error))
      );
      return;
    }

    const clientErrorStatus = getClientErrorStatus(error);
    if (clientErrorStatus !== undefined) {
      sendError(
        reply,
        request.id,
        new ApiError(clientErrorStatus, "INVALID_REQUEST", "请求格式不正确。")
      );
      return;
    }

    const errorName = error instanceof Error ? error.name : "UnknownError";
    app.log.error({ requestId: request.id, errorName }, "Unhandled API error");
    sendError(reply, request.id, new ApiError(500, "INTERNAL_ERROR", "服务暂时无法处理请求。"));
  });

  app.setNotFoundHandler((request, reply) => {
    sendError(reply, request.id, notFound());
  });

  async function currentUser(request: FastifyRequest): Promise<StoredUser | undefined> {
    const sessionId = request.cookies[sessionCookieName];
    if (sessionId === undefined) {
      return undefined;
    }

    const session = await dependencies.store.getSession(sessionId);
    const expiresAt = session === undefined ? Number.NaN : Date.parse(session.expiresAt);
    if (
      session === undefined ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= dependencies.now().getTime()
    ) {
      await dependencies.store.deleteSession(sessionId);
      return undefined;
    }

    const user = await dependencies.store.getUser(session.userId);
    if (user === undefined || !hasPermission(user, "auth.login", {}, dependencies.now())) {
      await dependencies.store.deleteSession(sessionId);
      return undefined;
    }
    return user;
  }

  async function requireUser(request: FastifyRequest): Promise<StoredUser> {
    const user = await currentUser(request);
    if (user === undefined) {
      throw unauthorized();
    }
    return user;
  }

  async function requirePluginManager(request: FastifyRequest): Promise<StoredUser> {
    const user = await requireUser(request);
    const now = dependencies.now();
    if (!hasPermission(user, "plugin.manage", {}, now)) {
      // 无权访问插件管理与无权访问私有资源一致，统一按"不存在"返回 404，
      // 不泄露插件端点存在性或权限差异。
      throw notFound();
    }
    return user;
  }

  function requireTagCatalogService(): DatabaseTagCatalogService {
    if (dependencies.tagCatalog === undefined) {
      throw new ApiError(503, "SERVICE_UNAVAILABLE", "知识点目录管理服务暂不可用。");
    }
    return dependencies.tagCatalog;
  }

  async function recordPluginUpdateAttemptSafely(input: {
    actorUserId: string;
    requestId: string;
    pluginId: string | null;
    result: "denied" | "failure";
    reasonCode: PluginUpdateFailureReason;
  }): Promise<void> {
    try {
      await dependencies.pluginHost.recordUpdateAttempt(input);
    } catch {
      app.log.error(
        { requestId: input.requestId, errorName: "PluginAuditWriteError" },
        "Plugin update audit could not be written"
      );
    }
  }

  function authSummary(user: StoredUser | undefined) {
    return {
      user: user === undefined ? null : dependencies.service.getSessionUser(user),
      auth: {
        emailEnabled: dependencies.emailLoginEnabled,
        emailRegistrationEnabled: dependencies.emailRegistrationEnabled,
        casEnabled: dependencies.casClient !== undefined,
        demoEnabled: dependencies.demoAuthEnabled
      }
    };
  }

  async function beginSession(user: StoredUser, reply: FastifyReply): Promise<void> {
    if (!hasPermission(user, "auth.login", {}, dependencies.now())) {
      throw unauthorized();
    }
    const expiresAt = new Date(
      dependencies.now().getTime() + sessionLifetimeSeconds * 1000
    ).toISOString();
    const session = await dependencies.store.createSession(user.id, expiresAt);
    reply.setCookie(sessionCookieName, session.id, {
      httpOnly: true,
      secure: dependencies.secureCookies,
      sameSite: "lax",
      path: "/",
      maxAge: sessionLifetimeSeconds
    });
  }

  async function sendEmailVerification(
    target: { userId: string; normalizedEmail: string },
    recipient: string
  ): Promise<void> {
    const delivery = dependencies.emailVerificationDelivery;
    const webUrl = dependencies.emailVerificationWebUrl;
    if (delivery === undefined || webUrl === undefined) {
      throw new Error("邮箱验证投递未配置。");
    }
    const token = createEmailVerificationToken();
    const expiresAt = new Date(
      dependencies.now().getTime() + emailVerificationLifetimeSeconds * 1000
    ).toISOString();
    await dependencies.store.replaceEmailVerificationToken({
      ...target,
      tokenDigest: token.digest,
      expiresAt
    });
    await delivery.send({
      recipient,
      verificationUrl: createEmailVerificationUrl(webUrl, token.token),
      expiresAt
    });
  }

  app.get("/api/v1/health", async () => ({ status: "ok", service: "urmotiv-api" }));

  app.get("/api/v1/health/ready", async (_request, reply) => {
    try {
      await dependencies.store.ping?.();
    } catch {
      reply.code(503);
      return {
        status: "unavailable",
        service: "urmotiv-api",
        checks: { database: "unavailable" }
      };
    }
    return {
      status: "ready",
      service: "urmotiv-api",
      checks: { database: "ok" }
    };
  });

  app.get("/api/v1/session", async (request) => {
    const user = await currentUser(request);
    return authSummary(user);
  });

  app.get("/api/v1/admin/plugins", async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    await requirePluginManager(request);
    return { items: await dependencies.pluginHost.list() };
  });

  app.patch("/api/v1/admin/plugins/:pluginId", async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    const user = await requireUser(request);
    const pluginId = adminPluginIdSchema.safeParse(
      (request.params as { pluginId?: unknown }).pluginId
    );
    const auditPluginId = pluginId.success ? pluginId.data : null;
    const now = dependencies.now();
    if (!hasPermission(user, "plugin.manage", {}, now)) {
      await recordPluginUpdateAttemptSafely({
        actorUserId: user.id,
        requestId: request.id,
        pluginId: auditPluginId,
        result: "denied",
        reasonCode: "permission_denied"
      });
      throw notFound();
    }
    if (!pluginId.success) {
      await recordPluginUpdateAttemptSafely({
        actorUserId: user.id,
        requestId: request.id,
        pluginId: null,
        result: "failure",
        reasonCode: "invalid_input"
      });
      throw notFound();
    }
    const parsedInput = updatePluginInputSchema.safeParse(request.body);
    if (!parsedInput.success) {
      await recordPluginUpdateAttemptSafely({
        actorUserId: user.id,
        requestId: request.id,
        pluginId: pluginId.data,
        result: "failure",
        reasonCode: "invalid_input"
      });
      throw parsedInput.error;
    }
    let plugin;
    try {
      plugin = await dependencies.pluginHost.update(
        pluginId.data,
        parsedInput.data,
        user.id,
        request.id
      );
    } catch (error) {
      if (error instanceof PluginRevisionConflictError) {
        await recordPluginUpdateAttemptSafely({
          actorUserId: user.id,
          requestId: request.id,
          pluginId: pluginId.data,
          result: "failure",
          reasonCode: "revision_conflict"
        });
        throw conflict(error.message);
      }
      if (error instanceof PluginConfigurationError) {
        await recordPluginUpdateAttemptSafely({
          actorUserId: user.id,
          requestId: request.id,
          pluginId: pluginId.data,
          result: "failure",
          reasonCode: "invalid_plugin_settings"
        });
        throw new ApiError(422, "INVALID_PLUGIN_SETTINGS", error.message);
      }
      await recordPluginUpdateAttemptSafely({
        actorUserId: user.id,
        requestId: request.id,
        pluginId: pluginId.data,
        result: "failure",
        reasonCode: "internal_error"
      });
      throw new ApiError(500, "PLUGIN_UPDATE_FAILED", "插件配置暂时无法保存，请稍后重试。");
    }
    if (plugin === undefined) {
      await recordPluginUpdateAttemptSafely({
        actorUserId: user.id,
        requestId: request.id,
        pluginId: pluginId.data,
        result: "failure",
        reasonCode: "plugin_not_found"
      });
      throw notFound();
    }
    return { item: plugin };
  });

  app.get("/api/v1/review-policy", async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    const user = await requireUser(request);
    return dependencies.reviewPolicyService.get(user);
  });

  app.patch("/api/v1/review-policy", async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    const user = await requireUser(request);
    dependencies.reviewPolicyService.assertCanManage(user);
    const input = updateReviewPolicyInputSchema.parse(request.body);
    return dependencies.reviewPolicyService.update(user, input, request.id);
  });

  app.post("/api/v1/auth/email-register", async (request, reply) => {
    if (!dependencies.emailLoginEnabled || !dependencies.emailRegistrationEnabled) {
      throw notFound();
    }
    const input = emailRegistrationInputSchema.strict().parse(request.body);
    const normalizedEmail = normalizeEmail(input.email);
    const user = await dependencies.store.registerEmailUser({
      normalizedEmail,
      displayEmail: input.email.trim(),
      passwordHash: await hashPassword(input.password),
      nickname: input.nickname
    });
    if (user !== undefined) {
      await sendEmailVerification(
        { userId: user.id, normalizedEmail },
        input.email.trim()
      );
    }
    reply.code(202);
    return { ok: true, verificationPending: true };
  });

  app.post("/api/v1/auth/email-verification/resend", async (request, reply) => {
    if (!dependencies.emailLoginEnabled || !dependencies.emailRegistrationEnabled) {
      throw notFound();
    }
    const input = resendEmailVerificationInputSchema.strict().parse(request.body);
    const normalizedEmail = normalizeEmail(input.email);
    const target = await dependencies.store.findPendingEmailVerification(normalizedEmail);
    if (target !== undefined) {
      await sendEmailVerification(target, normalizedEmail);
    }
    reply.code(202);
    return { ok: true, verificationPending: true };
  });

  app.post("/api/v1/auth/email-verification/verify", async (request) => {
    if (!dependencies.emailLoginEnabled || !dependencies.emailRegistrationEnabled) {
      throw notFound();
    }
    const input = emailVerificationInputSchema.strict().parse(request.body);
    const userId = await dependencies.store.consumeEmailVerificationToken(
      digestSecretToken(input.token),
      dependencies.now().toISOString()
    );
    if (userId === undefined) {
      throw new ApiError(400, "INVALID_VERIFICATION", "验证链接无效或已过期，请重新申请验证邮件。");
    }
    return { ok: true };
  });

  app.post("/api/v1/auth/email-login", async (request, reply) => {
    if (!dependencies.emailLoginEnabled) {
      throw notFound();
    }
    const input = loginInputSchema.strict().parse(request.body);
    const credential = await dependencies.store.findEmailCredential(normalizeEmail(input.email));
    if (
      credential === undefined ||
      !(await verifyPassword(credential.passwordHash, input.password)) ||
      !hasPermission(credential.user, "auth.login", {}, dependencies.now())
    ) {
      throw unauthorized();
    }
    await beginSession(credential.user, reply);
    return authSummary(credential.user);
  });

  if (dependencies.casClient !== undefined) {
    app.get("/api/v1/auth/cas/start", async (request, reply) => {
      reply.header("cache-control", "no-store");
      reply.header("referrer-policy", "no-referrer");
      const input = casStartQuerySchema.strict().parse(request.query);
      let start: Awaited<ReturnType<CasClient["startLogin"]>>;
      try {
        start = await dependencies.casClient!.startLogin(input.returnPath);
      } catch (error) {
        if (error instanceof CasAuthenticationError) {
          throw new ApiError(400, "INVALID_CAS_START", "统一身份认证登录请求无效。");
        }
        throw error;
      }
      reply.setCookie(
        start.browserBindingCookie.name,
        start.browserBindingCookie.value,
        {
          ...casBrowserBindingCookieOptions,
          maxAge: start.browserBindingCookie.maxAgeSeconds
        }
      );
      return reply.redirect(start.loginUrl);
    });

    app.get("/api/v1/auth/cas/callback", async (request, reply) => {
      reply.header("cache-control", "no-store");
      reply.header("referrer-policy", "no-referrer");
      try {
        const parsedInput = casCallbackQuerySchema.strict().safeParse(request.query);
        if (!parsedInput.success) {
          throw unauthorized();
        }
        const input = parsedInput.data;
        const browserBindingCookieName = casBrowserBindingCookieName(input.state);
        const completed = await dependencies.casClient!.finishLogin({
          ...input,
          browserBinding: readUnambiguousCookie(request, browserBindingCookieName)
        });
        const subject = z.string().trim().min(1).max(255).safeParse(completed.identity.subject);
        if (!subject.success) {
          throw unauthorized();
        }
        const nickname = z.string().trim().min(1).max(120).safeParse(
          completed.identity.nickname ?? "统一身份认证用户"
        );
        if (!nickname.success) {
          throw unauthorized();
        }
        let email: string | undefined;
        try {
          email = completed.identity.email === undefined
            ? undefined
            : normalizeEmail(completed.identity.email);
        } catch {
          throw unauthorized();
        }
        const studentIds = completed.identity.studentIds
          .map((identifier) => ({
            attribute: identifier.attribute,
            value: identifier.value.trim()
          }))
          .filter((identifier) => identifier.value.length > 0 && identifier.value.length <= 255);
        const user = await dependencies.store.findOrCreateExternalUser({
          provider: completed.identity.provider,
          subject: subject.data,
          nickname: nickname.data,
          ...(email === undefined ? {} : { email }),
          ...(studentIds.length === 0 ? {} : { studentIds })
        });
        await beginSession(user, reply);
        reply.clearCookie(browserBindingCookieName, casBrowserBindingCookieOptions);
        return reply.redirect(completed.returnTo);
      } catch {
        throw unauthorized();
      }
    });
  }

  if (dependencies.demoAuthEnabled) {
    app.get("/api/v1/auth/demo-users", async () => {
      const users = await dependencies.store.listUsers();
      return {
        items: users
          .filter((user) => dependencies.demoUserIds.has(user.id))
          .map((user) => ({
            id: user.id,
            nickname: user.nickname,
            accountType: user.accountType,
            roles: user.roles
          }))
      };
    });

    app.post("/api/v1/auth/demo-login", async (request, reply) => {
      const input = demoLoginInputSchema.strict().parse(request.body);
      const userId = dependencies.demoLoginUserIds.get(input.userId) ?? input.userId;
      if (!dependencies.demoUserIds.has(userId)) {
        throw unauthorized();
      }
      const user = await dependencies.store.getUser(userId);
      if (user === undefined || !hasPermission(user, "auth.login", {}, dependencies.now())) {
        throw unauthorized();
      }

      await beginSession(user, reply);
      return authSummary(user);
    });
  }

  app.post("/api/v1/auth/logout", async (request, reply) => {
    const sessionId = request.cookies[sessionCookieName];
    if (sessionId !== undefined) {
      await dependencies.store.deleteSession(sessionId);
    }
    reply.clearCookie(sessionCookieName, { path: "/" });
    return { ok: true };
  });

  app.post("/api/v1/auth/logout-all", async (request, reply) => {
    const user = await requireUser(request);
    await dependencies.store.revokeUserSessions(user.id);
    reply.clearCookie(sessionCookieName, { path: "/" });
    return { ok: true };
  });

  const userIdParamSchema = z.string().max(120);
  function parseUserIdParam(request: FastifyRequest): string {
    const params = request.params as { userId?: unknown };
    const result = userIdParamSchema.safeParse(params.userId);
    if (!result.success) {
      throw notFound();
    }
    return result.data;
  }

  app.get("/api/v1/me", async (request) => {
    const user = await requireUser(request);
    return profile.readProfileView(user, dependencies.store);
  });

  app.patch("/api/v1/me", async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    const user = await requireUser(request);
    const input = updateProfileInputSchema.parse(request.body);
    return profile.updateOwnProfile(user, input, dependencies.store);
  });

  app.put("/api/v1/me/avatar", async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    const user = await requireUser(request);
    if (!isByteStream(request.body)) {
      throw new ApiError(422, "UNSUPPORTED_AVATAR_BODY", "头像必须作为文件内容上传。");
    }
    if (requestContentLengthExceeds(request, avatarMaxBytes)) {
      throw new ApiError(413, "FILE_TOO_LARGE", "头像图片不能超过 512 KB。");
    }
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    let tooLarge = false;
    for await (const chunk of request.body) {
      totalBytes += chunk.byteLength;
      if (totalBytes > avatarMaxBytes) {
        tooLarge = true;
        break;
      }
      chunks.push(chunk);
    }
    if (tooLarge) {
      throw new ApiError(413, "FILE_TOO_LARGE", "头像图片不能超过 512 KB。");
    }
    const content = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      content.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return profile.uploadOwnAvatar(user, content, dependencies.store);
  });

  app.delete("/api/v1/me/avatar", async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    const user = await requireUser(request);
    return profile.clearOwnAvatar(user, dependencies.store);
  });

  app.get("/api/v1/users/:userId/avatar", async (request, reply) => {
    const user = await requireUser(request);
    void user;
    const result = await profile.resolveAvatarResponse(
      parseUserIdParam(request),
      dependencies.store,
      dependencies.fetchImpl
    );
    reply.header("cache-control", "private, max-age=3600");
    if (result.kind === "none") {
      throw notFound();
    }
    reply.header("content-type", result.mediaType);
    return Buffer.from(result.content);
  });

  app.get("/api/v1/tags", async (request) => {
    await requireUser(request);
    if (dependencies.tagCatalog !== undefined) {
      const catalog = await dependencies.tagCatalog.listPublicCatalog();
      return {
        version: catalog.version,
        items: catalog.items
          .filter((item) => item.itemKind === "tag")
          .map((item) => ({
            id: item.id,
            name: item.name,
            group: item.group,
            itemKind: "tag" as const,
            active: item.active,
            ...(item.category === undefined ? {} : { category: item.category }),
            description: item.description,
            aliases: item.aliases,
          })),
      };
    }
    return { items: await dependencies.store.listTags() };
  });

  app.get("/api/v1/tag-catalog", async (request) => {
    await requireUser(request);
    return requireTagCatalogService().listPublicCatalog();
  });

  app.get("/api/v1/admin/tag-catalog", async (request) => {
    const user = await requireUser(request);
    return requireTagCatalogService().listManagedCatalog(user.id);
  });

  app.post("/api/v1/admin/tag-catalog/items", async (request) => {
    const user = await requireUser(request);
    const input = createTagCatalogItemInputSchema.parse(request.body);
    return requireTagCatalogService().createItem(user.id, request.id, input);
  });

  app.patch("/api/v1/admin/tag-catalog/items/:tagId", async (request) => {
    const user = await requireUser(request);
    const tagId = parseTagCatalogItemId(request);
    const input = updateTagCatalogItemInputSchema.parse(request.body);
    return requireTagCatalogService().updateItem(user.id, request.id, tagId, input);
  });

  app.post("/api/v1/admin/tag-catalog/items/:tagId/aliases", async (request) => {
    const user = await requireUser(request);
    const tagId = parseTagCatalogItemId(request);
    const input = createTagAliasInputSchema.parse(request.body);
    return requireTagCatalogService().createAlias(user.id, request.id, tagId, input);
  });

  app.patch(
    "/api/v1/admin/tag-catalog/items/:tagId/aliases/:aliasId",
    async (request) => {
      const user = await requireUser(request);
      const tagId = parseTagCatalogItemId(request);
      const aliasId = parseTagAliasId(request);
      const input = updateTagAliasInputSchema.parse(request.body);
      return requireTagCatalogService().updateAlias(
        user.id,
        request.id,
        tagId,
        aliasId,
        input,
      );
    },
  );

  app.delete(
    "/api/v1/admin/tag-catalog/items/:tagId/aliases/:aliasId",
    async (request) => {
      const user = await requireUser(request);
      const tagId = parseTagCatalogItemId(request);
      const aliasId = parseTagAliasId(request);
      const input = deleteTagAliasInputSchema.parse(request.body);
      return requireTagCatalogService().deleteAlias(
        user.id,
        request.id,
        tagId,
        aliasId,
        input.expectedVersion,
      );
    },
  );

  app.post(
    "/api/v1/admin/tag-catalog/items/:tagId/deactivation-preview",
    async (request) => {
      const user = await requireUser(request);
      const tagId = parseTagCatalogItemId(request);
      const input = tagDeactivationPreviewInputSchema.parse(request.body);
      return requireTagCatalogService().previewDeactivation(
        user.id,
        tagId,
        input.replacementTagId,
      );
    },
  );

  app.post("/api/v1/admin/tag-catalog/items/:tagId/deactivate", async (request) => {
    const user = await requireUser(request);
    const tagId = parseTagCatalogItemId(request);
    const input = confirmTagDeactivationInputSchema.parse(request.body);
    return requireTagCatalogService().confirmDeactivation(
      user.id,
      request.id,
      tagId,
      input.confirmationId,
      input.catalogVersion,
    );
  });

  app.get("/api/v1/problems", async (request) => {
    const user = await requireUser(request);
    const query = problemListQuerySchema.strict().parse(request.query);
    return dependencies.service.listProblems(user, query);
  });

  app.post("/api/v1/problems", async (request) => {
    const user = await requireUser(request);
    const input = createProblemInputSchema.strict().parse(request.body);
    return dependencies.service.createProblem(user, input);
  });

  app.get("/api/v1/problems/:problemId", async (request) => {
    const user = await requireUser(request);
    const problemId = parseProblemId(request);
    const problem = await dependencies.service.getProblem(user, problemId);
    await dependencies.contestService.recordProblemAccess(user, problemId, 0);
    return problem;
  });

  app.post("/api/v1/problems/:problemId/access-heartbeat", async (request) => {
    const user = await requireUser(request);
    const input = problemAccessHeartbeatInputSchema.strict().parse(request.body);
    await dependencies.contestService.recordProblemAccess(
      user,
      parseProblemId(request),
      input.activeSeconds
    );
    return { ok: true };
  });

  app.get("/api/v1/problems/:problemId/access", async (request) => {
    const user = await requireUser(request);
    return dependencies.contestService.listProblemAccess(user, parseProblemId(request));
  });

  app.patch("/api/v1/problems/:problemId", async (request) => {
    const user = await requireUser(request);
    const input = updateProblemInputSchema.strict().parse(request.body);
    return dependencies.service.updateProblem(user, parseProblemId(request), input);
  });

  app.post("/api/v1/problems/:problemId/frozen-fields", async (request) => {
    const user = await requireUser(request);
    const input = forceFrozenFieldEditInputSchema.strict().parse(request.body);
    return dependencies.service.updateFrozenFields(
      user,
      parseProblemId(request),
      input,
      request.id
    );
  });

  app.post("/api/v1/problems/:problemId/submit", async (request) => {
    const user = await requireUser(request);
    const input = submitProblemInputSchema.strict().parse(request.body);
    return dependencies.service.submitProblem(user, parseProblemId(request), input.expectedRevision);
  });

  app.post("/api/v1/problems/:problemId/withdraw", async (request) => {
    const user = await requireUser(request);
    const input = withdrawProblemInputSchema.strict().parse(request.body);
    return dependencies.service.withdrawProblem(
      user,
      parseProblemId(request),
      input.expectedRevision,
      input.reason,
      request.id
    );
  });

  const robots = dependencies.robots;
  if (robots !== undefined) {
    const robotTagCatalog = dependencies.tagCatalog;
    if (robotTagCatalog === undefined) {
      throw new Error("启用机器人审题时必须配置知识点目录服务。");
    }
    const requireRobot = async (request: FastifyRequest): Promise<RobotTokenIdentity> => {
      const header = request.headers.authorization;
      const token = typeof header === "string" && header.startsWith("Bearer ")
        ? header.slice("Bearer ".length).trim()
        : undefined;
      if (token === undefined || token.length === 0) {
        throw unauthorized();
      }
      const identity = await robots.authenticateToken(
        token,
        resolveClientAddress(request, dependencies.trustedProxyCidrs),
      );
      if (identity === undefined) {
        throw unauthorized();
      }
      return identity;
    };

    app.post("/api/v1/robot/review-tasks/claim", async (request) => {
      const identity = await requireRobot(request);
      const robotUser = identity.user;
      const permissionEvaluatedAt = dependencies.now();
      const reviewPermission = createProblemPermissionFilter(
        robotUser,
        "problem.review",
        permissionEvaluatedAt,
      );
      if (reviewPermission === undefined) {
        throw forbidden();
      }
      const input = claimRobotReviewTasksInputSchema.parse(request.body ?? {});
      const publicCatalog = await robotTagCatalog.listPublicCatalog();
      const activeCategories = new Map(
        publicCatalog.items
          .filter((item) => item.itemKind === "category" && item.active)
          .map((item) => [item.id, item] as const),
      );
      const tagCatalog = {
        version: publicCatalog.version,
        tags: publicCatalog.items.flatMap((item) => {
          if (item.itemKind !== "tag" || !item.active) return [];
          const category = activeCategories.get(item.parentId);
          if (category === undefined) return [];
          return [{
            id: item.id,
            name: item.name,
            categoryId: category.id,
            categoryName: category.name,
            description: item.description,
            aliases: item.aliases,
            active: true as const,
          }];
        }),
      };
      const activeTagIds = new Set(tagCatalog.tags.map((tag) => tag.id));
      if (tagCatalog.tags.length === 0) {
        return claimRobotReviewTasksResponseSchema.parse({ items: [] });
      }
      const visibility = createProblemVisibility(robotUser, permissionEvaluatedAt);
      const candidates = await robots.listOpenRoundCandidates(
        robotUser.id,
        50,
        visibility,
        reviewPermission,
        input.supportedProblemTypes,
      );
      const tasks = [];
      for (const candidate of candidates) {
        if (tasks.length >= input.maximumTasks) {
          break;
        }
        const task = await dependencies.store.runProblemTransaction(
          candidate.problemId,
          async (transaction) => {
            const problem = transaction.getProblem();
            const executor = transaction.executor;
            if (
              problem === undefined
              || executor === undefined
              || transaction.getTagCatalogVersion() !== tagCatalog.version
              || problem.status !== "pending_review"
              || problem.reviewRound !== candidate.round
              || problem.tagIds.some((tagId) => !activeTagIds.has(tagId))
              || (
                input.supportedProblemTypes !== undefined
                && !input.supportedProblemTypes.includes(problem.type)
              )
            ) {
              return undefined;
            }
            const claimed = await robots.claimAssignmentInTransaction(
              executor,
              identity,
              problem,
              candidate.roundId,
              input.leaseSeconds,
              request.id,
              tagCatalog.version,
            );
            if (claimed === undefined) return undefined;
            const items = await dependencies.reviewItemStore.list(
              problem.id,
              problem.reviewRound,
              ["author", "reviewer"],
              executor,
            );
            return robotReviewTaskSchema.parse({
              assignmentId: claimed.assignment.id,
              leaseExpiresAt: claimed.assignment.expiresAt,
              problem: {
                id: problem.id,
                revision: problem.revision,
                reviewRound: problem.reviewRound,
                contentHash: computeProblemContentHash(problem),
                title: problem.title,
                type: problem.type,
                tagIds: problem.tagIds,
                content: problem.content,
                samples: problem.samples.map((sample, index) => ({
                  safeId: `sample-${String(index + 1).padStart(3, "0")}`,
                  input: sample.input,
                  output: sample.output,
                  explanation: sample.explanation,
                })),
                limits: problem.judgeConfig?.limits ?? null,
              },
              tagCatalog,
              reviewItems: items.map((item) => ({
                id: item.id,
                type: item.type,
                source: item.source,
                sourcePluginId: item.sourcePluginId,
                visibility: item.visibility,
                summary: item.summary,
                data: item.data,
                contentHash: item.contentHash,
                expiresAt: item.expiresAt,
                createdAt: item.createdAt,
              })),
            });
          },
        );
        if (task === undefined) continue;
        tasks.push(task);
      }
      return claimRobotReviewTasksResponseSchema.parse({ items: tasks });
    });

    app.post("/api/v1/robot/review-tasks/:assignmentId/renew", async (request) => {
      const identity = await requireRobot(request);
      const assignmentId = parseAssignmentId(request);
      const input = renewRobotReviewTaskInputSchema.parse(request.body ?? {});
      const target = await robots.findAssignmentTarget(assignmentId, identity.userId);
      if (target === undefined) throw notFound();
      const payloadDigest = digestRobotOperationPayload({
        expectedLeaseExpiresAt: input.expectedLeaseExpiresAt,
        leaseSeconds: input.leaseSeconds,
      });
      const outcome = await dependencies.store.runProblemTransaction(
        target.problemId,
        async (transaction) => {
          const problem = transaction.getProblem();
          const executor = transaction.executor;
          if (problem === undefined || executor === undefined) return { kind: "not_found" } as const;
          return robots.renewAssignmentInTransaction(
            executor,
            identity,
            problem,
            assignmentId,
            input,
            payloadDigest,
          );
        },
      );
      if (outcome.kind === "not_found") throw notFound();
      if (outcome.kind === "conflict") {
        throw conflict("请求标识已用于不同内容，或任务快照已变化。");
      }
      return renewRobotReviewTaskResponseSchema.parse(outcome.result);
    });

    app.post("/api/v1/robot/review-tasks/:assignmentId/complete", async (request) => {
      const identity = await requireRobot(request);
      const assignmentId = parseAssignmentId(request);
      const input = completeRobotReviewTaskInputSchema.parse(request.body);
      const target = await robots.findAssignmentTarget(assignmentId, identity.userId);
      if (target === undefined) throw notFound();
      const payloadDigest = digestRobotOperationPayload({
        expectedLeaseExpiresAt: input.expectedLeaseExpiresAt,
        expectedProblemRevision: input.expectedProblemRevision,
        expectedTagCatalogVersion: input.expectedTagCatalogVersion,
        experimentVersion: input.experimentVersion,
        modelProfileName: input.modelProfileName,
        review: input.review,
      });
      const outcome = await dependencies.store.runProblemTransaction(
        target.problemId,
        async (transaction) => {
          const problem = transaction.getProblem();
          const executor = transaction.executor;
          if (
            problem === undefined
            || executor === undefined
            || transaction.afterReviewWrites === undefined
          ) {
            return { kind: "not_found" } as const;
          }
          const prepared = await robots.prepareCompletionInTransaction(
            executor,
            identity,
            problem,
            assignmentId,
            input,
            payloadDigest,
            transaction.getTagCatalogVersion(),
          );
          if (prepared.kind !== "ready") return prepared;
          const submitted = await dependencies.service.submitReviewInTransaction(
            transaction,
            prepared.prepared.user,
            problem.id,
            input.review,
            input.requestId,
          );
          const result: RobotCompletionResult = {
            assignmentId,
            accepted: true,
            problemStatus: submitted.summary.status === "approved"
              ? "approved"
              : submitted.summary.status === "rejected"
                ? "rejected"
                : "pending_review",
          };
          transaction.afterReviewWrites(async (transactionExecutor) => {
            await robots.finishCompletionInTransaction(
              transactionExecutor,
              prepared.prepared,
              result,
              submitted.opinionId,
              {
                experimentVersion: input.experimentVersion,
                modelProfileName: input.modelProfileName,
              },
            );
          });
          return { kind: "success", result, replayed: false } as const;
        },
      );
      if (outcome.kind === "not_found") throw notFound();
      if (outcome.kind === "conflict") {
        throw conflict("请求标识已用于不同内容，或任务快照已变化。");
      }
      return robotReviewTaskCompletionSchema.parse(outcome.result);
    });
  }

  const problemFiles = dependencies.problemFiles;
  const transfer = dependencies.transfer;

  if (problemFiles !== undefined) {
    app.get("/api/v1/problems/:problemId/files", async (request) => {
      const user = await requireUser(request);
      return problemFiles.listFiles(user, parseProblemId(request));
    });

    app.put(
      "/api/v1/problems/:problemId/files",
      { bodyLimit: problemFileUploadRouteBodyLimitBytes },
      async (request) => {
        const user = await requireUser(request);
        const input = uploadProblemFileQuerySchema.parse(request.query);
        if (!isByteStream(request.body)) {
          throw new ApiError(
            415,
            "UNSUPPORTED_MEDIA_TYPE",
            "上传文件时请求正文必须是二进制内容（application/octet-stream）。"
          );
        }
        return problemFiles.uploadFile(user, parseProblemId(request), input, request.body);
      }
    );

    app.get("/api/v1/problems/:problemId/files/:fileId", async (request, reply) => {
      const user = await requireUser(request);
      const download = await problemFiles.downloadFile(
        user,
        parseProblemId(request),
        parseFileId(request)
      );
      reply.header("content-type", download.item.mediaType);
      reply.header("content-length", String(download.item.byteSize));
      reply.header("content-disposition", contentDispositionFor(download.item.originalName));
      reply.header("cache-control", "private, no-store");
      reply.header("x-content-type-options", "nosniff");
      return reply.send(Readable.from(download.stream));
    });

    app.delete("/api/v1/problems/:problemId/files/:fileId", async (request) => {
      const user = await requireUser(request);
      const input = removeProblemFileInputSchema.strict().parse(request.body);
      return problemFiles.removeFile(
        user,
        parseProblemId(request),
        parseFileId(request),
        input.expectedRevision
      );
    });
  }

  if (transfer !== undefined) {
    app.post(
      "/api/v1/transfer/uploads",
      { bodyLimit: transfer.maximumArchiveBytes },
      async (request) => {
        const user = await requireUser(request);
        if (requestContentLengthExceeds(request, transfer.maximumArchiveBytes)) {
          throw new ApiError(413, "FILE_TOO_LARGE", "题目包超过允许的大小限制。");
        }
        const query = z
          .object({ originalName: fileOriginalNameSchema })
          .parse(request.query);
        if (!isByteStream(request.body)) {
          throw new ApiError(
            415,
            "UNSUPPORTED_MEDIA_TYPE",
            "上传题目包时请求正文必须是二进制内容（application/octet-stream）。"
          );
        }
        return transfer.uploadPackage(user, request.id, query.originalName, request.body);
      }
    );

    app.post("/api/v1/transfer/imports/preview", async (request) => {
      const user = await requireUser(request);
      return transfer.previewImport(
        user,
        request.id,
        importPreviewRequestSchema.parse(request.body)
      );
    });

    app.post("/api/v1/transfer/imports", async (request) => {
      const user = await requireUser(request);
      return transfer.createImport(
        user,
        request.id,
        createImportJobRequestSchema.parse(request.body)
      );
    });

    app.get("/api/v1/transfer/imports/:jobId", async (request) => {
      const user = await requireUser(request);
      return transfer.getImportJob(user, parseJobId(request));
    });

    app.post("/api/v1/transfer/exports/preview", async (request) => {
      const user = await requireUser(request);
      return transfer.previewExport(
        user,
        request.id,
        exportPreviewRequestSchema.parse(request.body)
      );
    });

    app.post("/api/v1/transfer/exports", async (request) => {
      const user = await requireUser(request);
      return transfer.createExport(
        user,
        request.id,
        createExportJobRequestSchema.parse(request.body)
      );
    });

    app.get("/api/v1/transfer/exports/:jobId", async (request) => {
      const user = await requireUser(request);
      return transfer.getExportJob(user, parseJobId(request));
    });

    app.get("/api/v1/transfer/exports/:jobId/download", async (request, reply) => {
      const user = await requireUser(request);
      const download = await transfer.downloadExport(user, request.id, parseJobId(request));
      reply.header("content-type", download.mediaType);
      reply.header("content-length", String(download.byteSize));
      reply.header("content-disposition", contentDispositionFor(download.fileName));
      reply.header("cache-control", "private, no-store");
      reply.header("x-content-type-options", "nosniff");
      return reply.send(Readable.from(download.stream));
    });
  }

  app.get("/api/v1/problems/:problemId/review-items", async (request) => {
    const user = await requireUser(request);
    return dependencies.service.listReviewItems(user, parseProblemId(request));
  });

  app.post("/api/v1/problems/:problemId/similarity-check", async (request) => {
    const user = await requireUser(request);
    return dependencies.service.runManualSimilarityCheck(user, parseProblemId(request));
  });

  app.get("/api/v1/problems/:problemId/reviews", async (request) => {
    const user = await requireUser(request);
    return dependencies.service.getReviewSummary(user, parseProblemId(request));
  });

  app.get("/api/v1/problems/:problemId/review-suggestions", async (request) => {
    const user = await requireUser(request);
    return dependencies.service.getReviewSuggestions(user, parseProblemId(request));
  });

  app.post("/api/v1/problems/:problemId/review-suggestions/apply", async (request) => {
    const user = await requireUser(request);
    const input = applyReviewSuggestionsInputSchema.parse(request.body);
    return dependencies.service.applyReviewSuggestions(
      user,
      parseProblemId(request),
      input,
      request.id
    );
  });

  app.post("/api/v1/problems/:problemId/reviews", async (request) => {
    const user = await requireUser(request);
    const input = reviewInputSchema.strict().parse(request.body);
    return dependencies.service.submitReview(user, parseProblemId(request), input, request.id);
  });

  app.post("/api/v1/problems/:problemId/review-decision", async (request) => {
    const user = await requireUser(request);
    const input = manualReviewDecisionInputSchema.parse(request.body);
    return dependencies.service.finalizeReview(
      user,
      parseProblemId(request),
      input,
      request.id
    );
  });

  app.get("/api/v1/contests", async (request) => {
    const user = await requireUser(request);
    return dependencies.contestService.listContests(user);
  });

  app.post("/api/v1/contests", async (request) => {
    const user = await requireUser(request);
    const input = createContestInputSchema.strict().parse(request.body);
    return dependencies.contestService.createContest(user, input);
  });

  app.get("/api/v1/contests/:contestId", async (request) => {
    const user = await requireUser(request);
    return dependencies.contestService.getContest(user, parseContestId(request));
  });

  app.patch("/api/v1/contests/:contestId", async (request) => {
    const user = await requireUser(request);
    const input = updateContestInputSchema.strict().parse(request.body);
    return dependencies.contestService.updateContest(user, parseContestId(request), input);
  });

  return app;
}

export { sessionCookieName };
