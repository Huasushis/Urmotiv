/**
 * Fermata 管理服务：把 plugins/fermata-control 里的 FermataControlClient 接到
 * Urmotiv API 的管理员路由上。
 *
 * 这一层只做三件事：
 * 1. 从插件宿主读取 Fermata 插件当前启用的设置和加密的管理令牌；
 * 2. 用这些凭据构造 FermataControlClient，实际调用 Fermata 的版本 1 管理接口；
 * 3. 把网络、超时、契约校验等异常统一翻译成操作员可读的安全错误，不泄露令牌、
 *    不泄露题面、不泄露 Fermata 返回的原始错误体。
 *
 * 设置和令牌在每次调用时重新读取，管理员改完配置无需重启即可生效。插件未启用、
 * 未配置地址或缺少令牌时统一按"未配置"返回，不区分哪一项缺失，避免泄露内部状态。
 */
import {
  FermataControlClient,
  fermataControlSettingsSchema,
  type FermataControlSettings,
  type FermataSettingsSnapshot,
  type FermataFetch
} from "@urmotiv/plugin-fermata-control";
import type { FermataHealth, FermataPublicSettings } from "@urmotiv/contracts";
import { fermataPluginId, fermataManagementTokenSecretName } from "./builtin-plugins";
import type { TrustedPluginHost } from "./plugin-host";

/**
 * Fermata 管理调用失败时抛出的安全错误。
 *
 * code 和 message 都不包含令牌、地址路径中的凭据或 Fermata 返回的原始内容，
 * 适合直接出现在 API 响应和日志中。internalMessage 仅在服务端日志中使用，
 * 不返回给客户端。
 */
export class FermataControlError extends Error {
  public readonly code: FermataControlErrorCode;
  public readonly statusCode: number;
  public readonly internalMessage: string | undefined;

  public constructor(
    code: FermataControlErrorCode,
    message: string,
    internalMessage?: string
  ) {
    super(message);
    this.name = "FermataControlError";
    this.code = code;
    this.statusCode = fermataControlErrorStatus(code);
    this.internalMessage = internalMessage;
  }
}

export type FermataControlErrorCode =
  | "FERMATA_NOT_CONFIGURED"
  | "FERMATA_UNAVAILABLE"
  | "FERMATA_REQUEST_FAILED"
  | "FERMATA_RESPONSE_INVALID";

function fermataControlErrorStatus(code: FermataControlErrorCode): number {
  switch (code) {
    case "FERMATA_NOT_CONFIGURED":
      return 503;
    case "FERMATA_UNAVAILABLE":
      return 503;
    case "FERMATA_REQUEST_FAILED":
      return 502;
    case "FERMATA_RESPONSE_INVALID":
      return 502;
  }
}

/**
 * 测试时可以注入一个假的 fetch；生产环境使用全局 fetch。
 */
export interface FermataControlServiceOptions {
  readonly pluginHost: TrustedPluginHost;
  readonly fetch?: FermataFetch;
}

export class FermataControlService {
  readonly #pluginHost: TrustedPluginHost;
  readonly #fetch: FermataFetch | undefined;

  public constructor(options: FermataControlServiceOptions) {
    this.#pluginHost = options.pluginHost;
    this.#fetch = options.fetch;
  }

  public async getHealth(signal?: AbortSignal): Promise<FermataHealth> {
    const client = await this.#createClient();
    try {
      return await client.getHealth(signal);
    } catch (error) {
      throw translateFermataError(error);
    }
  }

  public async getSettings(signal?: AbortSignal): Promise<FermataSettingsSnapshot> {
    const client = await this.#createClient();
    try {
      return await client.getSettings(signal);
    } catch (error) {
      throw translateFermataError(error);
    }
  }

  public async updateSettings(
    expectedRevision: number,
    settings: FermataPublicSettings,
    signal?: AbortSignal
  ): Promise<FermataSettingsSnapshot> {
    const client = await this.#createClient();
    try {
      return await client.updateSettings(expectedRevision, settings, signal);
    } catch (error) {
      throw translateFermataError(error);
    }
  }

