// Gate 9 专用验收后置突变夹具：
// 由 apps/api/scripts/phase2-acceptance.mjs 的测试缝
// URMOTIV_PHASE2_ACCEPTANCE_TEST_AFTER_CHILD_RUNS 显式加载，
// 在验收路由子进程结束之后、运行后整树卫生判定之前注入受控突变。
// 生产验收运行绝不加载该模块。
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export async function inject({ repositoryRoot }) {
  const mode = process.env.URMOTIV_PHASE2_ACCEPTANCE_HOOK_MODE;
  if (mode === "dirty") {
    writeFileSync(
      join(repositoryRoot, "apps", "api", "POST_RUN_MUTATION.untracked"),
      "synthetic-post-run-dirty\n",
    );
    return;
  }
  if (mode === "head-move") {
    execFileSync("git", ["checkout", "--quiet", "--detach", "HEAD^"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return;
  }
  throw new Error(`URMOTIV_PHASE2_ACCEPTANCE_HOOK_MODE 未知: ${mode ?? "(未设置)"}`);
}