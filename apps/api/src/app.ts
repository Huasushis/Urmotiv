import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import {
  casCallbackQuerySchema,
  casStartQuerySchema,
  claimRobotReviewTasksInputSchema,
  claimRobotReviewTasksResponseSchema,
  completeRobotReviewTaskInputSchema,
  renewRobotReviewTaskInputSchema,
  renewRobotReviewTaskResponseSchema,
  robotReviewTaskCompletionSchema,
  robotReviewTaskSchema,
  createContestInputSchema,
  createProblemInputSchema,
  demoLoginInputSchema,
  emailRegistrationInputSchema,
  emailVerificationInputSchema,
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
  updatePluginInputSchema,
  updateContestInputSchema,
  updateProblemInputSchema,
  updateReviewPolicyInputSchema,
  uploadProblemFileQuerySchema,
  withdrawProblemInputSchema
} from "@urmotiv/contracts";
import {
  CasAuthenticationError,
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
import { hasPermission } from "./permissions";
import { InMemoryDataStore, type DataStore } from "./repository";
import {
  createEmailVerificationUrl,
  type EmailVerificationDelivery
} from "./email-verification";
import type { ProblemFileStore } from "./problem-file-store";
import { ProblemFileService } from "./problem-file-service";
import { ProblemService, type SubmitCheckRunner } from "./service";
import type { TransferService } from "./transfer-service";
import type { AnklangCache } from "@urmotiv/plugin-anklang";
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
import { createProblemVisibility } from "./permissions";
import type { DatabaseRobotStore } from "./robot-store";
import { PluginReviewDecisionRunner } from "./review-decision";
import { ReviewPolicyService } from "./review-policy-service";

const sessionCookieName = "urmotiv_session";
const sessionLifetimeSeconds = 60 * 60 * 12;
const emailVerificationLifetimeSeconds = 30 * 60;
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
 * 依次运行所有已启用的提交前检查。任何一项要求阻止即整体阻止；
 * 各项返回的审核条目带上来源插件后汇总，供提交流程与手动检索共用。
 */
function createSubmitCheckRunner(host: TrustedPluginHost): SubmitCheckRunner {
  return {
    async run(input) {
      const checkIds = await host.listEnabledBeforeSubmitCheckIds();
      const collected: StoredReviewItemInput[] = [];
      for (const checkId of checkIds) {
        const result = await host.runBeforeSubmit(input, [checkId]);
        if (result.decision === "block") {
          return {
            blocked: { code: result.code, message: result.message },
            reviewItems: [],
            checksRun: checkIds.length
          };
        }
        const pluginId = host.pluginIdForCheckId(checkId);
        for (const item of result.reviewItems ?? []) {
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
      return { reviewItems: collected, checksRun: checkIds.length };
    }
  };
}

/** 进程内的查重结果缓存；键是题目内容摘要，过期后自动失效。 */
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
          if (entry.expiresAtMs <= currentMs || entries.size > 500) {
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
    reviewDecisions
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
    now
  };
}

export async function createApp(options: ApiAppOptions = {}): Promise<FastifyInstance> {
  const dependencies = createDependencies(options);
  await dependencies.pluginHost.initialize();
  const app = Fastify({
    logger: false,
    genReqId: () => randomUUID()
  });

  await app.register(cors, {
    origin: dependencies.allowedOrigins,
    credentials: true
  });
  await app.register(cookie);

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
      throw forbidden();
    }
    return user;
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
      throw forbidden();
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
      return reply.redirect(start.loginUrl);
    });

    app.get("/api/v1/auth/cas/callback", async (request, reply) => {
      const input = casCallbackQuerySchema.strict().parse(request.query);
      let completed: Awaited<ReturnType<CasClient["finishLogin"]>>;
      try {
        completed = await dependencies.casClient!.finishLogin(input);
      } catch (error) {
        if (error instanceof CasAuthenticationError) {
          throw unauthorized();
        }
        throw error;
      }
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
      return reply.redirect(completed.returnTo);
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

  app.get("/api/v1/tags", async (request) => {
    await requireUser(request);
    return { items: await dependencies.store.listTags() };
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
    const requireRobot = async (request: FastifyRequest): Promise<StoredUser> => {
      const header = request.headers.authorization;
      const token = typeof header === "string" && header.startsWith("Bearer ")
        ? header.slice("Bearer ".length).trim()
        : undefined;
      if (token === undefined || token.length === 0) {
        throw unauthorized();
      }
      const identity = await robots.authenticateToken(token);
      if (identity === undefined) {
        throw unauthorized();
      }
      const user = await dependencies.store.getUser(identity.userId);
      if (
        user === undefined ||
        user.accountType !== "robot" ||
        !hasPermission(user, "auth.login", {}, dependencies.now())
      ) {
        throw unauthorized();
      }
      return user;
    };

    const robotTaskFor = async (
      robotUser: StoredUser,
      assignment: { problemId: string; round: number; id: string; expiresAt: string }
    ) => {
      const problem = await dependencies.store.findVisibleProblem(
        assignment.problemId,
        createProblemVisibility(robotUser, dependencies.now())
      );
      if (
        problem === undefined ||
        problem.status !== "pending_review" ||
        problem.reviewRound !== assignment.round
      ) {
        return undefined;
      }
      const items = await dependencies.reviewItemStore.list(problem.id, problem.reviewRound, [
        "author",
        "reviewer"
      ]);
      return robotReviewTaskSchema.parse({
        assignmentId: assignment.id,
        leaseExpiresAt: assignment.expiresAt,
        problem: {
          id: problem.id,
          revision: problem.revision,
          reviewRound: problem.reviewRound,
          contentHash: computeProblemContentHash(problem),
          title: problem.title,
          type: problem.type,
          tagIds: problem.tagIds,
          basicStatement: problem.content.basicStatement,
          basicSolution: problem.content.basicSolution
        },
        reviewItems: items.map((item) => ({
          id: item.id,
          type: item.type,
          summary: item.summary,
          data: item.data,
          contentHash: item.contentHash,
          createdAt: item.createdAt
        }))
      });
    };

    app.post("/api/v1/robot/review-tasks/claim", async (request) => {
      const robotUser = await requireRobot(request);
      if (!hasPermission(robotUser, "problem.review", {}, dependencies.now())) {
        throw forbidden();
      }
      const input = claimRobotReviewTasksInputSchema.parse(request.body ?? {});
      const supported = input.supportedProblemTypes === undefined
        ? undefined
        : new Set(input.supportedProblemTypes);
      const candidates = await robots.listOpenRoundCandidates(robotUser.id, 50);
      const tasks = [];
      for (const candidate of candidates) {
        if (tasks.length >= input.maximumTasks) {
          break;
        }
        const problem = await dependencies.store.findVisibleProblem(
          candidate.problemId,
          createProblemVisibility(robotUser, dependencies.now())
        );
        if (
          problem === undefined ||
          problem.status !== "pending_review" ||
          problem.reviewRound !== candidate.round ||
          (supported !== undefined && !supported.has(problem.type))
        ) {
          continue;
        }
        const assignment = await robots.createAssignment(
          candidate.roundId,
          robotUser.id,
          input.leaseSeconds
        );
        if (assignment === undefined) {
          continue;
        }
        const task = await robotTaskFor(robotUser, assignment);
        if (task === undefined) {
          await robots.closeAssignment(assignment.id, robotUser.id);
          continue;
        }
        tasks.push(task);
      }
      return claimRobotReviewTasksResponseSchema.parse({ items: tasks });
    });

    app.post("/api/v1/robot/review-tasks/:assignmentId/renew", async (request) => {
      const robotUser = await requireRobot(request);
      const assignmentId = parseAssignmentId(request);
      const input = renewRobotReviewTaskInputSchema.parse(request.body ?? {});
      const renewed = await robots.renewAssignment(
        assignmentId,
        robotUser.id,
        input.expectedLeaseExpiresAt,
        input.leaseSeconds
      );
      if (renewed === undefined) {
        throw notFound();
      }
      return renewRobotReviewTaskResponseSchema.parse({
        assignmentId,
        leaseExpiresAt: renewed
      });
    });

    app.post("/api/v1/robot/review-tasks/:assignmentId/complete", async (request) => {
      const robotUser = await requireRobot(request);
      const assignmentId = parseAssignmentId(request);
      const input = completeRobotReviewTaskInputSchema.parse(request.body);
      const assignment = await robots.findAssignment(assignmentId, robotUser.id);
      if (assignment === undefined) {
        throw notFound();
      }
      if (
        assignment.expiresAt !== input.expectedLeaseExpiresAt ||
        Date.parse(assignment.expiresAt) <= dependencies.now().getTime()
      ) {
        throw conflict("任务租约已变化或过期，请重新领取。");
      }
      const problem = await dependencies.store.findVisibleProblem(
        assignment.problemId,
        createProblemVisibility(robotUser, dependencies.now())
      );
      if (problem === undefined) {
        throw notFound();
      }
      if (problem.revision !== input.expectedProblemRevision) {
        throw conflict("题目内容已更新，本次分析结果不再适用。");
      }

      let result: "success" | "failure" = "failure";
      try {
        const summary = await dependencies.service.submitReview(
          robotUser,
          assignment.problemId,
          input.review,
          request.id
        );
        result = "success";
        await robots.closeAssignment(assignment.id, robotUser.id);
        return robotReviewTaskCompletionSchema.parse({
          assignmentId: assignment.id,
          accepted: true,
          problemStatus: summary.status === "approved"
            ? "approved"
            : summary.status === "rejected"
              ? "rejected"
              : "pending_review"
        });
      } finally {
        await robots
          .writeCompletionAudit({
            reviewerUserId: robotUser.id,
            problemId: assignment.problemId,
            assignmentId: assignment.id,
            experimentVersion: input.experimentVersion,
            modelProfileName: input.modelProfileName,
            result
          })
          .catch(() => undefined);
      }
    });
  }

  const problemFiles = dependencies.problemFiles;
  const transfer = dependencies.transfer;
  if (problemFiles !== undefined || transfer !== undefined) {
    app.addContentTypeParser(
      "application/octet-stream",
      (_request, payload, done) => done(null, payload)
    );
  }

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
