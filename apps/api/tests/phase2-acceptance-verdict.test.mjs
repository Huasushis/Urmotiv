import { describe, expect, it } from "vitest";
import {
  assessFormalShard,
  assessFormalShardBindings,
  expectedBindingKind,
  finalizeStatus,
  gitMetadataHidingReasons,
  postRunDirtyReasons,
} from "../scripts/phase2-acceptance-verdict.mjs";

const strictBindings = {
  batchSha256: "a".repeat(64),
  manifestIdentitySha256: "b".repeat(64),
  manifestContentBindingsSha256: "c".repeat(64),
  codeInventorySha256: "d".repeat(64),
  codeInventoryEntryCount: 375,
};

const environment = { headCommit: "f".repeat(40), runnerExitCode: 0 };

function shardFixture(overrides) {
  return {
    version: 1,
    route: "formal",
    headCommit: "f".repeat(40),
    formalExitCode: 0,
    formalTargetSynthetic: false,
    formalVerdict: "REAL_PASS",
    bindings: strictBindings,
    ...overrides,
  };
}

describe("assessFormalShardBindings", () => {
  it("严格绑定全部符合类型时通过", () => {
    expect(assessFormalShardBindings(strictBindings).strictOk).toBe(true);
  });
  it("条目计数必须是数字，摘要必须是字符串", () => {
    expect(expectedBindingKind("codeInventoryEntryCount")).toBe("number");
    expect(expectedBindingKind("batchSha256")).toBe("string");
    expect(expectedBindingKind("unknown-key")).toBeNull();
    const withStringCount = assessFormalShardBindings({
      ...strictBindings,
      codeInventoryEntryCount: "375",
    });
    expect(withStringCount.strictOk).toBe(false);
    expect(withStringCount.wrongKind).toEqual(["codeInventoryEntryCount"]);
    const withNumericHash = assessFormalShardBindings({
      ...strictBindings,
      batchSha256: 42,
    });
    expect(withNumericHash.wrongKind).toEqual(["batchSha256"]);
    expect(withNumericHash.strictOk).toBe(false);
  });
  it("非对象结构直接拒绝", () => {
    const assessment = assessFormalShardBindings("not-an-object");
    expect(assessment.structureBroken).toBe(true);
    expect(assessment.strictOk).toBe(false);
  });
  it("null 与缺失分别记录", () => {
    const assessment = assessFormalShardBindings({ ...strictBindings, batchSha256: null });
    expect(assessment.nulled).toEqual(["batchSha256"]);
    const withoutKey = { ...strictBindings };
    delete withoutKey.manifestIdentitySha256;
    const missing = assessFormalShardBindings(withoutKey);
    expect(missing.missing).toEqual(["manifestIdentitySha256"]);
    expect(missing.strictOk).toBe(false);
  });
});

describe("finalizeStatus：运行后整树突变必须压掉一切成功定级", () => {
  it("两个成功分支在树脏时都压为 INCONCLUSIVE", () => {
    expect(
      finalizeStatus({ candidate: "PASS", reasonCodes: ["PHASE2_ROUTE_PASS", "POST_RUN_TREE_NOT_CLEAN"] }),
    ).toBe("INCONCLUSIVE");
    expect(
      finalizeStatus({
        candidate: "IMPLEMENTATION_READY",
        reasonCodes: ["PHASE2_ROUTE_SYNTHETIC_READINESS", "POST_RUN_TREE_NOT_CLEAN"],
      }),
    ).toBe("INCONCLUSIVE");
  });
  it("两个成功分支在 HEAD 漂移时都压为 INCONCLUSIVE", () => {
    expect(
      finalizeStatus({ candidate: "PASS", reasonCodes: ["PHASE2_ROUTE_PASS", "POST_RUN_HEAD_MOVED"] }),
    ).toBe("INCONCLUSIVE");
    expect(
      finalizeStatus({
        candidate: "IMPLEMENTATION_READY",
        reasonCodes: ["PHASE2_ROUTE_SYNTHETIC_READINESS", "POST_RUN_HEAD_MOVED"],
      }),
    ).toBe("INCONCLUSIVE");
  });
  it("两种突变同时出现同样压为 INCONCLUSIVE", () => {
    expect(
      finalizeStatus({
        candidate: "PASS",
        reasonCodes: ["POST_RUN_HEAD_MOVED", "POST_RUN_TREE_NOT_CLEAN"],
      }),
    ).toBe("INCONCLUSIVE");
  });
  it("干净检出的成功候选保持原定级，非成功候选不受影响", () => {
    expect(finalizeStatus({ candidate: "PASS", reasonCodes: ["PHASE2_ROUTE_PASS"] })).toBe("PASS");
    expect(
      finalizeStatus({ candidate: "IMPLEMENTATION_READY", reasonCodes: [] }),
    ).toBe("IMPLEMENTATION_READY");
    expect(
      finalizeStatus({ candidate: "INCONCLUSIVE", reasonCodes: ["POST_RUN_HEAD_MOVED"] }),
    ).toBe("INCONCLUSIVE");
  });
});

