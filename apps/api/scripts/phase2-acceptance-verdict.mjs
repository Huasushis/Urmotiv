/**
 * 共享验收判定模块（纯函数，无副作用）：
 * 依据 tests/history-phase2-runner-postgres.test.ts 写入的
 * shard-runner.private.json 结构判定正式路线分片，并输出
 * scripts/phase2-acceptance.mjs 门槛检查所需的启用标记。
 *
 * 宁缺毋滥（fail-closed）：任何字段缺失、类型不符或内容不合格
 * 都降为 UNADJUDICATED，绝不输出 REAL_PASS / SYNTHETIC_READINESS。
 */

export const BINDING_KEYS = [
  "batchSha256",
  "manifestIdentitySha256",
  "manifestContentBindingsSha256",
  "codeInventorySha256",
  "codeInventoryEntryCount",
];

/**
 * 绑定字段严格盘点：缺失、null/undefined、非字符串分别记录。
 * 五项任一不满足即严格不通过（strictOk=false）。
 * @returns {{structureBroken: boolean, missing: string[], nulled: string[],
 *            nonString: string[], strictOk: boolean}}
 */
export function assessFormalShardBindings(bindings) {
  const assessment = {
    structureBroken: false,
    missing: [],
    nulled: [],
    nonString: [],
    strictOk: false,
  };
  if (typeof bindings !== "object" || bindings === null || Array.isArray(bindings)) {
    assessment.structureBroken = true;
    return assessment;
  }
  for (const key of BINDING_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(bindings, key)) {
      assessment.missing.push(key);
      continue;
    }
    const value = bindings[key];
    if (value === null || value === undefined) {
      assessment.nulled.push(key);
      continue;
    }
    if (typeof value !== "string") {
      assessment.nonString.push(key);
    }
  }
  assessment.strictOk =
    assessment.missing.length === 0 &&
    assessment.nulled.length === 0 &&
    assessment.nonString.length === 0;
  return assessment;
}

/**
 * 正式路线分片判定。admission 取值：
 *  - REAL_PASS：真实目标 + 0 退出 + 0 runner 退出 + 分片提交一致 + 绑定严格；
 *  - SYNTHETIC_READINESS：合成目标且分片提交一致 + 绑定严格；
 *  - UNADJUDICATED：其余一切情况（含字段缺失）。
 * 返回的 reasons 只含代码，不含任何私有内容。
 * @returns {{admission: "REAL_PASS"|"SYNTHETIC_READINESS"|"UNADJUDICATED", reasons: string[]}}
 */
export function assessFormalShard(shard, environment) {
  if (typeof shard !== "object" || shard === null || Array.isArray(shard)) {
    return { admission: "UNADJUDICATED", reasons: ["PHASE2_ROUTE_SHARD_MISSING"] };
  }
  const headCommit =
    typeof environment === "object" && environment !== null ? environment.headCommit : undefined;
  const runnerExitCode =
    typeof environment === "object" && environment !== null ? environment.runnerExitCode : undefined;
  const reasons = [];

  const routeRecognized = typeof shard.route === "string" && shard.route === "formal";
  if (!routeRecognized) {
    reasons.push("PHASE2_ROUTE_SHARD_UNRECOGNIZED");
  }
  if (typeof shard.headCommit !== "string") {
    reasons.push("PHASE2_ROUTE_SHARD_COMMIT_MISSING");
  } else if (typeof headCommit !== "string" || shard.headCommit !== headCommit) {
    reasons.push("PHASE2_ROUTE_SHARD_COMMIT_MISMATCH");
  }
  const bindingAssessment = assessFormalShardBindings(shard.bindings);
  if (!bindingAssessment.strictOk) {
    reasons.push("PHASE2_ROUTE_SHARD_BINDING_NOT_STRICT");
  }
  if (typeof shard.formalExitCode !== "number") {
    reasons.push("FORMAL_SHARD_NO_EXIT_CODE");
  } else if (shard.formalExitCode !== 0) {
    reasons.push("FORMAL_SHARD_EXIT_NONZERO");
  }

  const commitMatch = typeof headCommit === "string" && shard.headCommit === headCommit;
  const synthetic = shard.formalTargetSynthetic === true;

  if (shard.formalVerdict === "REAL_PASS") {
    if (synthetic) {
      reasons.push("PHASE2_ROUTE_FAKE_PASS_REJECTED");
      return { admission: "UNADJUDICATED", reasons };
    }
    const complete =
      routeRecognized &&
      commitMatch &&
      bindingAssessment.strictOk &&
      shard.formalExitCode === 0 &&
      runnerExitCode === 0;
    if (runnerExitCode !== 0) {
      reasons.push("FORMAL_REAL_PASS_NO_RUNNER_EXIT_ZERO");
    }
    return { admission: complete ? "REAL_PASS" : "UNADJUDICATED", reasons };
  }
  if (shard.formalVerdict === "SYNTHETIC_READINESS") {
    if (!synthetic) {
      reasons.push("PHASE2_ROUTE_FAILED_UNADJUDICATED");
      return { admission: "UNADJUDICATED", reasons };
    }
    return {
      admission:
        routeRecognized && commitMatch && bindingAssessment.strictOk
          ? "SYNTHETIC_READINESS"
          : "UNADJUDICATED",
      reasons,
    };
  }
  if (shard.formalVerdict === "NOT_AUTHORIZED") {
    reasons.push("PHASE2_ROUTE_NOT_AUTHORIZED");
    return { admission: "UNADJUDICATED", reasons };
  }
  if (shard.formalVerdict === "PASS") {
    reasons.push("PHASE2_ROUTE_FAKE_PASS_REJECTED");
    return { admission: "UNADJUDICATED", reasons };
  }
  reasons.push("PHASE2_ROUTE_FAILED_UNADJUDICATED");
  return { admission: "UNADJUDICATED", reasons };
}