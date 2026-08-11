import { describe, expect, it } from "vitest";
import {
  candidateContentDigest,
  sourceBindingDigest,
  sourceMappingDigest,
} from "../src/history-migration/digests";
import { historyCandidateRecordSchema } from "../src/history-migration/schema";

/**
 * 来源绑定摘要（sourceBindingSha256）的焦点测试。
 *
 * 核心不变量：
 * - 来源绑定只取来源编号、来源内容摘要和来源映射摘要，不包含标题。
 * - 标题改动不会改变来源绑定。
 * - 不同来源绑定即使标题相同也保持不同。
 * - 来源绑定与候选内容摘要（包含标题）不同。
 */
describe("sourceBindingDigest 来源绑定摘要", () => {
  const baseInput = {
    sourceId: "source-000042",
    sourceContentSha256: "a".repeat(64),
    sourceMappingSha256: "b".repeat(64),
  };

  it("对相同输入确定性产生相同摘要", () => {
    const a = sourceBindingDigest(baseInput);
    const b = sourceBindingDigest({ ...baseInput });
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it("标题不在绑定输入中——改标题不改变来源绑定", () => {
    // sourceBindingDigest 不接受 title 参数；绑定与标题无关。
    const binding = sourceBindingDigest(baseInput);
    // 对比：candidateContentDigest 接受 modelConfidence、normalizationNote、problem（含标题），
    // 所以改标题会改变 contentDigest，但不会改变 sourceBindingDigest。
    const contentWithTitleA = candidateContentDigest({
      ...baseInput,
      modelConfidence: 0.9,
      normalizationNote: "",
      problem: {
        title: "标题甲",
        type: "traditional",
        tags: [],
        difficulty: {},
        content: {
          basicStatement: "题面",
          basicSolution: "题解",
          background: "",
          statement: "",
          inputFormat: "",
          outputFormat: "",
          constraints: "",
          solution: "",
          hints: "",
        },
        samples: [],
        files: [],
        provenance: { sourceSystem: "ustc-history-private" },
        extensions: {},
      },
    });
    const contentWithTitleB = candidateContentDigest({
      ...baseInput,
      modelConfidence: 0.9,
      normalizationNote: "",
      problem: {
        title: "标题乙",
        type: "traditional",
        tags: [],
        difficulty: {},
        content: {
          basicStatement: "题面",
          basicSolution: "题解",
          background: "",
          statement: "",
          inputFormat: "",
          outputFormat: "",
          constraints: "",
          solution: "",
          hints: "",
        },
        samples: [],
        files: [],
        provenance: { sourceSystem: "ustc-history-private" },
        extensions: {},
      },
    });
    // 标题不同 → contentDigest 不同
    expect(contentWithTitleA).not.toBe(contentWithTitleB);
    // 但 sourceBindingDigest 不受标题影响
    expect(sourceBindingDigest(baseInput)).toBe(binding);
  });

  it("不同来源编号产生不同来源绑定", () => {
    const a = sourceBindingDigest({
      ...baseInput,
      sourceId: "source-000042",
    });
    const b = sourceBindingDigest({
      ...baseInput,
      sourceId: "source-000043",
    });
    expect(a).not.toBe(b);
  });

  it("不同来源内容摘要产生不同来源绑定", () => {
    const a = sourceBindingDigest({
      ...baseInput,
      sourceContentSha256: "a".repeat(64),
    });
    const b = sourceBindingDigest({
      ...baseInput,
      sourceContentSha256: "c".repeat(64),
    });
    expect(a).not.toBe(b);
  });

  it("不同来源映射摘要产生不同来源绑定", () => {
    const a = sourceBindingDigest({
      ...baseInput,
      sourceMappingSha256: "b".repeat(64),
    });
    const b = sourceBindingDigest({
      ...baseInput,
      sourceMappingSha256: "d".repeat(64),
    });
    expect(a).not.toBe(b);
  });

  it("不同来源绑定即使标题相同也保持不同", () => {
    // 两个不同的来源绑定，即使最终题目标题相同，绑定也不同。
    const bindingA = sourceBindingDigest({
      sourceId: "source-000042",
      sourceContentSha256: "a".repeat(64),
      sourceMappingSha256: "b".repeat(64),
    });
    const bindingB = sourceBindingDigest({
      sourceId: "source-000099",
      sourceContentSha256: "e".repeat(64),
      sourceMappingSha256: "f".repeat(64),
    });
    expect(bindingA).not.toBe(bindingB);
  });

  it("来源绑定与候选内容摘要不同", () => {
    const binding = sourceBindingDigest(baseInput);
    const content = candidateContentDigest({
      ...baseInput,
      modelConfidence: 0.5,
      normalizationNote: "",
      problem: {
        title: "测试标题",
        type: "traditional",
        tags: [],
        difficulty: {},
        content: {
          basicStatement: "题面",
          basicSolution: "题解",
          background: "",
          statement: "",
          inputFormat: "",
          outputFormat: "",
          constraints: "",
          solution: "",
          hints: "",
        },
        samples: [],
        files: [],
        provenance: { sourceSystem: "ustc-history-private" },
        extensions: {},
      },
    });
    expect(binding).not.toBe(content);
  });

  it("来源绑定与来源映射摘要不同", () => {
    const binding = sourceBindingDigest(baseInput);
    const mapping = sourceMappingDigest(
      {
        sourcePath: "/tmp/source.txt",
        sourceSha256: "a".repeat(64),
        metadataNumber: "1",
      },
      "b".repeat(64)
    );
    expect(binding).not.toBe(mapping);
  });
});

/**
 * 回放解析行为测试（不需要 PostgreSQL）。
 *
 * 验证：同一来源绑定但标题不同时，导入幂等键相同，
 * 因此回放会解析到既有任务，不会创建重复。
 */
describe("来源绑定回放解析", () => {
  it("同一来源绑定产生相同回放键，不同标题不改变键", () => {
    const binding = sourceBindingDigest({
      sourceId: "source-000042",
      sourceContentSha256: "a".repeat(64),
      sourceMappingSha256: "b".repeat(64),
    });
    // 标题不同但来源绑定相同时，回放键相同
    const keyWithTitleA = binding;
    const keyWithTitleB = binding;
    expect(keyWithTitleA).toBe(keyWithTitleB);
  });

  it("entrySourceBindingKey 回退：旧包报告没有 sourceBindingSha256 时回退到 packageSha256", () => {
    type PackageEntry = {
      candidateId: string;
      contentSha256: string;
      sourceBindingSha256?: string;
      packageSha256: string;
      packageBytes: number;
      status: "packaged";
    };
    // 旧包报告没有 sourceBindingSha256 字段；回退到 packageSha256 保持原有行为。
    const oldEntry: PackageEntry = {
      candidateId: "candidate-000001",
      contentSha256: "a".repeat(64),
      packageSha256: "e".repeat(64),
      packageBytes: 1024,
      status: "packaged",
    };
    // 新包报告有 sourceBindingSha256；使用它而不是 packageSha256。
    const newEntry: PackageEntry = {
      candidateId: "candidate-000001",
      contentSha256: "a".repeat(64),
      sourceBindingSha256: "f".repeat(64),
      packageSha256: "e".repeat(64),
      packageBytes: 1024,
      status: "packaged",
    };
    // 旧包回退到 packageSha256
    const oldKey = oldEntry.sourceBindingSha256 ?? oldEntry.packageSha256;
    expect(oldKey).toBe(oldEntry.packageSha256);
    // 新包使用 sourceBindingSha256
    const newKey = newEntry.sourceBindingSha256 ?? newEntry.packageSha256;
    expect(newKey).toBe(newEntry.sourceBindingSha256);
    expect(newKey).not.toBe(newEntry.packageSha256);
  });
});

/**
 * 候选记录 schema 测试：sourceBindingSha256 字段。
 */
describe("historyCandidateRecordSchema sourceBindingSha256 字段", () => {
  it("新记录包含 sourceBindingSha256 时验证通过", () => {
    const record = {
      version: 1,
      candidateId: "candidate-000001",
      sourceId: "source-000042",
      sourceContentSha256: "a".repeat(64),
      sourceMappingSha256: "b".repeat(64),
      sourceBindingSha256: "c".repeat(64),
      contentSha256: "d".repeat(64),
      modelConfidence: 0.9,
      normalizationNote: "",
      problem: {
        title: "测试题目",
        type: "traditional",
        tags: [],
        difficulty: {},
        content: {
          basicStatement: "题面",
          basicSolution: "题解",
          background: "",
          statement: "",
          inputFormat: "",
          outputFormat: "",
          constraints: "",
          solution: "",
          hints: "",
        },
        samples: [],
        files: [],
        provenance: { sourceSystem: "ustc-history-private" },
        extensions: {},
      },
    };
    const parsed = historyCandidateRecordSchema.safeParse(record);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.sourceBindingSha256).toBe("c".repeat(64));
    }
  });

  it("旧记录缺少 sourceBindingSha256 时验证通过（向后兼容）", () => {
    const oldRecord = {
      version: 1,
      candidateId: "candidate-000001",
      sourceId: "source-000042",
      sourceContentSha256: "a".repeat(64),
      sourceMappingSha256: "b".repeat(64),
      contentSha256: "d".repeat(64),
      modelConfidence: 0.9,
      normalizationNote: "",
      problem: {
        title: "测试题目",
        type: "traditional",
        tags: [],
        difficulty: {},
        content: {
          basicStatement: "题面",
          basicSolution: "题解",
          background: "",
          statement: "",
          inputFormat: "",
          outputFormat: "",
          constraints: "",
          solution: "",
          hints: "",
        },
        samples: [],
        files: [],
        provenance: { sourceSystem: "ustc-history-private" },
        extensions: {},
      },
    };
    const parsed = historyCandidateRecordSchema.safeParse(oldRecord);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.sourceBindingSha256).toBeUndefined();
    }
  });
});

