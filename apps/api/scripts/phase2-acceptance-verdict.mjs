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

/** 各绑定键的合法运行时类型：摘要必须是字符串，条目计数必须是数字。 */
const BINDING_KINDS = new Map([
  ["codeInventoryEntryCount", "number"],
  ["batchSha256", "string"],
  ["manifestIdentitySha256", "string"],
  ["manifestContentBindingsSha256", "string"],
  ["codeInventorySha256", "string"],
]);

/**
 * @returns {"string"|"number"|null} 键的期望类型；未知键返回 null。
 */
export function expectedBindingKind(key) {
  return BINDING_KINDS.get(key) ?? null;
}

/**
 * 绑定字段严格盘点：缺失、null/undefined、类型不符分别记录。
 * 五项任一不满足即严格不通过（strictOk=false）。
 * @returns {{structureBroken: boolean, missing: string[], nulled: string[],
 *            nonString: string[], wrongKind: string[], strictOk: boolean}}
 */
export function assessFormalShardBindings(bindings) {
  const assessment = {
    structureBroken: false,
    missing: [],
    nulled: [],
    nonString: [],
    wrongKind: [],
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
    if (typeof value !== expectedBindingKind(key)) {
      assessment.wrongKind.push(key);
    }
  }
  assessment.strictOk =
    assessment.missing.length === 0 &&
    assessment.nulled.length === 0 &&
    assessment.wrongKind.length === 0;
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

/**
 * Gate 9 元数据掩盖检测（纯函数）：Git 的 porcelain status 只反映暂存/未暂存
 * 改动，无法识破靠元数据隐藏的检出突变——已跟踪文件的 assume-unchanged /
 * skip-worktree 会让已修改文件在 status 中隐形；.git/info/exclude 与
 * core.excludesFile 能隐藏未跟踪文件；sparse-checkout 配置与 worktree 局部
 * 元数据也可掩盖内容。这些都不出现在 porcelain 行中，必须逐项探测。
 *
 * 排除文件用字节哈希前后差比对：运行前冻结哈希，运行后逐字节比对，任何
 * 字节变化即报掩盖。比布尔 delta 更强——不受「已有非空文件再添一行」
 * 的遮蔽，也不依赖布尔语义（非空 vs 空）。预存的合法排除规则被冻结，
 * 运行中新增/修改/删除排除规则一定被检出。
 *
 * ls-files -v 的 assume-unchanged(h)/skip-worktree(s) 与 sparse-checkout
 * 是绝对非法的（预运行已拒，运行中出现即为掩盖突变），不做前后差比对。
 *
 * 本函数只接收探测命令的原始 stdout 与哈希差布尔值，不执行任何 git 命令
 * （纯函数，可单元测试），绝不输出路径或内容。
 * @param {{
 *   lsFilesVerbose?: unknown,
 *   excludesFileHashChanged?: unknown,
 *   infoExcludeHashChanged?: unknown,
 *   ignoredFilesHashChanged?: unknown,
 *   sparseCheckout?: unknown,
 *   sparseCheckoutFilePresent?: unknown,
 * }} environment
 * @returns {{reasons: string[], hiding: boolean}}
 */
export function gitMetadataHidingReasons(environment) {
  const env =
    typeof environment === "object" && environment !== null ? environment : {};
  const reasons = [];
  let hiding = false;
  // git ls-files -v：h(assume-unchanged)/S(skip-worktree) 表示已跟踪文件
  // 被元数据标记隐藏。大写 H 是正常缓存状态。绝对非法。
  // Fix C2：lsFilesVerbose 为 READ_ERROR_SENTINEL 时显式判为掩盖——
  // 读取失败不是合法状态，相同哨兵前后不能通过。
  const lsFilesVerbose = env.lsFilesVerbose;
  if (lsFilesVerbose === "READ_ERROR_SENTINEL") {
    reasons.push("GIT_LS_FILES_READ_ERROR_SENTINEL");
    hiding = true;
  } else if (typeof lsFilesVerbose === "string" && lsFilesVerbose.trim().length !== 0) {
    for (const line of lsFilesVerbose.split("\n")) {
      const tag = line.charAt(0);
      if (tag === "h" || tag === "S") {
        reasons.push("GIT_LS_FILES_ASSUMUNCHANGED_OR_SKIPWORKTREE");
        hiding = true;
        break;
      }
    }
  }
  // core.excludesFile 字节哈希变化：运行中修改了排除文件内容。
  const excludesFileHashChanged = env.excludesFileHashChanged;
  if (excludesFileHashChanged === true) {
    reasons.push("GIT_CORE_EXCLUDES_FILE_CHANGED");
    hiding = true;
  }
  // .git/info/exclude 字节哈希变化：运行中修改了 info/exclude 内容。
  const infoExcludeHashChanged = env.infoExcludeHashChanged;
  if (infoExcludeHashChanged === true) {
    reasons.push("GIT_INFO_EXCLUDE_CHANGED");
    hiding = true;
  }
  // 被忽略文件集哈希变化：预存排除规则被用来隐藏运行中新增的未跟踪
  // 工件（排除规则字节未变，但被忽略的文件集变了）。
  const ignoredFilesHashChanged = env.ignoredFilesHashChanged;
  if (ignoredFilesHashChanged === true) {
    reasons.push("GIT_IGNORED_FILES_SET_CHANGED");
    hiding = true;
  }
  // core.sparseCheckout=true 或 .git/info/sparse-checkout 存在：稀疏检出
  // 可掩盖整片目录内容。绝对非法（预运行已拒）。
  const sparseCheckout = env.sparseCheckout;
  if (sparseCheckout === true || sparseCheckout === "true") {
    reasons.push("GIT_SPARSE_CHECKOUT_ENABLED");
    hiding = true;
  }
  const sparseCheckoutFilePresent = env.sparseCheckoutFilePresent;
  if (sparseCheckoutFilePresent === true) {
    reasons.push("GIT_SPARSE_CHECKOUT_FILE_PRESENT");
    hiding = true;
  }
  if (hiding) {
    reasons.push("POST_RUN_GIT_METADATA_HIDING");
  }
  return { reasons, hiding };
}

/**
 * 验收运行结束后的整树卫生判定（Gate 9）：只比较提交摘要与暂存/未暂存
 * 行数，不输出任何路径或内容。验收本身不得改变检出。元数据掩盖检测
 * （gitMetadataHidingReasons）的结果并入此处统一上报。
 * @param {{headBefore: unknown, headAfter: unknown, statusOutput: unknown,
 *          metadata?: {lsFilesVerbose?: unknown, excludesFile?: unknown,
 *           infoExcludeNonEmpty?: unknown, sparseCheckout?: unknown,
 *           sparseCheckoutFilePresent?: unknown}}} environment
 * @returns {{reasons: string[], dirtyCount: number}}
 */
export function postRunDirtyReasons(environment) {
  const env =
    typeof environment === "object" && environment !== null ? environment : {};
  const headBefore = env.headBefore;
  const headAfter = env.headAfter;
  const statusOutput = env.statusOutput;
  const reasons = [];
  if (typeof headBefore === "string" && typeof headAfter === "string" && headAfter !== headBefore) {
    reasons.push("POST_RUN_HEAD_MOVED");
  }
  const dirtyCount =
    typeof statusOutput === "string"
      ? statusOutput.split("\n").filter((line) => line.trim().length > 0).length
      : 0;
  if (dirtyCount > 0) {
    reasons.push("POST_RUN_TREE_NOT_CLEAN");
  }
  if (typeof env.metadata === "object" && env.metadata !== null) {
    const meta = gitMetadataHidingReasons(env.metadata);
    reasons.push(...meta.reasons);
  }
  return { reasons, dirtyCount };
}

/**
 * 运行后整树突变编码：验收运行自己绝不能移动 HEAD 或弄脏检出。
 * 这些编码对任何本可成功（PASS / IMPLEMENTATION_READY）的候选定级
 * 都是硬失败，必须压为 INCONCLUSIVE 并以非零退出码结束。
 */
export const POST_RUN_MUTATION_CODES = [
  "POST_RUN_HEAD_MOVED",
  "POST_RUN_TREE_NOT_CLEAN",
  "POST_RUN_GIT_METADATA_HIDING",
];

/**
 * 终判定级（纯函数）：把运行后整树突变硬失败套用到所有成功候选。
 * 非成功候选（INCONCLUSIVE）保持原样。
 * @param {{candidate: unknown, reasonCodes: unknown}} environment
 * @returns {unknown} 最终 evidence.status。
 */
export function finalizeStatus(environment) {
  const candidate =
    typeof environment === "object" && environment !== null ? environment.candidate : undefined;
  const reasonCodes =
    typeof environment === "object" && environment !== null ? environment.reasonCodes : undefined;
  const codes = new Set(Array.isArray(reasonCodes) ? reasonCodes : []);
  if (candidate !== "PASS" && candidate !== "IMPLEMENTATION_READY") {
    return candidate;
  }
  if (POST_RUN_MUTATION_CODES.some((code) => codes.has(code))) {
    return "INCONCLUSIVE";
  }
  return candidate;
}