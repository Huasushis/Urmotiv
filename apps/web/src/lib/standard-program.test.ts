import { describe, it, expect } from "vitest";
import { extractStandardProgram, sourceLanguage, sourcePreview } from "./standard-program";
describe("标准程序原文提取", () => {
  it("只移除外层围栏，保留代码缩进、空行和公式字符", () => {
    expect(
      extractStandardProgram('```python\nfor x in xs:\n    print("\\(x\\)")\n\n```\n'),
    ).toEqual({ language: "python", source: 'for x in xs:\n    print("\\(x\\)")\n' });
    expect(extractStandardProgram("  int main() {}\n")).toEqual({
      language: "plaintext",
      source: "  int main() {}\n",
    });
  });
  it("语言来自围栏或文件扩展名，未知语言不冒认", () => {
    expect(sourceLanguage("std.cc")).toBe("cpp");
    expect(sourceLanguage("python3")).toBe("python");
    expect(sourceLanguage("unknown")).toBe("plaintext");
    expect(sourcePreview('x="```"', "python")).toBe('````python\nx="```"\n````');
  });
});
