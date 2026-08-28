import { z } from "zod";

const pluginIdSchema = z
  .string()
  .min(3)
  .max(160)
  .regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/);

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema)
  ])
);

export const pluginSettingsSchema = z.record(z.string(), jsonValueSchema);

export const pluginSettingsFormValueSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null()
]);

export type PluginSettingsFormValue = z.infer<typeof pluginSettingsFormValueSchema>;

export interface PluginSettingsFormChoice {
  readonly const: PluginSettingsFormValue;
  readonly title: string;
  readonly description?: string | undefined;
}

export interface PluginSettingsFormSchema {
  readonly $schema?: string | undefined;
  readonly type: "object" | "array" | "string" | "number" | "integer" | "boolean";
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly properties?: Readonly<Record<string, PluginSettingsFormSchema>> | undefined;
  readonly required?: readonly string[] | undefined;
  readonly additionalProperties?: boolean | undefined;
  readonly items?: PluginSettingsFormSchema | undefined;
  readonly enum?: readonly PluginSettingsFormValue[] | undefined;
  readonly oneOf?: readonly PluginSettingsFormChoice[] | undefined;
  readonly minimum?: number | undefined;
  readonly maximum?: number | undefined;
  readonly minLength?: number | undefined;
  readonly maxLength?: number | undefined;
  readonly format?: "uri" | undefined;
  readonly default?: unknown;
}

const dangerousPropertyNames = new Set(["__proto__", "prototype", "constructor"]);
const maximumFormDepth = 12;
const maximumFormNodes = 500;
const maximumPropertiesPerObject = 100;

const pluginSettingsPropertyNameSchema = z
  .string()
  .min(1)
  .max(120)
  .refine((name) => !dangerousPropertyNames.has(name), "设置名称不安全，请换一个名称。");

const pluginSettingsFormChoiceSchema: z.ZodType<PluginSettingsFormChoice> = z
  .object({
    const: pluginSettingsFormValueSchema,
    title: z.string().trim().min(1).max(160),
    description: z.string().trim().max(2_000).optional()
  })
  .strict();

function formValueKey(value: PluginSettingsFormValue): string {
  return value === null ? "null" : `${typeof value}:${String(value)}`;
}

function hasDuplicateFormValues(values: readonly PluginSettingsFormValue[]): boolean {
  return new Set(values.map(formValueKey)).size !== values.length;
}

const pluginSettingsFormNodeSchema: z.ZodType<PluginSettingsFormSchema> = z.lazy(() =>
  z
    .object({
      $schema: z.string().max(200).optional(),
      type: z.enum(["object", "array", "string", "number", "integer", "boolean"]),
      title: z.string().trim().max(160).optional(),
      description: z.string().trim().max(2_000).optional(),
      properties: z.record(pluginSettingsPropertyNameSchema, pluginSettingsFormNodeSchema).optional(),
      required: z.array(pluginSettingsPropertyNameSchema).max(maximumPropertiesPerObject).optional(),
      additionalProperties: z.boolean().optional(),
      items: pluginSettingsFormNodeSchema.optional(),
      enum: z.array(pluginSettingsFormValueSchema).min(1).max(200).optional(),
      oneOf: z.array(pluginSettingsFormChoiceSchema).min(1).max(200).optional(),
      minimum: z.number().finite().optional(),
      maximum: z.number().finite().optional(),
      minLength: z.number().int().min(0).max(100_000).optional(),
      maxLength: z.number().int().min(0).max(100_000).optional(),
      format: z.literal("uri").optional(),
      default: jsonValueSchema.optional()
    })
    .strict()
    .superRefine((value, context) => {
      if (value.enum !== undefined && value.oneOf !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["oneOf"],
          message: "同一个设置不能同时使用选项列表和带说明的选项列表。"
        });
      }

      if (value.enum !== undefined && hasDuplicateFormValues(value.enum)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["enum"],
          message: "选项值不能重复。"
        });
      }

      if (
        value.oneOf !== undefined &&
        hasDuplicateFormValues(value.oneOf.map((choice) => choice.const))
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["oneOf"],
          message: "带说明的选项值不能重复。"
        });
      }

      if (value.minimum !== undefined && value.maximum !== undefined && value.minimum > value.maximum) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["minimum"],
          message: "最小值不能大于最大值。"
        });
      }

      if (
        value.minLength !== undefined &&
        value.maxLength !== undefined &&
        value.minLength > value.maxLength
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["minLength"],
          message: "最短长度不能大于最长长度。"
        });
      }

      if (value.required !== undefined) {
        const seen = new Set<string>();
        for (const [index, name] of value.required.entries()) {
          if (seen.has(name)) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["required", index],
              message: "必填设置不能重复。"
            });
          }
          seen.add(name);
          if (value.properties === undefined || !Object.hasOwn(value.properties, name)) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["required", index],
              message: "必填设置必须先在这组设置中定义。"
            });
          }
        }
      }
    })
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkPluginSettingsFormSize(value: unknown, context: z.RefinementCtx): void {
  const pending: Array<{
    readonly value: unknown;
    readonly depth: number;
    readonly path: Array<string | number>;
  }> = [
    { value, depth: 1, path: [] }
  ];
  const visited = new WeakSet<object>();
  let nodeCount = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || !isRecord(current.value)) {
      continue;
    }
    if (visited.has(current.value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: current.path,
        message: "表单描述不能把自己作为下一级设置。"
      });
      return;
    }
    visited.add(current.value);

    nodeCount += 1;
    if (nodeCount > maximumFormNodes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: current.path,
        message: `表单描述最多包含 ${maximumFormNodes} 项设置。`
      });
      return;
    }
    if (current.depth > maximumFormDepth) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: current.path,
        message: `设置最多分为 ${maximumFormDepth} 层。`
      });
      return;
    }

    const properties = current.value.properties;
    if (isRecord(properties)) {
      const propertyNames = Object.keys(properties);
      if (propertyNames.length > maximumPropertiesPerObject) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...current.path, "properties"],
          message: `每一组设置最多包含 ${maximumPropertiesPerObject} 项。`
        });
        return;
      }
      for (const name of propertyNames) {
        if (dangerousPropertyNames.has(name)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...current.path, "properties", name],
            message: "设置名称不安全，请换一个名称。"
          });
          return;
        }
        pending.push({
          value: properties[name],
          depth: current.depth + 1,
          path: [...current.path, "properties", name]
        });
      }
    }

    if (current.value.items !== undefined) {
      pending.push({
        value: current.value.items,
        depth: current.depth + 1,
        path: [...current.path, "items"]
      });
    }
  }
}

