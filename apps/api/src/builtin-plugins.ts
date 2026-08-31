import {
  anklangCheckId,
  anklangSearchResultSchema,
  anklangReviewItemType,
  anklangSettingsSchema,
  createAnklangIndexAdapter,
  createAnklangUnavailableReviewItem,
  createAnklangCheck,
  type AnklangCache,
  type AnklangFetch,
  type AnklangIndexAdapter
} from "@urmotiv/plugin-anklang";
import {
  defaultReviewRuleId,
  registerDefaultReviewPlugin
} from "@urmotiv/plugin-review-default";
import {
  hydroAdapterVersion,
  registerHydroFormatPlugin
} from "@urmotiv/plugin-hydro-format";
import {
  fpsAdapterVersion,
  registerFpsFormatPlugin
} from "@urmotiv/plugin-fps-format";

import type { BeforeSubmitCheck, PluginRegistry } from "@urmotiv/plugin-sdk";
import type { TrustedPluginDefinition } from "./plugin-host";

/**
 * 内置插件清单。API 只认识这些随服务一起发布的描述，不会加载上传的代码。
 * 需要运行时依赖（当前设置、密钥、缓存）的钩子通过 createBuiltinPluginDefinitions
 * 的运行时参数注入；不提供运行时时，插件仍会登记清单和设置，但不注册钩子。
 */

export interface AnklangHookRuntime {
  /** 插件已启用时返回其当前设置，否则返回 undefined。 */
  readSettings(): Promise<unknown | undefined>;
  /** 读取名为 serviceToken 的插件密钥；未配置返回 undefined。 */
  readToken(): Promise<string | undefined>;
  /** 读取名为 embeddingApiKey 的嵌入提供方密钥；未配置返回 undefined。 */
  readEmbeddingApiKey(): Promise<string | undefined>;
  readonly cache: AnklangCache;
  /** 仅测试使用：替换 HTTP 客户端。 */
  readonly fetch?: AnklangFetch;
}

export interface BuiltinPluginRuntime {
  readonly anklang?: AnklangHookRuntime;
}

export function createAnklangIndexAdapterForRuntime(
  runtime: AnklangHookRuntime
): AnklangIndexAdapter {
  return createAnklangIndexAdapter(runtime);
}

export const anklangPluginId = "org.ustc.urmotiv.anklang";
export const anklangServiceTokenSecretName = "serviceToken";
export const anklangEmbeddingApiKeySecretName = "embeddingApiKey";
export const fermataPluginId = "org.ustc.urmotiv.fermata-control";
export const fermataManagementTokenSecretName = "managementToken";
export const hydroFormatPluginId = "org.ustc.urmotiv.hydro-format";
export const fpsFormatPluginId = "org.ustc.urmotiv.fps-format";

