// Gate 9 专用验收后置突变夹具（独立子进程脚本）：
// 由 apps/api/scripts/phase2-acceptance.mjs 的测试缝
// URMOTIV_PHASE2_ACCEPTANCE_TEST_AFTER_CHILD_RUNS 以独立进程执行，
// 在验收路由子进程结束后、运行后整树卫生判定之前注入受控突变。
// 生产验收运行绝不加载该脚本；任何缝激活的运行都已强制非权威。
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(fixtureDirectory, "..", "..", "..");

const mode = process.env.URMOTIV_PHASE2_ACCEPTANCE_HOOK_MODE;
if (mode === "clean") {
  // 不注入任何突变：专门验证没有任何突变的缝激活运行也照样非权威。
  process.exit(0);
}
if (mode === "dirty") {
  writeFileSync(
    join(repositoryRoot, "apps", "api", "POST_RUN_MUTATION.untracked"),
    "synthetic-post-run-dirty\n",
  );
  process.exit(0);
}
if (mode === "head-move") {
  execFileSync("git", ["checkout", "--quiet", "--detach", "HEAD^"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  process.exit(0);
}
console.error(`URMOTIV_PHASE2_ACCEPTANCE_HOOK_MODE 未知: ${mode ?? "(未设置)"}`);
process.exit(2);