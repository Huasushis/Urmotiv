import {expect,it} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import {MarkdownPreview} from "../components/markdown-editor";
import {normalizeMathDelimiters} from "./markdown-math";
import {createRequire} from "node:module";

it("数学渲染和样式必须使用同一 KaTeX 版本",()=>{
  const require=createRequire(import.meta.url);
  const renderer=createRequire(require.resolve("rehype-katex"));
  expect(require("katex/package.json").version).toBe(renderer("katex/package.json").version);
});
it("括号、方括号与美元公式兼容，含上下标分式和多行矩阵",()=>{
  const html=renderToStaticMarkup(<MarkdownPreview value={String.raw`行内 \(a_i^2 + b_{j+1}\) 与 $x^3$。
\[\sum_{i=1}^{n}\frac{1}{i^2}\]
\[
\begin{aligned}a&=b+c\\d&=e\end{aligned}
\]`} />);
  expect((html.match(/class="katex"/g)??[])).toHaveLength(4);
  expect((html.match(/class="katex-display"/g)??[])).toHaveLength(2);
  expect(html).not.toContain('katex-error');expect(html).toContain('msupsub');
});
it("不改写代码、链接地址、原公式和显式转义，未闭合分隔符保留",()=>{
  for(const value of ['`\\(x\\)`','```tex\n\\[x\\]\n```','    \\(x\\)','[链接](https://example.test/\\(x\\))',String.raw`\\(x\\)`,String.raw`$\text{\(x\)}$`,String.raw`\(未闭合`])
    expect(normalizeMathDelimiters(value)).toBe(value);
});