export function createBuiltinPluginDefinitions(
  runtime: BuiltinPluginRuntime = {}
): readonly TrustedPluginDefinition[] {
  return [
    {
      source: "builtin:review-default",
      initialState: "enabled",
      requiresRestart: false,
      manifest: {
        id: "org.ustc.urmotiv.review-default", name: "默认审核人数规则", version: "1.0.0",
        apiVersion: "1", serverEntry: "dist/index.js", permissions: [], settingsSchema: "settings.schema.json"
      },
      reviewRuleSettingsSchemas: {
        [defaultReviewRuleId]: {
          type: "object", additionalProperties: false,
          properties: {
            requiredApprovals: {
              type: "integer", minimum: 1, maximum: 100, default: 2,
              title: "通过所需人数",
              description: "至少有多少份有效的通过意见后，题目才能通过审核。"
            },
            maximumRejections: {
              type: "integer", minimum: 0, maximum: 100, default: 0,
              title: "允许的不通过人数",
              description: "不通过意见超过这个人数时，审核结果为不通过。填 0 表示任何一份不通过意见都会阻止通过。"
            },
            countRobotReviews: {
              type: "boolean", default: false,
              title: "计算机器人意见",
              description: "开启后，仍有审核权限的机器人意见会和人工意见一起计数。"
            }
          }
        }
      },
      registerHooks: registerDefaultReviewPlugin
    },
    {
      source: "builtin:anklang",
      manifest: {
        id: anklangPluginId, name: "原题相似度检查", version: "0.4.0", apiVersion: "1",
        serverEntry: "dist/index.js", permissions: ["org.ustc.urmotiv.anklang.configure", "org.ustc.urmotiv.anklang.results.read"], settingsSchema: "settings.schema.json"
      },
      secretDefinitions: [{
        name: anklangServiceTokenSecretName,
        label: "服务认证令牌",
        description: "在服务器运行 `openssl rand -hex 32` 生成，并把同一个值设置为 Anklang 的 ANKLANG_SERVICE_TOKEN；完整内容只会加密保存，不会在页面重新显示。"
      }, {
        name: anklangEmbeddingApiKeySecretName,
        label: "嵌入提供方 API 密钥",
        description: "仅本地或混合检索需要。它是 OpenAI 兼容嵌入接口的 API 密钥（与 serviceToken 用途不同）；完整内容只会加密保存，不会在页面重新显示。"
      }],
      settingsSchema: {
        type: "object", additionalProperties: false, required: ["baseUrl"],
        properties: {
          baseUrl: {
            type: "string", format: "uri", title: "Anklang 服务地址",
            description: "Urmotiv 调用原题检索服务的本地或私有 HTTP/HTTPS 地址；认证令牌单独保存。"
          },
          searchMode: {
            type: "string",
            oneOf: [
              { const: "yuantiji", title: "仅 yuantiji 公共题库（推荐）" },
              { const: "local", title: "仅 Urmotiv 本地题库" },
              { const: "hybrid", title: "yuantiji 与本地题库" }
            ],
            default: "yuantiji",
            title: "检索来源",
            description: "仅 yuantiji 时无需填写嵌入模型，也不会把 Urmotiv 题目写入本地相似度索引。"
          },
          yuantijiBaseUrl: {
            type: "string", format: "uri", default: "https://yuantiji.ac",
            title: "yuantiji 服务地址",
            description: "公共原题机的 HTTPS 根地址；题面会直接发送到该服务检索。"
          },
          yuantijiRerank: {
            type: "boolean", default: false, title: "请求 yuantiji 重排",
            description: "重排会增加公共服务开销和等待时间；通常保持关闭。"
          },
          embeddingProvider: {
            type: "object", additionalProperties: false, required: ["baseUrl", "model", "dimension"],
            title: "嵌入提供方",
            description: "Anklang 生成嵌入所用的模型提供方；API 密钥以 embeddingApiKey 插件密钥单独加密保存，不会在此显示。",
            properties: {
              protocol: {
                type: "string", oneOf: [{ const: "openai", title: "OpenAI 兼容接口" }],
                default: "openai",
                title: "接口协议",
                description: "使用 OpenAI 兼容的 POST {地址}/embeddings 接口。"
              },
              baseUrl: {
                type: "string", format: "uri", title: "嵌入提供方地址",
                description: "OpenAI 兼容 API 的 v1 根地址，例如 https://…/v1；客户端会请求其 /embeddings。允许 HTTPS，隔离测试可用本地/私有 HTTP。"
              },
              model: {
                type: "string", minLength: 1, maxLength: 200, title: "嵌入模型名称"
              },
              dimension: {
                type: "integer", minimum: 1, maximum: 4096, title: "嵌入向量维度"
              }
            }
          },
          apiVersion: {
            type: "string",
            oneOf: [
              { const: "2", title: "v2（推荐）" },
              { const: "1", title: "v1（仅迁移或回滚）" }
            ],
            default: "2",
            title: "Anklang 接口版本",
            description: "新配置使用 v2；只有迁移或短期回滚旧服务时才明确选择 v1。"
          },
          timeoutMs: {
            type: "integer", minimum: 1000, maximum: 120000, default: 120000,
            title: "检索最长等待时间（毫秒）"
          },
          indexTimeoutMs: {
            type: "integer", minimum: 1000, maximum: 30000, default: 10000,
            title: "索引同步最长等待时间（毫秒）"
          },
          retryAttempts: {
            type: "integer", minimum: 1, maximum: 3, default: 2,
            title: "最多请求次数",
            description: "网络失败、超时、408、429、502、503、504 最多执行此次数；认证、冲突和契约错误不重试。"
          },
          privateContentAuthorized: {
            type: "boolean", default: false, title: "允许将题面发送给 Anklang",
            description: "Anklang 查重和索引必须接收题目名称与基础题面。启用即确认 Anklang 及嵌入提供方属于批准的处理范围；关闭时不会发出题面请求，查重会按“服务不可用时”设置处理。"
          },
          failureBehavior: {
            type: "string",
            oneOf: [
              { const: "block", title: "阻止提交" },
              { const: "continue", title: "继续提交" }
            ],
            default: "block",
            title: "服务不可用时",
            description: "只控制无法取得配置检查时的提交；相似候选本身不会阻止提交。"
          },
          minimumSimilarityToShow: {
            type: "number", minimum: 0, maximum: 1, default: 0.3,
            title: "候选题显示下限"
          },
          cacheMinutes: {
            type: "integer", minimum: 1, maximum: 10080, default: 1440,
            title: "本地最长复用时间（分钟）",
            description: "只复用服务明确允许的完整检索结果，且不超过这个本地上限。"
          }
        }
      },
      requiresRestart: false,
      ...(runtime.anklang === undefined
        ? {}
        : { registerHooks: createAnklangHookRegistrar(runtime.anklang) })
    },
    {
      source: "builtin:fermata-control",
      manifest: {
        id: fermataPluginId, name: "Fermata 审核服务管理", version: "0.1.0", apiVersion: "1",
        serverEntry: "dist/index.js", permissions: ["org.ustc.urmotiv.fermata-control.status.read", "org.ustc.urmotiv.fermata-control.configure"], settingsSchema: "settings.schema.json"
      },
      secretDefinitions: [{
        name: fermataManagementTokenSecretName,
        label: "管理令牌",
        description: "在服务器运行 `openssl rand -hex 32` 生成，把同一个值写入 Fermata 的 FERMATA_MANAGEMENT_TOKEN，并在这里保存。它只用于 Urmotiv 管理 Fermata，不是模型 API 密钥，也不是机器人令牌。"
      }],
      settingsSchema: {
        type: "object", additionalProperties: false, required: ["baseUrl"],
        properties: {
          baseUrl: {
            type: "string", format: "uri", title: "Fermata 服务地址",
            description: "Fermata 在服务器内提供的 HTTP 或 HTTPS 地址。此处只连接审核服务；AI 模型档位和服务商密钥在独立的 Fermata 管理页说明和配置。"
          },
          timeoutMs: {
            type: "integer", minimum: 1000, maximum: 30000, default: 5000,
            title: "最长等待时间（毫秒）"
          }
        }
      }
    },
    {
      source: "builtin:hydro-format",
      requiresRestart: false,
      manifest: { id: hydroFormatPluginId, name: "Hydro 题目包格式", version: hydroAdapterVersion, apiVersion: "1", serverEntry: "dist/index.js", permissions: [] },
      registerHooks: registerHydroFormatPlugin
    },
    {
      source: "builtin:fps-format",
      requiresRestart: false,
      manifest: { id: fpsFormatPluginId, name: "FPS XML 题目包格式", version: fpsAdapterVersion, apiVersion: "1", serverEntry: "dist/index.js", permissions: [] },
      registerHooks: registerFpsFormatPlugin
    }
  ];
}

