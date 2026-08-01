import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownEditor, MarkdownPreview } from "./markdown-editor";

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function mountEditor(props: {
  onChange: (value: string) => void;
  onUploadImage: (file: File) => Promise<string>;
}) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <MarkdownEditor
        label="题目描述"
        value=""
        onChange={props.onChange}
        problemId="42"
        onUploadImage={props.onUploadImage}
      />
    );
  });
  return container;
}

async function chooseFile(view: HTMLElement, file: File): Promise<void> {
  const input = view.querySelector('input[type="file"]');
  if (!(input instanceof HTMLInputElement)) {
    throw new Error("找不到图片选择框。");
  }
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(() => {
  if (root !== undefined) {
    act(() => root?.unmount());
  }
  container?.remove();
  root = undefined;
  container = undefined;
});

describe("Markdown 图片预览", () => {
  it("隐藏外部图片地址", () => {
    const html = renderToStaticMarkup(
      <MarkdownPreview value="![跟踪图片](https://tracker.example/pixel.png)" problemId="42" />
    );

    expect(html).not.toContain("<img");
    expect(html).not.toContain("tracker.example");
    expect(html).toContain("外部图片已隐藏");
  });

  it("只允许当前题目的受控文件地址", () => {
    const html = renderToStaticMarkup(
      <MarkdownPreview
        value="![示意图](/api/v1/problems/42/files/7293643f-8197-449c-b48b-f674ab0b3772)"
        problemId="42"
      />
    );

    expect(html).toContain("<img");
    expect(html).toContain("/api/v1/problems/42/files/7293643f-8197-449c-b48b-f674ab0b3772");
    expect(html).toContain('referrerPolicy="no-referrer"');
  });

  it("隐藏另一个题目的文件地址", () => {
    const html = renderToStaticMarkup(
      <MarkdownPreview
        value="![示意图](/api/v1/problems/99/files/7293643f-8197-449c-b48b-f674ab0b3772)"
        problemId="42"
      />
    );

    expect(html).not.toContain("<img");
    expect(html).toContain("外部图片已隐藏");
  });

  it("图片上传成功后插入受控 Markdown 地址", async () => {
    const onChange = vi.fn();
    const onUploadImage = vi
      .fn<(file: File) => Promise<string>>()
      .mockResolvedValue("/api/v1/problems/42/files/7293643f-8197-449c-b48b-f674ab0b3772");
    const view = mountEditor({ onChange, onUploadImage });

    await chooseFile(view, new File(["synthetic"], "figure.png", { type: "image/png" }));

    expect(onUploadImage).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith(
      "![题面图片](/api/v1/problems/42/files/7293643f-8197-449c-b48b-f674ab0b3772)"
    );
  });

  it("错误图片类型不会发起上传", async () => {
    const onChange = vi.fn();
    const onUploadImage = vi.fn<(file: File) => Promise<string>>();
    const view = mountEditor({ onChange, onUploadImage });

    await chooseFile(view, new File(["synthetic"], "notes.txt", { type: "text/plain" }));

    expect(onUploadImage).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(view.textContent).toContain("仅支持 PNG、JPEG、GIF 或 WebP 图片。");
  });

  it("上传失败时保留正文并显示服务端错误", async () => {
    const onChange = vi.fn();
    const onUploadImage = vi
      .fn<(file: File) => Promise<string>>()
      .mockRejectedValue(new Error("文件超出允许的大小限制。"));
    const view = mountEditor({ onChange, onUploadImage });

    await chooseFile(view, new File(["synthetic"], "huge.png", { type: "image/png" }));

    expect(onChange).not.toHaveBeenCalled();
    expect(view.querySelector('[role="alert"]')?.textContent).toContain("文件超出允许的大小限制。");
  });
});