describe("assessFormalShard 对抗性判定", () => {
  it("真实目标 + 全部严格字段 → REAL_PASS", () => {
    expect(assessFormalShard(shardFixture({}), environment).admission).toBe("REAL_PASS");
  });
  it("额外键不影响严格判定", () => {
    const withExtra = { ...strictBindings, nullableScriptTrace: ["crafted"] };
    expect(assessFormalShard(shardFixture({ bindings: withExtra }), environment).admission).toBe(
      "REAL_PASS",
    );
  });
  it("合成目标上声明 REAL_PASS 被拒", () => {
    const assessment = assessFormalShard(
      shardFixture({ formalTargetSynthetic: true, formalVerdict: "REAL_PASS" }),
      environment,
    );
    expect(assessment.admission).toBe("UNADJUDICATED");
    expect(assessment.reasons).toContain("PHASE2_ROUTE_FAKE_PASS_REJECTED");
  });
  it("分片提交不匹配 → SHARD_COMMIT_MISMATCH", () => {
    const assessment = assessFormalShard(
      shardFixture({ headCommit: "0".repeat(40) }),
      environment,
    );
    expect(assessment.admission).toBe("UNADJUDICATED");
    expect(assessment.reasons).toContain("PHASE2_ROUTE_SHARD_COMMIT_MISMATCH");
  });
  it("绑定不全 → BINDING_NOT_STRICT 且永不 REAL_PASS", () => {
    const broken = { ...strictBindings };
    delete broken.codeInventoryEntryCount;
    const assessment = assessFormalShard(shardFixture({ bindings: broken }), environment);
    expect(assessment.admission).toBe("UNADJUDICATED");
    expect(assessment.reasons).toContain("PHASE2_ROUTE_SHARD_BINDING_NOT_STRICT");
  });
  it("runner 退出非 0 时 REAL_PASS 不成立", () => {
    const assessment = assessFormalShard(shardFixture({}), {
      headCommit: "f".repeat(40),
      runnerExitCode: 1,
    });
    expect(assessment.admission).toBe("UNADJUDICATED");
    expect(assessment.reasons).toContain("FORMAL_REAL_PASS_NO_RUNNER_EXIT_ZERO");
  });
  it("formalExitCode 缺失/非零都不得通过", () => {
    const missing = assessFormalShard(
      shardFixture({ formalExitCode: undefined }),
      environment,
    );
    expect(missing.admission).toBe("UNADJUDICATED");
    expect(missing.reasons).toContain("FORMAL_SHARD_NO_EXIT_CODE");
    const nonzero = assessFormalShard(shardFixture({ formalExitCode: 1 }), environment);
    expect(nonzero.admission).toBe("UNADJUDICATED");
    expect(nonzero.reasons).toContain("FORMAL_SHARD_EXIT_NONZERO");
  });
  it("旧版 verdict 一律拒绝", () => {
    expect(
      assessFormalShard(shardFixture({ formalVerdict: "PASS" }), environment).reasons,
    ).toContain("PHASE2_ROUTE_FAKE_PASS_REJECTED");
    const notAuthorized = assessFormalShard(
      shardFixture({ formalVerdict: "NOT_AUTHORIZED" }),
      environment,
    );
    expect(notAuthorized.admission).toBe("UNADJUDICATED");
    expect(notAuthorized.reasons).toContain("PHASE2_ROUTE_NOT_AUTHORIZED");
  });
  it("合成路线完整 → SYNTHETIC_READINESS；非合成目标冒名被拒", () => {
    const synthetic = assessFormalShard(
      shardFixture({
        formalTargetSynthetic: true,
        formalVerdict: "SYNTHETIC_READINESS",
      }),
      environment,
    );
    expect(synthetic.admission).toBe("SYNTHETIC_READINESS");
    const forged = assessFormalShard(
      shardFixture({ formalVerdict: "SYNTHETIC_READINESS" }),
      environment,
    );
    expect(forged.admission).toBe("UNADJUDICATED");
    expect(forged.reasons).toContain("PHASE2_ROUTE_FAILED_UNADJUDICATED");
  });
  it("route 非 formal → SHARD_UNRECOGNIZED", () => {
    const assessment = assessFormalShard(
      shardFixture({ route: "migration" }),
      environment,
    );
    expect(assessment.admission).toBe("UNADJUDICATED");
    expect(assessment.reasons).toContain("PHASE2_ROUTE_SHARD_UNRECOGNIZED");
  });
  it("分片对象缺失 → SHARD_MISSING", () => {
    expect(assessFormalShard(null, environment).reasons).toContain(
      "PHASE2_ROUTE_SHARD_MISSING",
    );
  });
});

