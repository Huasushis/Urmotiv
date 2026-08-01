import {
  anklangCheckId,
  anklangResultSchema,
  anklangReviewItemType,
  anklangSettingsSchema,
  createAnklangUnavailableReviewItem,
  createAnklangCheck,
  type AnklangCache,
  type AnklangFetch
} from "@urmotiv/plugin-anklang";
import {
  defaultReviewRuleId,
  registerDefaultReviewPlugin
} from "@urmotiv/plugin-review-default";
import type { PluginRegistry } from "@urmotiv/plugin-sdk";
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
  readonly cache: AnklangCache;
  /** 仅测试使用：替换 HTTP 客户端。 */
  readonly fetch?: AnklangFetch;
}

export interface BuiltinPluginRuntime {
  readonly anklang?: AnklangHookRuntime;
}

export const anklangPluginId = "org.ustc.urmotiv.anklang";
export const anklangServiceTokenSecretName = "serviceToken";
export const fermataPluginId = "org.ustc.urmotiv.fermata-control";
export const fermataManagementTokenSecretName = "managementToken";

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
        id: anklangPluginId, name: "原题相似度检查", version: "0.2.0", apiVersion: "1",
        serverEntry: "dist/index.js", permissions: ["org.ustc.urmotiv.anklang.configure", "org.ustc.urmotiv.anklang.results.read"], settingsSchema: "settings.schema.json"
      },
      secretDefinitions: [{
        name: anklangServiceTokenSecretName,
        label: "服务认证令牌",
        description: "Anklang 用它确认请求来自 Urmotiv；完整内容只会加密保存，不会在页面重新显示。"
      }],
      settingsSchema: {
        type: "object", additionalProperties: false, required: ["baseUrl"],
        properties: {
          baseUrl: {
            type: "string", format: "uri", title: "Anklang 服务地址",
            description: "Urmotiv 调用原题检索服务的 HTTP 或 HTTPS 地址。认证令牌单独保存。"
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
            title: "最长等待时间（毫秒）"
          },
          failureBehavior: {
            type: "string",
            oneOf: [
              { const: "block", title: "阻止提交" },
              { const: "continue", title: "继续提交" }
            ],
            default: "block",
            title: "服务不可用时",
            description: "阻止提交表示必须完成查重；继续提交表示服务暂时不可用时仍可进入审核。"
          },
          blockWhenRecommended: {
            type: "boolean", default: true, title: "服务建议拦截时阻止提交"
          },
          minimumSimilarityToShow: {
            type: "number", minimum: 0, maximum: 1, default: 0.3,
            title: "候选题显示下限"
          },
          cacheMinutes: {
            type: "integer", minimum: 1, maximum: 10080, default: 1440,
            title: "本地最长复用时间（分钟）",
            description: "v2 取服务绝对到期时间与这个本地上限中较早的时间；v1 只使用这个上限。"
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
        description: "Urmotiv 调用 Fermata 的状态、设置和立即检查接口时使用；必须与 Fermata 的管理令牌一致。"
      }],
      settingsSchema: {
        type: "object", additionalProperties: false, required: ["baseUrl"],
        properties: {
          baseUrl: {
            type: "string", format: "uri", title: "Fermata 服务地址",
            description: "Fermata 在服务器内提供的 HTTP 或 HTTPS 地址。管理令牌单独保存。"
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
      manifest: { id: "org.ustc.urmotiv.hydro-format", name: "Hydro 题目包格式", version: "0.1.0", apiVersion: "1", serverEntry: "dist/index.js", permissions: [] }
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
      dataSchema: anklangResultSchema
    });
    registry.registerBeforeSubmitCheck({
      id: anklangCheckId,
      displayName: "原题相似度检查",
      timeoutMs: 125_000,
      failureBehavior: "block",
      run: async (input, context) => {
        const rawSettings = await runtime.readSettings();
        if (rawSettings === undefined) {
          return { decision: "continue" };
        }
        const settings = anklangSettingsSchema.parse(rawSettings);
        const token = await runtime.readToken();
        const check = createAnklangCheck({
          settings,
          ...(token === undefined ? {} : { token }),
          cache: runtime.cache,
          ...(runtime.fetch === undefined ? {} : { fetch: runtime.fetch })
        });

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
            return settings.apiVersion === "2"
              ? {
                  decision: "continue",
                  reviewItems: [
                    createAnklangUnavailableReviewItem(
                      input,
                      timedOut ? "search_timeout" : "service_unavailable"
                    )
                  ]
                }
              : { decision: "continue" };
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
