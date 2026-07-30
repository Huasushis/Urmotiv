import {
  fermataHealthSchema,
  fermataPublicSettingsResponseSchema,
  updateFermataPublicSettingsInputSchema,
  type FermataHealth,
  type FermataPublicSettings
} from "@urmotiv/contracts";
import { z } from "zod";

const responseByteLimit = 512_000;
const serviceUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username.length === 0 &&
      url.password.length === 0
    );
  }, "Fermata 服务地址必须是不含账号密码的 HTTP 或 HTTPS 地址。");

export const fermataControlSettingsSchema = z
  .object({
    baseUrl: serviceUrlSchema,
    timeoutMs: z.number().int().min(1_000).max(30_000).default(5_000)
  })
  .strict();

export type FermataControlSettings = z.infer<typeof fermataControlSettingsSchema>;

export type FermataFetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export interface FermataControlClientOptions {
  readonly baseUrl: string;
  readonly managementToken: string;
  readonly timeoutMs?: number;
  readonly fetch?: FermataFetch;
}

export interface FermataSettingsSnapshot {
  readonly settings: FermataPublicSettings;
  readonly revision: number;
  readonly secretsConfigured: boolean;
}

export class FermataControlClient {
  readonly #baseUrl: URL;
  readonly #managementToken: string;
  readonly #timeoutMs: number;
  readonly #fetch: FermataFetch;

  public constructor(options: FermataControlClientOptions) {
    this.#baseUrl = new URL(ensureTrailingSlash(serviceUrlSchema.parse(options.baseUrl)));
    this.#managementToken = z.string().trim().min(16).max(4_096).parse(options.managementToken);
    this.#timeoutMs = z.number().int().min(1_000).max(30_000).parse(options.timeoutMs ?? 5_000);
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  public getHealth(signal?: AbortSignal): Promise<FermataHealth> {
    return this.request("health", { method: "GET" }, fermataHealthSchema, signal);
  }

  public getSettings(signal?: AbortSignal): Promise<FermataSettingsSnapshot> {
    return this.request(
      "settings/public",
      { method: "GET" },
      fermataPublicSettingsResponseSchema,
      signal
    );
  }

  public updateSettings(
    expectedRevision: number,
    settings: FermataPublicSettings,
    signal?: AbortSignal
  ): Promise<FermataSettingsSnapshot> {
    const body = updateFermataPublicSettingsInputSchema.parse({ expectedRevision, settings });
    return this.request(
      "settings/public",
      { method: "PUT", body: JSON.stringify(body) },
      fermataPublicSettingsResponseSchema,
      signal
    );
  }

  public async wake(signal?: AbortSignal): Promise<void> {
    const result = await this.request(
      "actions/wake",
      { method: "POST", body: "{}" },
      z.object({ ok: z.literal(true) }).strict(),
      signal
    );
    if (!result.ok) {
      throw new Error("Fermata 没有确认唤醒操作。");
    }
  }

  private async request<T>(
    path: string,
    init: RequestInit,
    schema: z.ZodType<T>,
    parentSignal?: AbortSignal
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    const cancel = (): void => controller.abort();
    parentSignal?.addEventListener("abort", cancel, { once: true });
    if (parentSignal?.aborted === true) {
      controller.abort();
    }

    try {
      const response = await this.#fetch(new URL(`/api/v1/${path}`, this.#baseUrl), {
        ...init,
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.#managementToken}`,
          "X-Urmotiv-API-Version": "1",
          ...init.headers
        }
      });
      if (!response.ok) {
        throw new Error(`Fermata 请求失败，状态码为 ${response.status}。`);
      }
      const raw = await readLimitedJson(response, responseByteLimit);
      return schema.parse(raw);
    } finally {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", cancel);
    }
  }
}

async function readLimitedJson(response: Response, limit: number): Promise<unknown> {
  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader !== null && Number(lengthHeader) > limit) {
    throw new Error("Fermata 返回内容超过大小限制。");
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > limit) {
    throw new Error("Fermata 返回内容超过大小限制。");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Fermata 返回的内容不是有效 JSON。");
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