describe("postRunDirtyReasons（Gate 9 运行时卫生）", () => {
  it("干净且提交未移动时无原因", () => {
    const result = postRunDirtyReasons({
      headBefore: "f".repeat(40),
      headAfter: "f".repeat(40),
      statusOutput: "",
    });
    expect(result).toEqual({ reasons: [], dirtyCount: 0 });
  });
  it("有未提交内容 → POST_RUN_TREE_NOT_CLEAN 与行数", () => {
    const result = postRunDirtyReasons({
      headBefore: "f".repeat(40),
      headAfter: "f".repeat(40),
      statusOutput: " M apps/api/scripts/phase2-acceptance.mjs\n?? new-file.txt\n",
    });
    expect(result.reasons).toEqual(["POST_RUN_TREE_NOT_CLEAN"]);
    expect(result.dirtyCount).toBe(2);
  });
  it("运行期间提交被改动 → POST_RUN_HEAD_MOVED", () => {
    const result = postRunDirtyReasons({
      headBefore: "f".repeat(40),
      headAfter: "e".repeat(40),
      statusOutput: "",
    });
    expect(result.reasons).toEqual(["POST_RUN_HEAD_MOVED"]);
  });
  it("非字符串输入一律按未提供处理，绝不崩溃", () => {
    const result = postRunDirtyReasons({ headBefore: 42, headAfter: null, statusOutput: {} });
    expect(result.reasons).toEqual([]);
    expect(result.dirtyCount).toBe(0);
  });
});

