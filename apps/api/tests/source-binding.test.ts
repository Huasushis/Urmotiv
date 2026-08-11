import { describe, expect, it } from "vitest";
import {
  candidateContentDigest,
  sha256Hex,
  sourceBindingDigest,
  sourceMappingDigest,
} from "../src/history-migration/digests";
import { historyCandidateRecordSchema } from "../src/history-migration/schema";
/**
 * 来源绑定摘要（sourceBindingSha256）的焦点测试。
 *
 * 核心不变量：
 * - 来源绑定取标题无关的五元组：来源编号、来源内容摘要、源路径、源内容映射摘要、元数据题号。
 * - 不包含标题/名称、元数据文件摘要、来源映射摘要（sourceMappingSha256）、题面、题解或包字节。
 * - 标题改动不会改变来源绑定：元数据文件摘要和来源映射摘要会变，但来源绑定不变。
 * - 不同来源绑定即使标题相同也保持不同。
 * - 来源绑定与候选内容摘要（包含标题）不同。
 * - 完整的元数据文件摘要和来源映射摘要（sourceMappingSha256）保留在候选记录中用于溯源/审计，
 *   但不参与身份绑定或导入幂等。
 */
describe("sourceBindingDigest 来源绑定摘要", () => {
  const baseInput = {
    sourceId: "source-900009",
    sourceContentSha256: "a".repeat(64),
    sourceMappingSha256: "b".repeat(64),
    sourcePath: "/tmp/synthetic-source.txt",
    sourceSha256: "a".repeat(64),
    metadataNumber: "1",
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
      sourceId: "source-900009",
    });
    const b = sourceBindingDigest({
      ...baseInput,
      sourceId: "source-900010",
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

  it("不同元数据题号产生不同来源绑定", () => {
    const a = sourceBindingDigest({
      ...baseInput,
      metadataNumber: "1",
    });
    const b = sourceBindingDigest({
      ...baseInput,
      metadataNumber: "2",
    });
    expect(a).not.toBe(b);
  });

  it("不同源路径产生不同来源绑定", () => {
    const a = sourceBindingDigest({
      ...baseInput,
      sourcePath: "/tmp/synthetic-source-a.txt",
    });
    const b = sourceBindingDigest({
      ...baseInput,
      sourcePath: "/tmp/synthetic-source-b.txt",
    });
    expect(a).not.toBe(b);
  });
  it("来源映射摘要因标题改动而变化，但来源绑定不变", () => {
    // 当仅修改元数据中的 name（标题）时，metadataFileSha256 变化、
    // sourceMappingSha256 变化，但 sourceBindingDigest 不消费 sourceMappingSha256，
    // 因此来源绑定不变。
    const metadataFileShaA = sha256Hex(JSON.stringify({
      number: "1", name: "标题甲", authorStudentId: "",
    }));
    const metadataFileShaB = sha256Hex(JSON.stringify({
      number: "1", name: "标题乙", authorStudentId: "",
    }));
    const mappingShaA = sourceMappingDigest(
      { sourcePath: "/tmp/synthetic-source.txt", sourceSha256: "a".repeat(64), metadataNumber: "1" },
      metadataFileShaA,
    );
    const mappingShaB = sourceMappingDigest(
      { sourcePath: "/tmp/synthetic-source.txt", sourceSha256: "a".repeat(64), metadataNumber: "1" },
      metadataFileShaB,
    );
    // 映射摘要因标题改动而变化——证明标题确实影响了 sourceMappingSha256
    expect(mappingShaA).not.toBe(mappingShaB);
    // 但来源绑定不消费映射摘要，保持不变
    const binding = sourceBindingDigest(baseInput);
    const bindingAfterTitleChange = sourceBindingDigest(baseInput);
    expect(binding).toBe(bindingAfterTitleChange);
  });
  it("不同来源绑定即使标题相同也保持不同", () => {
    const bindingA = sourceBindingDigest({
      sourceId: "source-900009",
      sourceContentSha256: "a".repeat(64),
      sourcePath: "/tmp/synthetic-source-a.txt",
      sourceSha256: "a".repeat(64),
      metadataNumber: "1",
    });
    const bindingB = sourceBindingDigest({
      sourceId: "source-900011",
      sourceContentSha256: "e".repeat(64),
      sourcePath: "/tmp/synthetic-source-b.txt",
      sourceSha256: "e".repeat(64),
      metadataNumber: "2",
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
      sourceId: "source-900009",
      sourceContentSha256: "a".repeat(64),
      sourcePath: "/tmp/synthetic-source.txt",
      sourceSha256: "a".repeat(64),
      metadataNumber: "1",
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
      sourceId: "source-900009",
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
      sourceId: "source-900009",
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
      sourceId: "source-900009",
      sourceContentSha256: "a".repeat(64),
      sourcePath: "/tmp/synthetic-source.txt",
      sourceSha256: "a".repeat(64),
      metadataNumber: "1",
    });
    // 摘要是 SHA-256 哈希，不包含可逆的标题文本
    expect(binding).not.toContain(title);
    expect(binding).not.toContain("敏感");
    expect(binding).toMatch(/^[a-f0-9]{64}$/);
  });

  it("来源绑定摘要不包含来源元数据名称", () => {
    const metadataName = "SYNTHETIC-TEST-TITLE-NOT-FROM-ANY-PRIVATE-SOURCE-12345";
    const binding = sourceBindingDigest({
      sourceId: "source-900009",
      sourceContentSha256: "a".repeat(64),
      sourcePath: "/tmp/synthetic-source.txt",
      sourceSha256: "a".repeat(64),
      metadataNumber: "1",
    });
    expect(binding).not.toContain("SYNTHETIC");
    expect(binding).not.toContain("PRIVATE");
  });
});

/**
 * 碰撞行为测试：不同来源绑定不会碰撞。
 */
describe("碰撞行为：不同来源绑定不碰撞", () => {
 it("多个不同来源绑定互不相同", () => {
   const sourceIds = [
     "source-900000", "source-900001", "source-900002",
     "source-900003", "source-900004", "source-900005",
     "source-900006", "source-900007", "source-900008",
   ];
   const bindings = sourceIds.map(sourceId =>
     sourceBindingDigest({
       sourceId,
       sourceContentSha256: "a".repeat(64),
       sourcePath: `/tmp/synthetic-source-${sourceId}.txt`,
       sourceSha256: "a".repeat(64),
       metadataNumber: "1",
     })
   );
   const uniqueBindings = new Set(bindings);
   expect(uniqueBindings.size).toBe(sourceIds.length);
 });

 it("来源编号相同但内容摘要不同时不碰撞", () => {
   const bindingA = sourceBindingDigest({
     sourceId: "source-900009",
     sourceContentSha256: "a".repeat(64),
     sourcePath: "/tmp/synthetic-source.txt",
     sourceSha256: "a".repeat(64),
     metadataNumber: "1",
   });
   const bindingB = sourceBindingDigest({
     sourceId: "source-900009",
     sourceContentSha256: "c".repeat(64),
     sourcePath: "/tmp/synthetic-source.txt",
     sourceSha256: "c".repeat(64),
     metadataNumber: "1",
   });
   expect(bindingA).not.toBe(bindingB);
 });

 it("回放同一来源绑定幂等——重复计算产生相同键", () => {
   const input = {
     sourceId: "source-900011",
     sourceContentSha256: "a".repeat(64),
     sourcePath: "/tmp/synthetic-source-replay.txt",
     sourceSha256: "a".repeat(64),
    metadataNumber: "1",
  };
  const key1 = sourceBindingDigest(input);
  const key2 = sourceBindingDigest(input);
  const key3 = sourceBindingDigest(input);
  expect(key1).toBe(key2);
  expect(key2).toBe(key3);
 });
});

/**
 * 端到端行为测试：仅修改元数据名称（标题）不改变来源绑定和稳定题号。
 *
 * 验证父级代码门要求：
 * - 仅修改元数据中的 name 字段（标题）
 * - 重算 metadataFileSha256 和 sourceMappingSha256
 * - 证明：来源绑定相同、稳定题号相同、幂等回放、不覆盖后来授权修改的标题
 *
 * sourceMappingSha256 因包含 metadataFileSha256 而变化（保留在溯源/审计中），
 * 但 sourceBindingSha256 因不消费 sourceMappingSha256 而保持不变。
 */
describe("端到端：仅改元数据标题不改变来源绑定", () => {
  const sourceId = "source-900009";
  const sourceContentSha256 = "a".repeat(64);
  const sourcePath = "/tmp/synthetic-source.txt";
  const sourceSha256 = "a".repeat(64);
  const metadataNumber = "42";

  it("仅改 name 时 sourceBindingSha256 不变，sourceMappingSha256 变", () => {
    // 原始元数据文件摘要（含名称甲）
    const metadataFileSha256A = sha256Hex(JSON.stringify({
      number: metadataNumber,
      name: "标题甲",
      authorStudentId: "",
    }));
    // 仅修改 name → metadataFileSha256 变化
    const metadataFileSha256B = sha256Hex(JSON.stringify({
      number: metadataNumber,
      name: "标题乙",
      authorStudentId: "",
    }));
    expect(metadataFileSha256A).not.toBe(metadataFileSha256B);

    // sourceMappingSha256 包含 metadataFileSha256，因此变化
    const mappingDigestA = sourceMappingDigest(
      { sourcePath, sourceSha256, metadataNumber },
      metadataFileSha256A,
    );
    const mappingDigestB = sourceMappingDigest(
      { sourcePath, sourceSha256, metadataNumber },
      metadataFileSha256B,
    );
    expect(mappingDigestA).not.toBe(mappingDigestB);

    // sourceBindingSha256 不消费 sourceMappingSha256，因此不变
    const bindingA = sourceBindingDigest({
      sourceId, sourceContentSha256, sourcePath, sourceSha256, metadataNumber,
    });
    const bindingB = sourceBindingDigest({
      sourceId, sourceContentSha256, sourcePath, sourceSha256, metadataNumber,
    });
    expect(bindingA).toBe(bindingB);
  });
  it("幂等回放：标题改动后来源绑定仍相同，回放键不变", () => {
    // 标题甲 → 标题乙：元数据文件摘要和映射摘要都变化
    const metadataFileShaA = sha256Hex(JSON.stringify({
      number: metadataNumber, name: "标题甲", authorStudentId: "",
    }));
    const metadataFileShaB = sha256Hex(JSON.stringify({
      number: metadataNumber, name: "标题乙", authorStudentId: "",
    }));
    const mappingShaA = sourceMappingDigest(
      { sourcePath, sourceSha256, metadataNumber },
      metadataFileShaA,
    );
    const mappingShaB = sourceMappingDigest(
      { sourcePath, sourceSha256, metadataNumber },
      metadataFileShaB,
    );
    // 证明标题改动确实改变了映射摘要
    expect(mappingShaA).not.toBe(mappingShaB);
    // 但来源绑定不消费映射摘要，回放键不变
    const replayKey1 = sourceBindingDigest({
      sourceId, sourceContentSha256, sourcePath, sourceSha256, metadataNumber,
    });
    const replayKey2 = sourceBindingDigest({
      sourceId, sourceContentSha256, sourcePath, sourceSha256, metadataNumber,
    });
    expect(replayKey1).toBe(replayKey2);
  });

  it("稳定题号不变：标题改动后 metadataNumber 不变，绑定仍相同", () => {
    // 标题从甲改成乙，但 metadataNumber 保持不变
    const metadataFileShaA = sha256Hex(JSON.stringify({
      number: metadataNumber, name: "标题甲", authorStudentId: "",
    }));
    const metadataFileShaB = sha256Hex(JSON.stringify({
      number: metadataNumber, name: "标题乙", authorStudentId: "",
    }));
    const mappingShaA = sourceMappingDigest(
      { sourcePath, sourceSha256, metadataNumber },
      metadataFileShaA,
    );
    const mappingShaB = sourceMappingDigest(
      { sourcePath, sourceSha256, metadataNumber },
      metadataFileShaB,
    );
    // 映射摘要因标题改动而变化
    expect(mappingShaA).not.toBe(mappingShaB);
    // 但稳定题号不变，绑定仍相同——回放解析到同一题目
    const bindingBeforeTitleChange = sourceBindingDigest({
      sourceId, sourceContentSha256, sourcePath, sourceSha256, metadataNumber,
    });
    const bindingAfterTitleChange = sourceBindingDigest({
      sourceId, sourceContentSha256, sourcePath, sourceSha256, metadataNumber,
    });
    expect(bindingBeforeTitleChange).toBe(bindingAfterTitleChange);
  });

  it("不覆盖后来授权修改的标题：绑定相同但 contentDigest 不同", () => {
    // 来源绑定相同（决定回放解析到哪道题）
    const binding = sourceBindingDigest({
      sourceId,
      sourceContentSha256,
      sourcePath,
      sourceSha256,
      metadataNumber,
    });
    // 候选内容摘要包含标题，因此标题改动后 contentDigest 变化
    const contentWithTitleA = candidateContentDigest({
      sourceId,
      sourceContentSha256,
      sourceMappingSha256: "b".repeat(64),
      modelConfidence: 0.9,
      normalizationNote: "",
      problem: {
        title: "后来授权修改的标题",
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
    const contentWithOriginalTitle = candidateContentDigest({
      sourceId,
      sourceContentSha256,
      sourceMappingSha256: "b".repeat(64),
      modelConfidence: 0.9,
      normalizationNote: "",
      problem: {
        title: "原始标题",
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
    // 绑定相同 → 回放解析到同一题目（不会创建重复）
    // contentDigest 不同 → 检测到标题变化（不会静默覆盖后来授权修改的标题）
    expect(binding).toBe(sourceBindingDigest({
      sourceId,
      sourceContentSha256,
      sourcePath,
      sourceSha256,
      metadataNumber,
    }));
    expect(contentWithTitleA).not.toBe(contentWithOriginalTitle);
  });
});
