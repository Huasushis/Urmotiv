import {
  adminAuditResponseSchema,
  adminGeneralSettingsSchema,
  updateAdminGeneralSettingsInputSchema,
  adminPermissionsResponseSchema,
  adminPermissionCatalogResponseSchema,
  adminRoleDefaultsResponseSchema,
  adminUserPermissionDeltaResponseSchema,
  adminUsersResponseSchema,
  adminRoleManagementResponseSchema,
  adminRoleResponseSchema,
  adminServiceAccountsResponseSchema,
  adminPluginListResponseSchema,
  adminPluginResponseSchema,
  importHistoryResponseSchema,
  ustcOAuthSettingsSchema,
  batchAccountCreateResponseSchema,
  contestListResponseSchema,
  contestSchema,
  emailVerificationPendingResponseSchema,
  exportJobViewSchema,
  exportPreviewResponseSchema,
  importJobViewSchema,
  importPreviewResponseSchema,
  managedTagCatalogResponseSchema,
  packageUploadResponseSchema,
  problemFileListResponseSchema,
  problemFileSummarySchema,
  problemListResponseSchema,
  problemAccessListResponseSchema,
  problemSchema,
  profileViewSchema,
  reviewItemListResponseSchema,
  reviewPolicyViewSchema,
  reviewSuggestionViewSchema,
  reviewRoundSummarySchema,
  sessionResponseSchema,
  similarityCheckResponseSchema,
  tagAliasMutationResponseSchema,
  tagCatalogMutationResponseSchema,
  tagDeactivationPreviewSchema,
  okResponseSchema,
  tagSchema,
  updateProfileInputSchema,
  fermataHealthSchema,
  fermataPublicSettingsResponseSchema,
  type FermataHealth,
  type FermataPublicSettings,
  type AdminAuditResponse,
  type AdminGeneralSettings,
  type UpdateAdminGeneralSettingsInput,
  type AdminPermissionsResponse,
  type AdminPermissionCatalogResponse,
  type AdminRoleDefaultsResponse,
  type UpdateAdminRoleDefaultsInput,
  type AdminUserPermissionDeltaResponse,
  type UpdateAdminUserPermissionDeltaInput,
  type AdminUsersResponse,
  type AdminRoleManagementResponse,
  type AdminRoleResponse,
  type AdminServiceAccountsResponse,
  type UpdateFermataPublicSettingsInput,
  type ImportHistoryQuery,
  type ImportHistoryResponse,
  type UstcOAuthSettings,
  type CreateAdminRoleInput,
  type UpdateAdminRoleInput,
  type UpdateUstcOAuthSettingsInput,
  type ProfileView,
  type AdminPlugin,
  type AdminPluginListResponse,
  type CreateProblemInput,
  type CreateContestInput,
  type CreateExportJobRequest,
  type CreateImportJobRequest,
  type Contest,
  type ContestListResponse,
  type ExportJobView,
  type ExportPreviewRequest,
  type ExportPreviewResponse,
  type ImportJobView,
  type ImportPreviewRequest,
  type ImportPreviewResponse,
  type ManagedTagCatalogResponse,
  type PackageUploadResponse,
  type Problem,
  type ProblemFileCategory,
  type ProblemFileListResponse,
  type ProblemFileSummary,
  type ProblemListQuery,
  type ProblemListResponse,
  type ProblemAccessListResponse,
  type ReviewInput,
  type ApplyReviewSuggestionsInput,
  type ReviewPolicyView,
  type ReviewItemListResponse,
  type ReviewRoundSummary,
  type ReviewSuggestionView,
  type SessionResponse,
  type SimilarityCheckResponse,
  type ConfirmTagDeactivationInput,
  type CreateTagAliasInput,
  type CreateTagCatalogItemInput,
  type DeleteTagAliasInput,
  type TagAliasMutationResponse,
  type TagCatalogMutationResponse,
  type TagDeactivationPreview,
  type TagDeactivationPreviewInput,
  type UpdateTagAliasInput,
  type UpdateTagCatalogItemInput,
  type UpdateContestInput,
  type UpdatePluginRequest,
  type UpdateProfileInput,
  type UpdateReviewPolicyInput,
  type UpdateProblemInput,
  type BatchAccountCreateResponse
} from "@urmotiv/contracts";
import { z } from "zod";

