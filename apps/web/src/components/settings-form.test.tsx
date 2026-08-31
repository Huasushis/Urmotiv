import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginSettingsFormSchema } from "@urmotiv/contracts";
import { applySettingsFormDefaults, SettingsForm } from "./settings-form";

const connectionSchema = {
  type: "object",
  title: "原题检索设置",
  description: "设置服务地址和请求限制。",
  required: ["connection"],
  properties: {
    connection: {
      type: "object",
      title: "服务连接",
      required: ["baseUrl"],
      properties: {
        baseUrl: {
          type: "string",
          title: "服务地址",
          description: "填写以 HTTP 或 HTTPS 开头的地址。",
          format: "uri",
          minLength: 8,
          maxLength: 200,
          default: "https://search.example"
        },
        timeoutMs: {
          type: "integer",
          title: "等待时间（毫秒）",
          description: "超过这段时间后停止等待。",
          minimum: 1000,
          maximum: 120000,
          default: 30000
        }
      }
    },
    enabledBeforeSubmit: {
      type: "boolean",
      title: "提交前检查",
      description: "开启后，投稿进入审核前会先完成原题检索。",
      default: true
    }
  }
} as const satisfies PluginSettingsFormSchema;

let mountedRoot: Root | undefined;
let mountedContainer: HTMLDivElement | undefined;

afterEach(() => {
  if (mountedRoot !== undefined) {
    act(() => mountedRoot?.unmount());
  }
  mountedContainer?.remove();
  mountedRoot = undefined;
  mountedContainer = undefined;
});

function mount(element: ReactNode): HTMLDivElement {
  mountedContainer = document.createElement("div");
  document.body.append(mountedContainer);
  mountedRoot = createRoot(mountedContainer);
  act(() => mountedRoot?.render(element));
  return mountedContainer;
}

describe("插件设置表单", () => {
  it("递归补全默认值但不修改调用方传入的对象", () => {
    const original: Record<string, unknown> = {};

    expect(applySettingsFormDefaults(connectionSchema, original)).toEqual({
      connection: {
        baseUrl: "https://search.example",
        timeoutMs: 30000
      },
      enabledBeforeSubmit: true
    });
    expect(original).toEqual({});
  });

  it("不会因为可选对象内部的默认值生成半成品配置", () => {
    const schema = {
      type: "object",
      properties: {
        mode: { type: "string", default: "public" },
        optionalProvider: {
          type: "object",
          properties: {
            protocol: {
              type: "string",
              default: "openai"
            },
            baseUrl: { type: "string" }
          }
        }
      }
    } as const satisfies PluginSettingsFormSchema;

    expect(applySettingsFormDefaults(schema, {})).toEqual({ mode: "public" });
    expect(
      applySettingsFormDefaults(schema, { optionalProvider: { baseUrl: "https://example" } })
    ).toEqual({ optionalProvider: { protocol: "openai", baseUrl: "https://example" }, mode: "public" });
  });

  it("显示分组、说明、必填标记、默认值和输入限制", () => {
    const html = renderToStaticMarkup(
      <SettingsForm
        schema={connectionSchema}
        value={{}}
        onChange={() => undefined}
        idPrefix="anklang"
      />
    );

    expect(html).toContain("原题检索设置");
    expect(html).toContain("服务连接");
    expect(html).toContain("填写以 HTTP 或 HTTPS 开头的地址。");
    expect(html).toContain("（必填）");
    expect(html).toContain('type="url"');
    expect(html).toContain('value="https://search.example"');
    expect(html).toContain('minLength="8"');
    expect(html).toContain('maxLength="200"');
    expect(html).toContain('min="1000"');
    expect(html).toContain('max="120000"');
    expect(html).toContain('step="1"');
    expect(html).toContain('checked=""');
  });

  it("oneOf 显示中文标题并把 const 原值交给父组件", () => {
    const schema = {
      type: "object",
      properties: {
        failureBehavior: {
          type: "string",
          title: "服务不可用时",
          description: "选择外部服务暂时无法访问时如何处理投稿。",
          default: "block",
          oneOf: [
            {
              const: "block",
              title: "阻止提交",
              description: "检查完成后才能进入审核。"
            },
            { const: "continue", title: "继续提交" }
          ]
        }
      }
    } as const satisfies PluginSettingsFormSchema;
    let received: unknown;
    const container = mount(
      <SettingsForm
        schema={schema}
        value={{}}
        onChange={(value) => {
          received = value;
        }}
        idPrefix="failure"
      />
    );
    const select = container.querySelector("select");

    expect(select).not.toBeNull();
    expect(select?.textContent).toContain("阻止提交");
    expect(select?.textContent).toContain("继续提交");
    expect(select?.value).toBe("0");
    expect(container.textContent).toContain("检查完成后才能进入审核。");

    act(() => {
      if (select !== null) {
        select.value = "1";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });

    expect(received).toEqual({ failureBehavior: "continue" });
  });

  it("父组件更新 value 后立即显示新值", () => {
    const schema = {
      type: "object",
      properties: {
        mode: {
          type: "string",
          title: "处理方式",
          oneOf: [
            { const: "block", title: "阻止提交" },
            { const: "continue", title: "继续提交" }
          ]
        }
      }
    } as const satisfies PluginSettingsFormSchema;
    const container = mount(
      <SettingsForm schema={schema} value={{ mode: "block" }} onChange={() => undefined} />
    );

    expect(container.querySelector("select")?.value).toBe("0");
    act(() =>
      mountedRoot?.render(
        <SettingsForm schema={schema} value={{ mode: "continue" }} onChange={() => undefined} />
      )
    );
    expect(container.querySelector("select")?.value).toBe("1");
  });

  it("enum 选项保留数字类型", () => {
    const schema = {
      type: "integer",
      title: "同时处理数量",
      enum: [1, 2, 4],
      default: 1
    } as const satisfies PluginSettingsFormSchema;
    let received: unknown;
    const container = mount(
      <SettingsForm
        schema={schema}
        value={1}
        onChange={(value) => {
          received = value;
        }}
      />
    );
    const select = container.querySelector("select");

    expect(select?.textContent).toContain("4");
    act(() => {
      if (select !== null) {
        select.value = "2";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    expect(received).toBe(4);
  });

  it("遇到当前页面不能编辑的一组内容时给出中文提示", () => {
    const schema = {
      type: "object",
      properties: {
        endpoints: {
          type: "array",
          title: "备用服务地址",
          description: "按顺序尝试这些地址。",
          items: { type: "string", format: "uri" }
        }
      }
    } as const satisfies PluginSettingsFormSchema;
    const html = renderToStaticMarkup(
      <SettingsForm schema={schema} value={{ endpoints: [] }} onChange={() => undefined} />
    );

    expect(html).toContain("备用服务地址");
    expect(html).toContain("按顺序尝试这些地址。");
    expect(html).toContain("这项设置包含一组可增减的内容，当前页面暂不支持修改。");
    expect(html).not.toContain("textarea");
  });
});
