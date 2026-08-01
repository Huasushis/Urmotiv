import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownEditor, MarkdownPreview } from "./markdown-editor";

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function mountEditor(props: {
  onChange: (value: string) => void;
  onUploadImage?: ((file: File) => Promise<string>) | undefined;
  value?: string;
  readOnly?: boolean;
  uploadDisabled?: boolean;
}) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <MarkdownEditor
        label="题目描述"
        value={props.value ?? ""}
        onChange={props.onChange}
        problemId="42"
        {...(props.onUploadImage === undefined ? {} : { onUploadImage: props.onUploadImage })}
        {...(props.readOnly === undefined ? {} : { readOnly: props.readOnly })}
        {...(props.uploadDisabled === undefined ? {} : { uploadDisabled: props.uploadDisabled })}
      />
    );
  });
  return container;
}

type ClipboardItem = {
  kind: "file" | "string";
  type: string;
  getAsFile: () => File | null;
};

function fileClipboardItem(file: File): ClipboardItem {
  return { kind: "file", type: file.type, getAsFile: () => file };
}

function textClipboardItem(): ClipboardItem {
  return { kind: "string", type: "text/plain", getAsFile: () => null };
}

async function paste(view: HTMLElement, items: readonly ClipboardItem[]): Promise<Event> {
  const field = view.querySelector("textarea");
  if (!(field instanceof HTMLTextAreaElement)) {
    throw new Error("找不到 Markdown 编辑框。");
  }
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { items } });
  await act(async () => {
    field.dispatchEvent(event);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return event;
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

  it("粘贴单张支持的图片时阻止默认粘贴并上传到光标位置", async () => {
    const onChange = vi.fn();
    const onUploadImage = vi
      .fn<(file: File) => Promise<string>>()
      .mockResolvedValue("/api/v1/problems/42/files/7293643f-8197-449c-b48b-f674ab0b3772");
    const view = mountEditor({ onChange, onUploadImage, value: "前后" });
    const field = view.querySelector("textarea");
    if (!(field instanceof HTMLTextAreaElement)) {
      throw new Error("找不到 Markdown 编辑框。");
    }
    field.setSelectionRange(1, 1);

    const event = await paste(
      view,
      [textClipboardItem(), fileClipboardItem(new File(["synthetic"], "figure.png", { type: "image/png" }))]
    );

    expect(event.defaultPrevented).toBe(true);
    expect(onUploadImage).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith(
      "前![题面图片](/api/v1/problems/42/files/7293643f-8197-449c-b48b-f674ab0b3772)后"
    );
  });

  it("普通文字粘贴保持浏览器默认行为", async () => {
    const onChange = vi.fn();
    const onUploadImage = vi.fn<(file: File) => Promise<string>>();
    const view = mountEditor({ onChange, onUploadImage, value: "原正文" });

    const event = await paste(view, [textClipboardItem()]);

    expect(event.defaultPrevented).toBe(false);
    expect(onUploadImage).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("粘贴不支持的图片类型时不拦截也不上传", async () => {
    const onChange = vi.fn();
    const onUploadImage = vi.fn<(file: File) => Promise<string>>();
    const view = mountEditor({ onChange, onUploadImage, value: "原正文" });

    const event = await paste(
      view,
      [fileClipboardItem(new File(["synthetic"], "figure.bmp", { type: "image/bmp" }))]
    );

    expect(event.defaultPrevented).toBe(false);
    expect(onUploadImage).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(view.querySelector('[role="alert"]')?.textContent).toBe(
      "仅支持 PNG、JPEG、GIF 或 WebP 图片。"
    );
  });

  it("粘贴多张图片时不选择其中一张并显示固定提示", async () => {
    const onChange = vi.fn();
    const onUploadImage = vi.fn<(file: File) => Promise<string>>();
    const view = mountEditor({ onChange, onUploadImage, value: "原正文" });

    const event = await paste(view, [
      fileClipboardItem(new File(["one"], "one.png", { type: "image/png" })),
      fileClipboardItem(new File(["two"], "two.jpg", { type: "image/jpeg" }))
    ]);

    expect(event.defaultPrevented).toBe(false);
    expect(onUploadImage).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(view.querySelector('[role="alert"]')?.textContent).toBe(
      "剪贴板中包含多张图片，请一次只粘贴一张。"
    );
  });

  it.each([
    { name: "只读", props: { readOnly: true } },
    { name: "禁用上传", props: { uploadDisabled: true } },
    { name: "没有上传器", props: { onUploadImage: undefined } }
  ])("$name 时不拦截图片粘贴", async ({ props }) => {
    const onChange = vi.fn();
    const onUploadImage = vi.fn<(file: File) => Promise<string>>();
    const view = mountEditor({ onChange, onUploadImage, ...props });

    const event = await paste(
      view,
      [fileClipboardItem(new File(["synthetic"], "figure.png", { type: "image/png" }))]
    );

    expect(event.defaultPrevented).toBe(false);
    expect(onUploadImage).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("上传未结束时不会重复上传", async () => {
    const onChange = vi.fn();
    let finishUpload: ((source: string) => void) | undefined;
    const onUploadImage = vi.fn<(file: File) => Promise<string>>(
      () => new Promise((resolve) => {
        finishUpload = resolve;
      })
    );
    const view = mountEditor({ onChange, onUploadImage });
    const image = fileClipboardItem(new File(["synthetic"], "figure.png", { type: "image/png" }));

    const firstEvent = await paste(view, [image]);
    const secondEvent = await paste(view, [image]);

    expect(firstEvent.defaultPrevented).toBe(true);
    expect(secondEvent.defaultPrevented).toBe(false);
    expect(onUploadImage).toHaveBeenCalledOnce();

    await act(async () => {
      finishUpload?.("/api/v1/problems/42/files/7293643f-8197-449c-b48b-f674ab0b3772");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(onChange).toHaveBeenCalledOnce();
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

  it("上传失败时保留正文并显示固定错误", async () => {
    const onChange = vi.fn();
    const onUploadImage = vi
      .fn<(file: File) => Promise<string>>()
      .mockRejectedValue(new Error("文件超出允许的大小限制。"));
    const view = mountEditor({ onChange, onUploadImage, value: "原正文" });

    await chooseFile(view, new File(["synthetic"], "huge.png", { type: "image/png" }));

    expect(onChange).not.toHaveBeenCalled();
    expect((view.querySelector("textarea") as HTMLTextAreaElement | null)?.value).toBe("原正文");
    expect(view.querySelector('[role="alert"]')?.textContent).toBe("图片上传失败，请稍后重试。");
  });
});