  public async wake(signal?: AbortSignal): Promise<void> {
    const client = await this.#createClient();
    try {
      await client.wake(signal);
    } catch (error) {
      throw translateFermataError(error);
    }
  }

  /**
   * 读取当前启用的插件设置和加密令牌，构造 FermataControlClient。
   * 插件未启用、设置缺失或令牌未配置时统一抛 FERMATA_NOT_CONFIGURED。
   */
  async #createClient(): Promise<FermataControlClient> {
    const rawSettings = await this.#pluginHost.readEnabledPluginSettings(fermataPluginId);
    if (rawSettings === undefined) {
      throw new FermataControlError(
        "FERMATA_NOT_CONFIGURED",
        "Fermata 插件未启用或未配置服务地址。"
      );
    }

    let settings: FermataControlSettings;
    try {
      settings = fermataControlSettingsSchema.parse(rawSettings);
    } catch {
      throw new FermataControlError(
        "FERMATA_NOT_CONFIGURED",
        "Fermata 插件设置不符合要求，请检查服务地址。"
      );
    }

    const token = await this.#pluginHost.readSecretForPlugin(
      fermataPluginId,
      fermataManagementTokenSecretName
    );
    if (token === undefined) {
      throw new FermataControlError(
        "FERMATA_NOT_CONFIGURED",
        "Fermata 管理令牌尚未配置。"
      );
    }

    return new FermataControlClient({
      baseUrl: settings.baseUrl,
      managementToken: token,
      timeoutMs: settings.timeoutMs,
      ...(this.#fetch === undefined ? {} : { fetch: this.#fetch })
    });
  }
}

/**
 * 把 FermataControlClient 抛出的各种错误翻译成安全的 FermataControlError。
 *
 * - AbortError / TypeError（网络/DNS/超时）→ FERMATA_UNAVAILABLE
 * - FermataControlClient 的 request() 在非 2xx 时抛的 Error → FERMATA_REQUEST_FAILED
 * - zod parse 失败（契约漂移 / 版本不匹配）→ FERMATA_RESPONSE_INVALID
 *
 * 原始错误信息只记入 internalMessage，不进入面向客户端的 message。
 */
function translateFermataError(error: unknown): FermataControlError {
  if (error instanceof FermataControlError) {
    return error;
  }

  const errorName = error instanceof Error ? error.name : "UnknownError";
  const errorMessage = error instanceof Error ? error.message : String(error);

  // 超时（AbortController.abort 触发的 AbortError）和网络层错误（TypeError）。
  if (errorName === "AbortError" || errorName === "TypeError") {
    return new FermataControlError(
      "FERMATA_UNAVAILABLE",
      "暂时无法连接 Fermata 服务，请稍后重试。",
      errorMessage
    );
  }

  // zod 解析失败说明 Fermata 返回的形状不符合版本 1 契约。
  if (errorName === "ZodError") {
    return new FermataControlError(
      "FERMATA_RESPONSE_INVALID",
      "Fermata 返回的内容不符合当前接口约定，可能需要检查版本。",
      errorMessage
    );
  }

  // FermataControlClient.request() 在 !response.ok 时抛的 Error 里包含状态码。
  // 这些信息不泄露令牌，但可能间接暴露 Fermata 内部状态；统一收窄为一条消息。
  const statusMatch = /状态码为\s*(\d+)/.exec(errorMessage);
  if (statusMatch !== null) {
    return new FermataControlError(
      "FERMATA_REQUEST_FAILED",
      "Fermata 服务拒绝了请求，请检查配置或稍后重试。",
      errorMessage
    );
  }

  // 其它未知错误一律按不可用处理，不泄露细节。
  return new FermataControlError(
    "FERMATA_UNAVAILABLE",
    "暂时无法完成 Fermata 操作，请稍后重试。",
    errorMessage
  );
}