export class ApiError extends Error {
  readonly status: number;
  readonly requestId: string | undefined;
  readonly fieldErrors: Record<string, string[]> | undefined;

  constructor(
    message: string,
    status: number,
    options: { requestId?: string; fieldErrors?: Record<string, string[]> } = {}
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.requestId = options.requestId;
    this.fieldErrors = options.fieldErrors;
  }
}

const tagsResponseSchema = z.object({ items: z.array(tagSchema) });
const problemFileUploadResponseSchema = z
  .object({
    item: problemFileSummarySchema,
    revision: z.number().int().positive()
  })
  .strict();

export type ProblemFileUploadResponse = {
  item: ProblemFileSummary;
  revision: number;
};

export type ProblemFileUploadRequest = {
  file: File;
  expectedRevision: number;
  category: ProblemFileCategory;
  logicalPath: string;
  position?: number;
  replaceExisting?: boolean;
  bindJudgeProgram?: boolean;
};

function apiBaseUrl(): string {
  const configured = import.meta.env.VITE_API_BASE_URL?.trim();
  return (configured || "/api/v1").replace(/\/$/, "");
}

function demoFallbackEnabled(): boolean {
  return import.meta.env.VITE_DEMO_FALLBACK === "true";
}

type RuntimeSchema<T> = {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
};

