import { describe, expect, it } from "vitest";
import {
  BINDING_KEYS,
  assessFormalShard,
  assessFormalShardBindings,
} from "../scripts/phase2-acceptance-verdict.mjs";

const strictBindings = Object.fromEntries(
  BINDING_KEYS.map((key, index) => [key, `value-${index}`.padStart(64, "a")]),
);

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
  it("严格绑定全部为字符串时通过", () => {
    expect(assessFormalShardBindings(strictBindings).strictOk).toBe(true);
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