export const builtinPluginDefinitions: readonly TrustedPluginDefinition[] =
  createBuiltinPluginDefinitions();

/**
 * 注册 Anklang 的提交前检查。设置、密钥在每次运行时读取，因此管理员改配置后
 * 无需重启即可生效；插件被停用时宿主会在调用前拒绝，这里不用再判断。
 * 注册期的超时上限取设置允许的最大值，运行时再按当前设置收紧。
 */
function createAnklangHookRegistrar(runtime: AnklangHookRuntime): (registry: PluginRegistry) => void {
  return (registry) => {
    registry.registerReviewItemType({
      type: anklangReviewItemType,
      displayName: "原题相似度结果",
      dataSchema: anklangSearchResultSchema
    });
    registry.registerBeforeSubmitCheck({
      id: anklangCheckId,
      displayName: "原题相似度检查",
      timeoutMs: 125_000,
      failureBehavior: "block",
      run: async (input, context) => {
        const rawSettings = await runtime.readSettings();
        if (rawSettings === undefined) {
          return {
            decision: "continue",
            reviewItems: [createAnklangUnavailableReviewItem(input, "service_unavailable")]
          };
        }
        const parsedSettings = anklangSettingsSchema.safeParse(rawSettings);
        if (!parsedSettings.success) {
          throw new Error("Anklang 服务配置不可用。");
        }
        const settings = parsedSettings.data;
        const requiresEmbedding = settings.searchMode === "local" || settings.searchMode === "hybrid";
        if (requiresEmbedding && settings.embeddingProvider === undefined) {
          if (settings.failureBehavior === "continue") {
            return {
              decision: "continue",
              reviewItems: [
                createAnklangUnavailableReviewItem(input, "service_unavailable")
              ]
            };
          }
          throw new Error("Anklang 嵌入提供方未配置。");
        }
        const embeddingApiKey = (await runtime.readEmbeddingApiKey())?.trim();
        if (
          requiresEmbedding &&
          (embeddingApiKey === undefined || embeddingApiKey.length === 0)
        ) {
          if (settings.failureBehavior === "continue") {
            return {
              decision: "continue",
              reviewItems: [
                createAnklangUnavailableReviewItem(input, "service_unavailable")
              ]
            };
          }
          throw new Error("Anklang 嵌入提供方未配置。");
        }
        let check: BeforeSubmitCheck;
        try {
          const token = await runtime.readToken();
          check = createAnklangCheck({
            settings,
            ...(token === undefined ? {} : { token }),
            ...(embeddingApiKey === undefined ? {} : { embeddingApiKey }),
            cache: runtime.cache,
            ...(runtime.fetch === undefined ? {} : { fetch: runtime.fetch })
          });
        } catch {
          if (settings.failureBehavior === "continue") {
            return {
              decision: "continue",
              reviewItems: [
                createAnklangUnavailableReviewItem(input, "service_unavailable")
              ]
            };
          }
          throw new Error("Anklang 服务配置不可用。");
        }
        const controller = new AbortController();
        const cancel = (): void => controller.abort();
        context.signal.addEventListener("abort", cancel, { once: true });
        if (context.signal.aborted) {
          controller.abort();
        }
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, settings.timeoutMs);
        try {
          return await check.run(input, { signal: controller.signal });
        } catch (error) {
          if (context.signal.aborted) {
            throw error;
          }
          if (settings.failureBehavior === "continue") {
            return {
              decision: "continue",
              reviewItems: [
                createAnklangUnavailableReviewItem(
                  input,
                  timedOut ? "search_timeout" : "service_unavailable"
                )
              ]
            };
          }
          throw error;
        } finally {
          clearTimeout(timer);
          context.signal.removeEventListener("abort", cancel);
        }
      }
    });
  };
}