async function request<T>(path: string, init: RequestInit, schema: RuntimeSchema<T>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl()}${path}`, {
      credentials: "include",
      ...init,
      headers: {
        Accept: "application/json",
        ...init.headers
      }
    });
  } catch {
    throw new ApiError("无法连接到服务端。请确认 SSH 转发和服务状态。", 0);
  }

  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const error = z
      .object({
        error: z.object({
          message: z.string().default("请求失败"),
          requestId: z.string().optional(),
          fieldErrors: z.record(z.string(), z.array(z.string())).optional()
        })
      })
      .safeParse(body);
    if (error.success) {
      throw new ApiError(error.data.error.message, response.status, {
        ...(error.data.error.requestId ? { requestId: error.data.error.requestId } : {}),
        ...(error.data.error.fieldErrors ? { fieldErrors: error.data.error.fieldErrors } : {})
      });
    }
    throw new ApiError("请求失败，请稍后重试。", response.status);
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError("服务端返回的数据格式不符合约定。", 502);
  }
  return parsed.data;
}

function json(body: unknown, method: "POST" | "PATCH" | "DELETE" = "POST"): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

async function fallback<T>(requestFn: () => Promise<T>, demoFn: () => Promise<T>): Promise<T> {
  if (demoFallbackEnabled()) {
    return demoFn();
  }
  return requestFn();
}

export function getSession(): Promise<SessionResponse> {
  return fallback(
    () => request("/session", { method: "GET" }, sessionResponseSchema),
    async () => (await import("./demo-store")).getDemoSession()
  );
}

export function demoLogin(userId: string): Promise<SessionResponse> {
  return fallback(
    () => request("/auth/demo-login", json({ userId }), sessionResponseSchema),
    async () => (await import("./demo-store")).demoLogin(userId)
  );
}

export function emailLogin(input: { email: string; password: string }): Promise<SessionResponse> {
  return request("/auth/email-login", json(input), sessionResponseSchema);
}

export function usernameLogin(input: { username: string; password: string }): Promise<SessionResponse> {
  return request("/auth/username-login", json(input), sessionResponseSchema);
}

export function rootLogin(input: {
  identifier: "root" | "0";
  password: string;
}): Promise<SessionResponse> {
  return request("/auth/root-login", json(input), sessionResponseSchema);
}

export function accountLogin(input: { identifier: string; password: string }): Promise<SessionResponse> {
  const identifier = input.identifier.trim();
  const normalizedIdentifier = identifier.toLocaleLowerCase();
  if (normalizedIdentifier === "root" || normalizedIdentifier === "0") {
    return rootLogin({
      identifier: normalizedIdentifier as "root" | "0",
      password: input.password
    });
  }
  if (identifier.includes("@")) {
    return emailLogin({ email: identifier, password: input.password });
  }
  return usernameLogin({ username: identifier, password: input.password });
}

export function emailRegister(input: {
  email: string;
  password: string;
  nickname: string;
}): Promise<{ ok: true; verificationPending: true }> {
  return request("/auth/email-register", json(input), emailVerificationPendingResponseSchema);
}

export function resendEmailVerification(email: string): Promise<{ ok: true; verificationPending: true }> {
  return request("/auth/email-verification/resend", json({ email }), emailVerificationPendingResponseSchema);
}

export function verifyEmail(token: string): Promise<{ ok: true }> {
  return request("/auth/email-verification/verify", json({ token }), okResponseSchema);
}

export function logout(): Promise<{ ok: true }> {
  return request("/auth/logout", json({}), okResponseSchema);
}

export function getMyProfile(): Promise<ProfileView> {
  return request("/me", { method: "GET" }, profileViewSchema);
}

export function updateMyProfile(input: UpdateProfileInput): Promise<ProfileView> {
  return request("/me", json(input, "PATCH"), profileViewSchema);
}

export function createBatchAccounts(text: string): Promise<BatchAccountCreateResponse> {
  return request(
    "/admin/accounts/batch",
    json({ text }),
    batchAccountCreateResponseSchema
  );
}

export function uploadMyAvatar(file: Blob): Promise<ProfileView> {
  return request(
    "/me/avatar",
    {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: file
    },
    profileViewSchema
  );
}

export function deleteMyAvatar(): Promise<ProfileView> {
  return request("/me/avatar", { method: "DELETE" }, profileViewSchema);
}

/** 站内头像地址（受权限检查）；无头像时该地址返回 404，由客户端显示默认头像。 */
export function avatarUrlFor(userId: string): string {
  return `/api/v1/users/${encodeURIComponent(userId)}/avatar`;
}

export function listAdminPlugins(): Promise<AdminPluginListResponse> {
  return request("/admin/plugins", { method: "GET" }, adminPluginListResponseSchema);
}

export function getAdminGeneralSettings(): Promise<{ settings: AdminGeneralSettings }> {
  return request(
    "/admin/settings",
    { method: "GET" },
    z.object({ settings: adminGeneralSettingsSchema }).strict()
  );
}
export function updateAdminGeneralSettings(
  input: UpdateAdminGeneralSettingsInput
): Promise<{ settings: AdminGeneralSettings }> {
  return request(
    "/admin/settings",
    { ...json(input), method: "PUT" },
    z.object({ settings: adminGeneralSettingsSchema }).strict()
  );
}

export function listAdminRoles(): Promise<AdminRoleManagementResponse> {
  return request("/admin/roles", { method: "GET" }, adminRoleManagementResponseSchema);
}

export function createAdminRole(input: CreateAdminRoleInput): Promise<AdminRoleResponse> {
  return request(
    "/admin/roles",
    { ...json(input), method: "POST" },
    adminRoleResponseSchema
  );
}

export function updateAdminRole(roleId: string, input: UpdateAdminRoleInput): Promise<AdminRoleResponse> {
  return request(
    `/admin/roles/${encodeURIComponent(roleId)}`,
    { ...json(input), method: "PUT" },
    adminRoleResponseSchema
  );
}

export function listAdminPermissions(): Promise<AdminPermissionsResponse> {
  return request("/admin/permissions", { method: "GET" }, adminPermissionsResponseSchema);
}
export function listAdminPermissionCatalog(): Promise<AdminPermissionCatalogResponse> {
  return request("/admin/permissions/catalog", { method: "GET" }, adminPermissionCatalogResponseSchema);
}

export function listAdminUsers(search = "", page = 1, pageSize = 30): Promise<AdminUsersResponse> {
  const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (search.trim()) query.set("search", search.trim());
  return request(`/admin/users?${query.toString()}`, { method: "GET" }, adminUsersResponseSchema);
}

export function getAdminUserPermissions(userId: string): Promise<AdminUserPermissionDeltaResponse> {
  return request(
    `/admin/users/${encodeURIComponent(userId)}/permissions`,
    { method: "GET" },
    adminUserPermissionDeltaResponseSchema
  );
}

export function updateAdminUserPermissions(
  userId: string,
  input: UpdateAdminUserPermissionDeltaInput
): Promise<AdminUserPermissionDeltaResponse> {
  return request(
    `/admin/users/${encodeURIComponent(userId)}/permissions`,
    { ...json(input), method: "PUT" },
    adminUserPermissionDeltaResponseSchema
  );
}

export function getAdminRoleDefaults(): Promise<AdminRoleDefaultsResponse> {
  return request("/admin/roles/defaults", { method: "GET" }, adminRoleDefaultsResponseSchema);
}

export function updateAdminRoleDefaults(
  input: UpdateAdminRoleDefaultsInput
): Promise<AdminRoleDefaultsResponse> {
  return request(
    "/admin/roles/defaults",
    { ...json(input), method: "PUT" },
    adminRoleDefaultsResponseSchema
  );
}

export function listAdminServiceAccounts(): Promise<AdminServiceAccountsResponse> {
  return request("/admin/service-accounts", { method: "GET" }, adminServiceAccountsResponseSchema);
}

export function listAdminAudit(page = 1, pageSize = 20): Promise<AdminAuditResponse> {
  return request(
    `/admin/audit?page=${page}&pageSize=${pageSize}`,
    { method: "GET" },
    adminAuditResponseSchema
  );
}

const ustcOAuthResponseSchema = z.object({ settings: ustcOAuthSettingsSchema }).strict();

export function getAdminUstcOAuthSettings(): Promise<{ settings: UstcOAuthSettings }> {
  return request("/admin/oauth/ustc", { method: "GET" }, ustcOAuthResponseSchema);
}

export function updateAdminUstcOAuthSettings(
  input: UpdateUstcOAuthSettingsInput
): Promise<{ settings: UstcOAuthSettings }> {
  const payload = input.clientSecret?.trim()
    ? input
    : { ...input, clientSecret: undefined };
  return request(
    "/admin/oauth/ustc",
    { ...json(payload), method: "PUT" },
    ustcOAuthResponseSchema
  );
}

export function listImportHistory(
  query: Partial<ImportHistoryQuery> = {}
): Promise<ImportHistoryResponse> {
  const parameters = new URLSearchParams();
  if (query.page !== undefined) parameters.set("page", String(query.page));
  if (query.pageSize !== undefined) parameters.set("pageSize", String(query.pageSize));
  if (query.state !== undefined) parameters.set("state", query.state);
  if (query.format !== undefined) parameters.set("format", query.format);
  const suffix = parameters.toString() ? `?${parameters.toString()}` : "";
  return request(`/transfer/imports${suffix}`, { method: "GET" }, importHistoryResponseSchema);
}

export function getFermataHealth(): Promise<{ health: FermataHealth }> {
  return request(
    "/admin/fermata/health",
    { method: "GET" },
    z.object({ health: fermataHealthSchema }).strict()
  );
}

export function getFermataSettings(): Promise<{ settings: FermataPublicSettings; revision: number; secretsConfigured: boolean }> {
  return request(
    "/admin/fermata/settings",
    { method: "GET" },
    fermataPublicSettingsResponseSchema
  );
}

export function updateFermataSettings(input: UpdateFermataPublicSettingsInput): Promise<{
  settings: FermataPublicSettings;
  revision: number;
  secretsConfigured: boolean;
}> {
  return request(
    "/admin/fermata/settings",
    { ...json(input), method: "PUT" },
    fermataPublicSettingsResponseSchema
  );
}

export function listManagedTagCatalog(): Promise<ManagedTagCatalogResponse> {
  return request("/admin/tag-catalog", { method: "GET" }, managedTagCatalogResponseSchema);
}

export function createTagCatalogItem(
  input: CreateTagCatalogItemInput
): Promise<TagCatalogMutationResponse> {
  return request("/admin/tag-catalog/items", json(input), tagCatalogMutationResponseSchema);
}

export function updateTagCatalogItem(
  tagId: string,
  input: UpdateTagCatalogItemInput
): Promise<TagCatalogMutationResponse> {
  return request(
    `/admin/tag-catalog/items/${encodeURIComponent(tagId)}`,
    { ...json(input), method: "PATCH" },
    tagCatalogMutationResponseSchema
  );
}

export function createTagAlias(
  tagId: string,
  input: CreateTagAliasInput
): Promise<TagAliasMutationResponse> {
  return request(
    `/admin/tag-catalog/items/${encodeURIComponent(tagId)}/aliases`,
    json(input),
    tagAliasMutationResponseSchema
  );
}

export function updateTagAlias(
  tagId: string,
  aliasId: string,
  input: UpdateTagAliasInput
): Promise<TagCatalogMutationResponse> {
  return request(
    `/admin/tag-catalog/items/${encodeURIComponent(tagId)}/aliases/${encodeURIComponent(aliasId)}`,
    { ...json(input), method: "PATCH" },
    tagCatalogMutationResponseSchema
  );
}

export function deleteTagAlias(
  tagId: string,
  aliasId: string,
  input: DeleteTagAliasInput
): Promise<TagCatalogMutationResponse> {
  return request(
    `/admin/tag-catalog/items/${encodeURIComponent(tagId)}/aliases/${encodeURIComponent(aliasId)}`,
    { ...json(input), method: "DELETE" },
    tagCatalogMutationResponseSchema
  );
}

export function previewTagDeactivation(
  tagId: string,
  input: TagDeactivationPreviewInput
): Promise<TagDeactivationPreview> {
  return request(
    `/admin/tag-catalog/items/${encodeURIComponent(tagId)}/deactivation-preview`,
    json(input),
    tagDeactivationPreviewSchema
  );
}

export function confirmTagDeactivation(
  tagId: string,
  input: ConfirmTagDeactivationInput
): Promise<TagCatalogMutationResponse> {
  return request(
    `/admin/tag-catalog/items/${encodeURIComponent(tagId)}/deactivate`,
    json(input),
    tagCatalogMutationResponseSchema
  );
}

export async function updateAdminPlugin(
  pluginId: string,
  input: UpdatePluginRequest
): Promise<AdminPlugin> {
  const response = await request(
    `/admin/plugins/${encodeURIComponent(pluginId)}`,
    { ...json(input), method: "PATCH" },
    adminPluginResponseSchema
  );
  return response.item;
}

export function getReviewPolicy(): Promise<ReviewPolicyView> {
  return request("/review-policy", { method: "GET" }, reviewPolicyViewSchema);
}

export function updateReviewPolicy(input: UpdateReviewPolicyInput): Promise<ReviewPolicyView> {
  return request(
    "/review-policy",
    { ...json(input), method: "PATCH" },
    reviewPolicyViewSchema
  );
}

export function casStartUrl(returnPath: string): string {
  const parameters = new URLSearchParams({ returnPath });
  return `${apiBaseUrl()}/auth/cas/start?${parameters.toString()}`;
}
export function ustcOAuthStartUrl(returnPath: string): string {
  const parameters = new URLSearchParams({ returnPath });
  return `${apiBaseUrl()}/auth/ustc/start?${parameters.toString()}`;
}


export function listTags() {
  return fallback(
    () => request("/tags", { method: "GET" }, tagsResponseSchema),
    async () => (await import("./demo-store")).listDemoTags()
  );
}

export function listProblems(query: ProblemListQuery): Promise<ProblemListResponse> {
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") {
      parameters.set(key, String(value));
    }
  }
  const suffix = parameters.toString();
  return fallback(
    () => request(`/problems${suffix ? `?${suffix}` : ""}`, { method: "GET" }, problemListResponseSchema),
    async () => (await import("./demo-store")).listDemoProblems(query)
  );
}

export function getProblem(id: string): Promise<Problem> {
  return fallback(
    () => request(`/problems/${encodeURIComponent(id)}`, { method: "GET" }, problemSchema),
    async () => (await import("./demo-store")).getDemoProblem(id)
  );
}

export function createProblem(input: CreateProblemInput): Promise<Problem> {
  return fallback(
    () => request("/problems", json(input), problemSchema),
    async () => (await import("./demo-store")).createDemoProblem(input)
  );
}

export function updateProblem(id: string, input: UpdateProblemInput): Promise<Problem> {
  return fallback(
    () =>
      request(
        `/problems/${encodeURIComponent(id)}`,
        { ...json(input), method: "PATCH" },
        problemSchema
      ),
    async () => (await import("./demo-store")).updateDemoProblem(id, input)
  );
}

export function deleteProblem(id: string, expectedRevision: number): Promise<{ ok: true }> {
  return fallback(
    () => request(
      `/problems/${encodeURIComponent(id)}`,
      json({ expectedRevision }, "DELETE"),
      okResponseSchema
    ),
    async () => (await import("./demo-store")).deleteDemoProblem(id, expectedRevision)
  );
}

export function listProblemFiles(problemId: string): Promise<ProblemFileListResponse> {
  return request(
    `/problems/${encodeURIComponent(problemId)}/files`,
    { method: "GET" },
    problemFileListResponseSchema
  );
}

export function uploadProblemFile(
  problemId: string,
  input: ProblemFileUploadRequest
): Promise<ProblemFileUploadResponse> {
  const parameters = new URLSearchParams({
    expectedRevision: String(input.expectedRevision),
    category: input.category,
    logicalPath: input.logicalPath,
    position: String(input.position ?? 0),
    originalName: input.file.name,
    mediaType: input.file.type.trim().toLowerCase() || "application/octet-stream",
    replaceExisting: String(input.replaceExisting ?? false),
    bindJudgeProgram: String(input.bindJudgeProgram ?? false)
  });
  return request(
    `/problems/${encodeURIComponent(problemId)}/files?${parameters.toString()}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: input.file
    },
    problemFileUploadResponseSchema
  );
}

