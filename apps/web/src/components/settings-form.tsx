import { useId } from "react";
import type {
  PluginSettingsFormChoice,
  PluginSettingsFormSchema,
  PluginSettingsFormValue
} from "@urmotiv/contracts";

export type SettingsFormProps<TValue = unknown> = {
  schema: PluginSettingsFormSchema;
  value: TValue;
  onChange: (value: TValue) => void;
  disabled?: boolean;
  idPrefix?: string;
};

type SchemaFieldProps = {
  schema: PluginSettingsFormSchema;
  value: unknown;
  onChange: (value: unknown) => void;
  name: string | undefined;
  path: readonly string[];
  required: boolean;
  disabled: boolean;
  idPrefix: string;
};

type DisplayChoice = PluginSettingsFormChoice;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneSettingValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cloneSettingValue);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([name, child]) => [name, cloneSettingValue(child)])
    );
  }
  return value;
}

/**
 * Fills defaults without changing the object supplied by the caller.
 * The server performs the same validation again before saving.
 */
export function applySettingsFormDefaults(
  schema: PluginSettingsFormSchema,
  value: unknown
): unknown {
  const effectiveValue =
    value === undefined && schema.default !== undefined
      ? cloneSettingValue(schema.default)
      : value;

  if (schema.type === "object") {
    const hadObjectValue = isRecord(effectiveValue);
    const source = hadObjectValue ? effectiveValue : {};
    const result: Record<string, unknown> = { ...source };

    for (const [name, childSchema] of Object.entries(schema.properties ?? {})) {
      const childValue = applySettingsFormDefaults(childSchema, source[name]);
      if (childValue === undefined) {
        delete result[name];
      } else {
        result[name] = childValue;
      }
    }

    return hadObjectValue || Object.keys(result).length > 0 ? result : undefined;
  }

  if (schema.type === "array") {
    if (!Array.isArray(effectiveValue)) {
      return effectiveValue === undefined ? undefined : cloneSettingValue(effectiveValue);
    }
    const itemSchema = schema.items;
    if (itemSchema === undefined) {
      return cloneSettingValue(effectiveValue);
    }
    return effectiveValue.map((item) => {
      const childValue = applySettingsFormDefaults(itemSchema, item);
      return childValue === undefined ? cloneSettingValue(item) : childValue;
    });
  }

  return cloneSettingValue(effectiveValue);
}

function displayValue(value: PluginSettingsFormValue): string {
  if (value === null) {
    return "不选择";
  }
  if (typeof value === "boolean") {
    return value ? "是" : "否";
  }
  return String(value);
}

function choicesFor(schema: PluginSettingsFormSchema): readonly DisplayChoice[] | undefined {
  if (schema.oneOf !== undefined) {
    return schema.oneOf;
  }
  return schema.enum?.map((value) => ({ const: value, title: displayValue(value) }));
}

function pathId(prefix: string, path: readonly string[]): string {
  const suffix = path.length === 0 ? "root" : path.map(encodeURIComponent).join("-");
  return `${prefix}-${suffix}`;
}

function FieldTitle({ title, required }: { title: string; required: boolean }) {
  return (
    <>
      {title}
      {required ? <span className="settings-form-required">（必填）</span> : null}
    </>
  );
}

function FieldDescription({ id, children }: { id: string; children: string }) {
  return (
    <small className="settings-form-description" id={id}>
      {children}
    </small>
  );
}

