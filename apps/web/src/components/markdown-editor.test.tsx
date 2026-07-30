import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownPreview } from "./markdown-editor";

describe("Markdown 图片预览", () => {
  it("隐藏外部图片地址", () => {
    const html = renderToStaticMarkup(
      <MarkdownPreview value="![跟踪图片](https://tracker.example/pixel.png)" />
    );

    expect(html).not.toContain("<img");
    expect(html).not.toContain("tracker.example");
    expect(html).toContain("外部图片已隐藏");
  });

  it("允许本站受控文件地址", () => {
    const html = renderToStaticMarkup(
      <MarkdownPreview value="![示意图](/api/v1/files/7293643f-8197-449c-b48b-f674ab0b3772)" />
    );

    expect(html).toContain("<img");
    expect(html).toContain("/api/v1/files/7293643f-8197-449c-b48b-f674ab0b3772");
    expect(html).toContain('referrerPolicy="no-referrer"');
  });
});