/** Markdown 中只保存这个受权限检查的站内地址，不保存对象存储位置。 */
export function problemFileReferenceUrl(problemId: string, fileId: string): string {
  return `/api/v1/problems/${encodeURIComponent(problemId)}/files/${encodeURIComponent(fileId)}`;
}

export function problemFileDownloadUrl(problemId: string, fileId: string): string {
  return `${apiBaseUrl()}/problems/${encodeURIComponent(problemId)}/files/${encodeURIComponent(fileId)}`;
}

export function submitProblem(id: string, expectedRevision: number): Promise<Problem> {
  return fallback(
    () => request(`/problems/${encodeURIComponent(id)}/submit`, json({ expectedRevision }), problemSchema),
    async () => (await import("./demo-store")).submitDemoProblem(id, expectedRevision)
  );
}

export function withdrawProblem(id: string, expectedRevision: number, reason = ""): Promise<Problem> {
  return fallback(
    () =>
      request(
        `/problems/${encodeURIComponent(id)}/withdraw`,
        json({ expectedRevision, reason }),
        problemSchema
      ),
    async () => (await import("./demo-store")).withdrawDemoProblem(id, expectedRevision)
  );
}

export function listReviews(id: string): Promise<ReviewRoundSummary> {
  return fallback(
    () => request(`/problems/${encodeURIComponent(id)}/reviews`, { method: "GET" }, reviewRoundSummarySchema),
    async () => (await import("./demo-store")).listDemoReviews(id)
  );
}