describe("gitMetadataHidingReasons（Gate 9 元数据掩盖探测）", () => {
  it("全空/干净时无原因", () => {
    expect(gitMetadataHidingReasons({})).toEqual({ reasons: [], hiding: false });
  });
  it("ls-files -v 含小写 h（assume-unchanged）即检出", () => {
    const r = gitMetadataHidingReasons({ lsFilesVerbose: "H file1\nh file2\n" });
    expect(r.hiding).toBe(true);
    expect(r.reasons).toContain("GIT_LS_FILES_ASSUMUNCHANGED_OR_SKIPWORKTREE");
    expect(r.reasons).toContain("POST_RUN_GIT_METADATA_HIDING");
  });
  it("ls-files -v 含大写 S（skip-worktree）即检出", () => {
    const r = gitMetadataHidingReasons({ lsFilesVerbose: "H file1\nS file2\n" });
    expect(r.hiding).toBe(true);
    expect(r.reasons).toContain("GIT_LS_FILES_ASSUMUNCHANGED_OR_SKIPWORKTREE");
  });
  it("ls-files -v 全大写 H/M 标记不算掩盖（S 是 skip-worktree 仍算）", () => {
    const r = gitMetadataHidingReasons({ lsFilesVerbose: "H file1\nM file3\n" });
    expect(r.hiding).toBe(false);
    expect(r.reasons).toEqual([]);
  });
  it("core.excludesFile 字节哈希变化即检出", () => {
    const r = gitMetadataHidingReasons({ excludesFileHashChanged: true });
    expect(r.hiding).toBe(true);
    expect(r.reasons).toContain("GIT_CORE_EXCLUDES_FILE_CHANGED");
    expect(r.reasons).toContain("POST_RUN_GIT_METADATA_HIDING");
  });
  it("info/exclude 字节哈希变化即检出", () => {
    const r = gitMetadataHidingReasons({ infoExcludeHashChanged: true });
    expect(r.hiding).toBe(true);
    expect(r.reasons).toContain("GIT_INFO_EXCLUDE_CHANGED");
  });
  it("info/exclude 字节哈希未变不算掩盖", () => {
    const r = gitMetadataHidingReasons({ infoExcludeHashChanged: false });
    expect(r.hiding).toBe(false);
    expect(r.reasons).toEqual([]);
  });
  it("core.excludesFile 字节哈希未变不算掩盖", () => {
    const r = gitMetadataHidingReasons({ excludesFileHashChanged: false });
    expect(r.hiding).toBe(false);
    expect(r.reasons).toEqual([]);
  });
  it("sparse-checkout 启用即检出", () => {
    const r = gitMetadataHidingReasons({ sparseCheckout: true });
    expect(r.hiding).toBe(true);
    expect(r.reasons).toContain("GIT_SPARSE_CHECKOUT_ENABLED");
  });
  it("sparse-checkout 文件存在即检出", () => {
    const r = gitMetadataHidingReasons({ sparseCheckoutFilePresent: true });
    expect(r.hiding).toBe(true);
    expect(r.reasons).toContain("GIT_SPARSE_CHECKOUT_FILE_PRESENT");
  });
  it("多种掩盖同时出现，原因全记录", () => {
    const r = gitMetadataHidingReasons({
      lsFilesVerbose: "h f1\n",
      excludesFileHashChanged: true,
      infoExcludeHashChanged: true,
      sparseCheckout: true,
      sparseCheckoutFilePresent: true,
    });
    expect(r.hiding).toBe(true);
    expect(r.reasons).toContain("GIT_LS_FILES_ASSUMUNCHANGED_OR_SKIPWORKTREE");
    expect(r.reasons).toContain("GIT_CORE_EXCLUDES_FILE_CHANGED");
    expect(r.reasons).toContain("GIT_INFO_EXCLUDE_CHANGED");
    expect(r.reasons).toContain("GIT_SPARSE_CHECKOUT_ENABLED");
    expect(r.reasons).toContain("GIT_SPARSE_CHECKOUT_FILE_PRESENT");
    expect(r.reasons).toContain("POST_RUN_GIT_METADATA_HIDING");
  });
  it("非对象输入安全返回无原因", () => {
    expect(gitMetadataHidingReasons(null)).toEqual({ reasons: [], hiding: false });
    expect(gitMetadataHidingReasons(42)).toEqual({ reasons: [], hiding: false });
  });
  it("postRunDirtyReasons 集成 metadata 字段", () => {
    const r = postRunDirtyReasons({
      headBefore: "f".repeat(40),
      headAfter: "f".repeat(40),
      statusOutput: "",
      metadata: { lsFilesVerbose: "h f1\n" },
    });
    expect(r.reasons).toContain("POST_RUN_GIT_METADATA_HIDING");
    expect(r.dirtyCount).toBe(0);
  });
});

describe("finalizeStatus：元数据掩盖硬失败", () => {
  it("POST_RUN_GIT_METADATA_HIDING 把 IMPLEMENTATION_READY 压为 INCONCLUSIVE", () => {
    expect(
      finalizeStatus({ candidate: "IMPLEMENTATION_READY", reasonCodes: ["POST_RUN_GIT_METADATA_HIDING"] }),
    ).toBe("INCONCLUSIVE");
  });
  it("POST_RUN_GIT_METADATA_HIDING 把 PASS 压为 INCONCLUSIVE", () => {
    expect(
      finalizeStatus({ candidate: "PASS", reasonCodes: ["POST_RUN_GIT_METADATA_HIDING"] }),
    ).toBe("INCONCLUSIVE");
  });
});