function SchemaField({
  schema,
  value,
  onChange,
  name,
  path,
  required,
  disabled,
  idPrefix
}: SchemaFieldProps) {
  const id = pathId(idPrefix, path);
  const title = schema.title?.trim() || name || "设置";
  const descriptionId = `${id}-description`;

  if (schema.type === "object") {
    const source = isRecord(value) ? value : {};
    const requiredNames = new Set(schema.required ?? []);
    const properties = Object.entries(schema.properties ?? {});

    return (
      <fieldset className="settings-form-group" disabled={disabled}>
        <legend>
          <FieldTitle title={title} required={required} />
        </legend>
        {schema.description ? (
          <p className="settings-form-description" id={descriptionId}>
            {schema.description}
          </p>
        ) : null}
        <div className="settings-form-fields">
          {properties.length === 0 ? (
            <p className="settings-form-empty">这组设置没有需要填写的内容。</p>
          ) : null}
          {properties.map(([propertyName, childSchema]) => (
            <SchemaField
              key={propertyName}
              schema={childSchema}
              value={source[propertyName]}
              onChange={(childValue) => {
                const next = { ...source };
                if (childValue === undefined) {
                  delete next[propertyName];
                } else {
                  next[propertyName] = childValue;
                }
                onChange(next);
              }}
              name={propertyName}
              path={[...path, propertyName]}
              required={requiredNames.has(propertyName)}
              disabled={disabled}
              idPrefix={idPrefix}
            />
          ))}
        </div>
      </fieldset>
    );
  }

  if (schema.type === "array") {
    return (
      <div className="field settings-form-field settings-form-unsupported" role="note">
        <span>
          <FieldTitle title={title} required={required} />
        </span>
        {schema.description ? (
          <FieldDescription id={descriptionId}>{schema.description}</FieldDescription>
        ) : null}
        <p>这项设置包含一组可增减的内容，当前页面暂不支持修改。</p>
      </div>
    );
  }

  const choices = choicesFor(schema);
  if (choices !== undefined) {
    const selectedIndex = choices.findIndex((choice) => Object.is(choice.const, value));
    const selectedDescription =
      selectedIndex >= 0 ? choices[selectedIndex]?.description : undefined;
    const describedBy = [
      schema.description ? descriptionId : undefined,
      selectedDescription ? `${id}-choice-description` : undefined
    ]
      .filter((item): item is string => item !== undefined)
      .join(" ");

    return (
      <label className="field settings-form-field" htmlFor={id}>
        <span>
          <FieldTitle title={title} required={required} />
        </span>
        <select
          id={id}
          value={selectedIndex < 0 ? "" : String(selectedIndex)}
          required={required}
          disabled={disabled}
          aria-describedby={describedBy || undefined}
          onChange={(event) => {
            if (event.currentTarget.value === "") {
              onChange(undefined);
              return;
            }
            const choice = choices[Number(event.currentTarget.value)];
            if (choice !== undefined) {
              onChange(choice.const);
            }
          }}
        >
          <option value="" disabled={required}>
            请选择
          </option>
          {choices.map((choice, index) => (
            <option key={`${typeof choice.const}:${String(choice.const)}`} value={String(index)}>
              {choice.title}
            </option>
          ))}
        </select>
        {schema.description ? (
          <FieldDescription id={descriptionId}>{schema.description}</FieldDescription>
        ) : null}
        {selectedDescription ? (
          <FieldDescription id={`${id}-choice-description`}>
            {selectedDescription}
          </FieldDescription>
        ) : null}
      </label>
    );
  }

  if (schema.type === "boolean") {
    return (
      <div className="field settings-form-field settings-form-boolean">
        <label className="settings-form-toggle" htmlFor={id}>
          <input
            id={id}
            type="checkbox"
            checked={value === true}
            disabled={disabled}
            aria-describedby={schema.description ? descriptionId : undefined}
            onChange={(event) => onChange(event.currentTarget.checked)}
          />
          <span>
            <FieldTitle title={title} required={required} />
          </span>
        </label>
        {schema.description ? (
          <FieldDescription id={descriptionId}>{schema.description}</FieldDescription>
        ) : null}
      </div>
    );
  }

  if (schema.type === "number" || schema.type === "integer") {
    const numericValue = typeof value === "number" && Number.isFinite(value) ? value : "";
    return (
      <label className="field settings-form-field" htmlFor={id}>
        <span>
          <FieldTitle title={title} required={required} />
        </span>
        <input
          id={id}
          type="number"
          value={numericValue}
          min={schema.minimum}
          max={schema.maximum}
          step={schema.type === "integer" ? 1 : "any"}
          required={required}
          disabled={disabled}
          aria-describedby={schema.description ? descriptionId : undefined}
          onChange={(event) => {
            const nextValue = event.currentTarget.valueAsNumber;
            onChange(Number.isFinite(nextValue) ? nextValue : undefined);
          }}
        />
        {schema.description ? (
          <FieldDescription id={descriptionId}>{schema.description}</FieldDescription>
        ) : null}
      </label>
    );
  }

  const textValue = typeof value === "string" ? value : "";
  return (
    <label className="field settings-form-field" htmlFor={id}>
      <span>
        <FieldTitle title={title} required={required} />
      </span>
      <input
        id={id}
        type={schema.format === "uri" ? "url" : "text"}
        value={textValue}
        minLength={schema.minLength}
        maxLength={schema.maxLength}
        required={required}
        disabled={disabled}
        aria-describedby={schema.description ? descriptionId : undefined}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      {schema.description ? (
        <FieldDescription id={descriptionId}>{schema.description}</FieldDescription>
      ) : null}
    </label>
  );
}

export function SettingsForm<TValue = unknown>({
  schema,
  value,
  onChange,
  disabled = false,
  idPrefix
}: SettingsFormProps<TValue>) {
  const generatedId = useId();
  const resolvedIdPrefix = idPrefix ?? `settings${generatedId.replaceAll(":", "")}`;
  const resolvedValue = applySettingsFormDefaults(schema, value);

  return (
    <div className="settings-form" aria-label={schema.title?.trim() || "插件设置"}>
      <SchemaField
        schema={schema}
        value={resolvedValue}
        onChange={(nextValue) => onChange(nextValue as TValue)}
        name={undefined}
        path={[]}
        required={false}
        disabled={disabled}
        idPrefix={resolvedIdPrefix}
      />
    </div>
  );
}