export const pluginSettingsFormSchema = z
  .unknown()
  .superRefine(checkPluginSettingsFormSize)
  .pipe(pluginSettingsFormNodeSchema);

export const pluginSecretNameSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z][A-Za-z0-9_.-]*$/);

export const updatePluginInputSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    state: z.enum(["enabled", "disabled"]).optional(),
    settings: pluginSettingsSchema.optional(),
    secrets: z.record(pluginSecretNameSchema, z.string().min(1).max(16_384)).optional(),
    clearSecrets: z.array(pluginSecretNameSchema).max(100).default([])
  })
  .strict()
  .refine(
    (value) =>
      value.state !== undefined ||
      value.settings !== undefined ||
      value.secrets !== undefined ||
      value.clearSecrets.length > 0,
    "至少提供一项要修改的插件配置。"
  );

export type UpdatePluginRequest = z.input<typeof updatePluginInputSchema>;
export type ParsedUpdatePluginInput = z.output<typeof updatePluginInputSchema>;
export type UpdatePluginInput = UpdatePluginRequest;

export const pluginSecretStatusSchema = z
  .object({
    name: pluginSecretNameSchema,
    label: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(500),
    configured: z.boolean()
  })
  .strict();

export const adminPluginSchema = z
  .object({
    id: pluginIdSchema,
    name: z.string().min(1).max(120),
    version: z.string().min(1).max(80),
    apiVersion: z.string().min(1).max(40),
    source: z.string().min(1).max(500),
    state: z.enum(["enabled", "disabled", "failed"]),
    failureCode: z.string().max(120).nullable(),
    settings: pluginSettingsSchema,
    settingsManagedBy: z.enum(["plugin", "review_policy", "none"]),
    settingsSchema: pluginSettingsFormSchema.nullable(),
    reviewRuleIds: z.array(z.string().min(1).max(160)).max(100),
    settingsRevision: z.number().int().positive(),
    secrets: z.array(pluginSecretStatusSchema),
    requiresRestart: z.boolean()
  })
  .strict();

export type AdminPlugin = z.infer<typeof adminPluginSchema>;

export const adminPluginListResponseSchema = z.object({
  items: z.array(adminPluginSchema).max(500)
}).strict();

export type AdminPluginListResponse = z.infer<typeof adminPluginListResponseSchema>;

export const adminPluginResponseSchema = z.object({
  item: adminPluginSchema
}).strict();

export type AdminPluginResponse = z.infer<typeof adminPluginResponseSchema>;
