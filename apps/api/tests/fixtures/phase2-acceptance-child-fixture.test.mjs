// Gate 9 专用验收路由夹具（vitest 测试文件）：
// 由 apps/api/scripts/phase2-acceptance.mjs 的测试缝
// URMOTIV_PHASE2_ACCEPTANCE_TEST_CHILD_FIXTURE 显式指定后作为路由测试运行，
// 向操作员证据目录写入一条结构严格的 shard-runner.private.json。
// 生产验收运行绝不使用该文件；未提供指定环境变量时整个套件跳过，
// 避免全 API 工作区收集中把它当作真实失败。
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const fixtureEnabled =
  typeof process.env.URMOTIV_PHASE2_ACCEPTANCE_DIR === "string" &&
  typeof process.env.URMOTIV_PHASE2_ACCEPTANCE_COMMIT === "string" &&
  typeof process.env.URMOTIV_PHASE2_CHILD_FIXTURE_VERDICT === "string";

function sha256Hex(content) {
  return createHash("sha256").update(content).digest("hex");
}

describe.skipIf(!fixtureEnabled)("Gate 9 验收路线分片夹具", () => {
  test("fixture 写入验收路线分片", () => {
    const directory = process.env.URMOTIV_PHASE2_ACCEPTANCE_DIR;
    const commit = process.env.URMOTIV_PHASE2_ACCEPTANCE_COMMIT;
    expect(directory).toBeTypeOf("string");
    expect(commit).toBeTypeOf("string");
    mkdirSync(directory, { recursive: true });
    const verdict =
      process.env.URMOTIV_PHASE2_CHILD_FIXTURE_VERDICT === "REAL_PASS"
        ? "REAL_PASS"
        : "SYNTHETIC_READINESS";
    const synthetic = verdict === "SYNTHETIC_READINESS";
    const nonce = String(Date.now());
    const shard = {
      route: "formal",
      headCommit: commit,
      formalExitCode: 0,
      formalTargetSynthetic: synthetic,
      formalVerdict: verdict,
      bindings: {
        batchSha256: sha256Hex(`fixture-batch|${nonce}`),
        manifestIdentitySha256: sha256Hex(`fixture-manifest|${nonce}`),
        manifestContentBindingsSha256: sha256Hex(`fixture-bindings|${nonce}`),
        codeInventorySha256: sha256Hex(`fixture-inventory|${nonce}`),
        codeInventoryEntryCount: 7,
      },
    };
    writeFileSync(join(directory, "shard-runner.private.json"), `${JSON.stringify(shard, null, 2)}\n`);
  });
});