export function createReview(id: string, input: ReviewInput): Promise<ReviewRoundSummary> {
  return fallback(
    () => request(`/problems/${encodeURIComponent(id)}/reviews`, json(input), reviewRoundSummarySchema),
    async () => (await import("./demo-store")).createDemoReview(id, input)
  );
}

export function getReviewSuggestions(id: string): Promise<ReviewSuggestionView> {
  return fallback(
    () =>
      request(
        `/problems/${encodeURIComponent(id)}/review-suggestions`,
        { method: "GET" },
        reviewSuggestionViewSchema
      ),
    async () => (await import("./demo-store")).getDemoReviewSuggestions(id)
  );
}

export function applyReviewSuggestions(
  id: string,
  input: ApplyReviewSuggestionsInput
): Promise<Problem> {
  return fallback(
    () =>
      request(
        `/problems/${encodeURIComponent(id)}/review-suggestions/apply`,
        json(input),
        problemSchema
      ),
    async () => (await import("./demo-store")).applyDemoReviewSuggestions(id, input)
  );
}

export function listReviewItems(id: string): Promise<ReviewItemListResponse> {
  return request(
    `/problems/${encodeURIComponent(id)}/review-items`,
    { method: "GET" },
    reviewItemListResponseSchema
  );
}

export function runSimilarityCheck(id: string): Promise<SimilarityCheckResponse> {
  return request(`/problems/${encodeURIComponent(id)}/similarity-check`, json({}), similarityCheckResponseSchema);
}