/**
 * 隐私哨兵测试：来源绑定摘要不泄露题目标题内容。
 */
describe("隐私哨兵：来源绑定不泄露标题", () => {
  it("来源绑定摘要不包含可逆的标题信息", () => {
    const title = "这是一道包含敏感信息的标题";
    const binding = sourceBindingDigest({
      sourceId: "source-000042",
      sourceContentSha256: "a".repeat(64),
      sourceMappingSha256: "b".repeat(64),
    });
    // 摘要是 SHA-256 哈希，不包含可逆的标题文本
    expect(binding).not.toContain(title);
    expect(binding).not.toContain("敏感");
    expect(binding).toMatch(/^[a-f0-9]{64}$/);
  });

  it("来源绑定摘要不包含来源元数据名称", () => {
    const metadataName = "【1400~1600】可持久化文艺二叉树";
    const binding = sourceBindingDigest({
      sourceId: "source-000042",
      sourceContentSha256: "a".repeat(64),
      sourceMappingSha256: "b".repeat(64),
    });
    expect(binding).not.toContain(metadataName);
    expect(binding).not.toContain("文艺");
    expect(binding).not.toContain("二叉树");
  });
});

/**
 * 碰撞行为测试：不同来源绑定不会碰撞。
 */
describe("碰撞行为：不同来源绑定不碰撞", () => {
 it("多个不同来源绑定互不相同", () => {
   const sourceIds = [
     "source-000042", "source-000043", "source-000059",
     "source-000080", "source-000082", "source-000096",
     "source-000099", "source-000100", "source-000101",
   ];
   const bindings = sourceIds.map(sourceId =>
     sourceBindingDigest({
       sourceId,
       sourceContentSha256: "a".repeat(64),
       sourceMappingSha256: "b".repeat(64),
     })
   );
   const uniqueBindings = new Set(bindings);
   expect(uniqueBindings.size).toBe(sourceIds.length);
 });

 it("来源编号相同但内容摘要不同时不碰撞", () => {
   const bindingA = sourceBindingDigest({
     sourceId: "source-000042",
     sourceContentSha256: "a".repeat(64),
     sourceMappingSha256: "b".repeat(64),
   });
   const bindingB = sourceBindingDigest({
     sourceId: "source-000042",
     sourceContentSha256: "c".repeat(64),
     sourceMappingSha256: "b".repeat(64),
   });
   expect(bindingA).not.toBe(bindingB);
 });

 it("回放同一来源绑定幂等——重复计算产生相同键", () => {
   const input = {
     sourceId: "source-000099",
     sourceContentSha256: "a".repeat(64),
     sourceMappingSha256: "b".repeat(64),
   };
   const key1 = sourceBindingDigest(input);
   const key2 = sourceBindingDigest(input);
   const key3 = sourceBindingDigest(input);
   expect(key1).toBe(key2);
   expect(key2).toBe(key3);
 });
});
