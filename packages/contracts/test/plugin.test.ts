import { describe, expect, it } from "vitest";
import {
  adminPluginListResponseSchema,
  adminPluginResponseSchema,
  pluginSecretStatusSchema,
  pluginSettingsFormSchema,
  updatePluginInputSchema,
  type AdminPlugin,
  type AvailableReviewRule,
  type ParsedUpdatePluginInput,
  type UpdatePluginRequest
} from "../src";

const settingsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["baseUrl", "failureBehavior"],
  properties: {
    baseUrl: { type: "string", format: "uri", title: "服务地址" },
    failureBehavior: {
      type: "string",
      title: "服务不可用时",
      oneOf: [
        { const: "block", title: "阻止提交", description: "必须完成检查后才能提交。" },
        { const: "continue", title: "继续提交" }
      ]
    }
  }
} as const;

describe("pluginSettingsFormSchema", () => {
  it("accepts a small form with a URI and standard oneOf choices", () => {
    expect(pluginSettingsFormSchema.parse(settingsSchema)).toEqual(settingsSchema);
  });

  it("requires every form node to state its type", () => {
    expect(pluginSettingsFormSchema.safeParse({ properties: {} }).success).toBe(false);
    expect(
      pluginSettingsFormSchema.safeParse({
        type: "object",
        properties: { missingType: { title: "缺少类型" } }
      }).success
    ).toBe(false);
  });

  it("only accepts uri as a string format", () => {
    expect(pluginSettingsFormSchema.safeParse({ type: "string", format: "email" }).success).toBe(false);
    expect(pluginSettingsFormSchema.safeParse({ type: "string", format: "uri" }).success).toBe(true);
  });

  it("keeps enum and oneOf mutually exclusive and their values simple", () => {
    expect(
      pluginSettingsFormSchema.safeParse({
        type: "string",
        enum: ["block"],
        oneOf: [{ const: "block", title: "阻止提交" }]
      }).success
    ).toBe(false);
    expect(pluginSettingsFormSchema.safeParse({ type: "string", enum: [{ value: "block" }] }).success).toBe(false);
    expect(
      pluginSettingsFormSchema.safeParse({
        type: "string",
        oneOf: [{ const: ["block"], title: "阻止提交" }]
      }).success
    ).toBe(false);
    expect(
      pluginSettingsFormSchema.safeParse({
        type: "string",
        oneOf: [{ const: null, title: "不选择" }]
      }).success
    ).toBe(true);
    expect(pluginSettingsFormSchema.safeParse({ type: "string", enum: ["block", "block"] }).success).toBe(false);
    expect(
      pluginSettingsFormSchema.safeParse({
        type: "string",
        oneOf: [
          { const: "block", title: "阻止提交" },
          { const: "block", title: "仍然阻止提交" }
        ]
      }).success
    ).toBe(false);
  });

  it("checks matching numeric and text limits", () => {
    expect(pluginSettingsFormSchema.safeParse({ type: "number", minimum: 2, maximum: 1 }).success).toBe(false);
    expect(pluginSettingsFormSchema.safeParse({ type: "string", minLength: 2, maxLength: 1 }).success).toBe(false);
  });

  it("requires unique required names that are present in properties", () => {
    const duplicate = pluginSettingsFormSchema.safeParse({
      type: "object",
      properties: { baseUrl: { type: "string" } },
      required: ["baseUrl", "baseUrl"]
    });
    const missing = pluginSettingsFormSchema.safeParse({
      type: "object",
      properties: { baseUrl: { type: "string" } },
      required: ["timeoutMs"]
    });
    expect(duplicate.success).toBe(false);
    expect(missing.success).toBe(false);
  });

  it.each(["__proto__", "prototype", "constructor"])(
    "rejects the dangerous property name %s",
    (name) => {
      const value = JSON.parse(
        `{"type":"object","properties":{"${name}":{"type":"string"}}}`
      ) as unknown;
      const parsed = pluginSettingsFormSchema.safeParse(value);
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues.some((issue) => issue.message.includes("名称不安全"))).toBe(true);
      }
    }
  );

  it("limits nesting depth", () => {
    let value: Record<string, unknown> = { type: "string" };
    for (let index = 0; index < 12; index += 1) {
      value = { type: "object", properties: { child: value } };
    }
    const parsed = pluginSettingsFormSchema.safeParse(value);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.message.includes("最多分为 12 层"))).toBe(true);
    }
  });

  it("limits properties in one object", () => {
    const properties = Object.fromEntries(
      Array.from({ length: 101 }, (_, index) => [`setting${index}`, { type: "boolean" }])
    );
    const parsed = pluginSettingsFormSchema.safeParse({ type: "object", properties });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.message.includes("最多包含 100 项"))).toBe(true);
    }
  });

  it("limits the total number of form nodes", () => {
    const properties = Object.fromEntries(
      Array.from({ length: 100 }, (_, groupIndex) => [
        `group${groupIndex}`,
        {
          type: "object",
          properties: Object.fromEntries(
            Array.from({ length: 4 }, (_, itemIndex) => [
              `item${itemIndex}`,
              { type: "boolean" }
            ])
          )
        }
      ])
    );
    const parsed = pluginSettingsFormSchema.safeParse({ type: "object", properties });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.message.includes("最多包含 500 项设置"))).toBe(true);
    }
  });
});

describe("plugin administration contracts", () => {
  it("密钥状态只允许声明元信息和已配置标记，不接受任何字符字段", () => {
    expect(
      pluginSecretStatusSchema.parse({
        name: "serviceToken",
        label: "服务认证令牌",
        description: "用于确认请求来自 Urmotiv。",
        configured: false
      })
    ).toMatchObject({ configured: false });
    expect(
      pluginSecretStatusSchema.safeParse({
        name: "serviceToken",
        label: "服务认证令牌",
        description: "用于确认请求来自 Urmotiv。",
        configured: true,
        maskedSuffix: "****"
      }).success
    ).toBe(false);
  });

  it("wraps plugin list and single-plugin responses consistently", () => {
    const plugin: AdminPlugin = {
      id: "org.example.plugin",
      name: "示例插件",
      version: "1.0.0",
      apiVersion: "1",
      source: "builtin:example",
      state: "disabled",
      failureCode: null,
      settings: {},
      settingsManagedBy: "plugin",
      settingsSchema,
      reviewRuleIds: [],
      settingsRevision: 1,
      secrets: [],
      requiresRestart: false
    };
    expect(adminPluginListResponseSchema.parse({ items: [plugin] })).toEqual({ items: [plugin] });
    expect(adminPluginResponseSchema.parse({ item: plugin })).toEqual({ item: plugin });
  });

  it("distinguishes incoming update data from parsed defaults", () => {
    const request: UpdatePluginRequest = { expectedRevision: 1, state: "enabled" };
    const parsed: ParsedUpdatePluginInput = updatePluginInputSchema.parse(request);
    expect(parsed.clearSecrets).toEqual([]);
    expect(updatePluginInputSchema.safeParse({ expectedRevision: 1 }).success).toBe(false);
    expect(
      updatePluginInputSchema.safeParse({
        expectedRevision: 1,
        state: "enabled",
        unexpected: true
      }).success
    ).toBe(false);
  });

  it("exports the available review rule shape", () => {
    const rule: AvailableReviewRule = {
      id: "org.example.rule",
      displayName: "示例审核规则",
      pluginVersion: "1.0.0",
      settingsSchema: null
    };
    expect(rule.id).toBe("org.example.rule");
  });
});