export function recordProblemActivity(id: string, activeSeconds: number): Promise<{ ok: true }> {
  return request(
    `/problems/${encodeURIComponent(id)}/access-heartbeat`,
    json({ activeSeconds }),
    okResponseSchema
  );
}

export function listProblemAccess(id: string): Promise<ProblemAccessListResponse> {
  return fallback(
    () => request(`/problems/${encodeURIComponent(id)}/access`, { method: "GET" }, problemAccessListResponseSchema),
    async () => (await import("./demo-store")).listDemoProblemAccess(id)
  );
}

export function listContests(): Promise<ContestListResponse> {
  return request("/contests", { method: "GET" }, contestListResponseSchema);
}

export function getContest(id: string): Promise<Contest> {
  return request(`/contests/${encodeURIComponent(id)}`, { method: "GET" }, contestSchema);
}

export function createContest(input: CreateContestInput): Promise<Contest> {
  return request("/contests", json(input), contestSchema);
}

export function updateContest(id: string, input: UpdateContestInput): Promise<Contest> {
  return request(
    `/contests/${encodeURIComponent(id)}`,
    { ...json(input), method: "PATCH" },
    contestSchema
  );
}

export function uploadProblemPackage(file: File): Promise<PackageUploadResponse> {
  return request(
    `/transfer/uploads?originalName=${encodeURIComponent(file.name)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: file
    },
    packageUploadResponseSchema
  );
}

export function previewImport(input: ImportPreviewRequest): Promise<ImportPreviewResponse> {
  return request("/transfer/imports/preview", json(input), importPreviewResponseSchema);
}

export function createImportJob(input: CreateImportJobRequest): Promise<ImportJobView> {
  return request("/transfer/imports", json(input), importJobViewSchema);
}

export function getImportJob(jobId: string): Promise<ImportJobView> {
  return request(`/transfer/imports/${encodeURIComponent(jobId)}`, { method: "GET" }, importJobViewSchema);
}

export function previewExport(input: ExportPreviewRequest): Promise<ExportPreviewResponse> {
  return request("/transfer/exports/preview", json(input), exportPreviewResponseSchema);
}

export function createExportJob(input: CreateExportJobRequest): Promise<ExportJobView> {
  return request("/transfer/exports", json(input), exportJobViewSchema);
}

export function getExportJob(jobId: string): Promise<ExportJobView> {
  return request(`/transfer/exports/${encodeURIComponent(jobId)}`, { method: "GET" }, exportJobViewSchema);
}

export function exportDownloadUrl(jobId: string): string {
  return `${apiBaseUrl()}/transfer/exports/${encodeURIComponent(jobId)}/download`;
}
