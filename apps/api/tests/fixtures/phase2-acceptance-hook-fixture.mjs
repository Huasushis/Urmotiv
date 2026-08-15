// Gate 9 专用验收后置突变夹具（独立子进程脚本）：
// 由 apps/api/scripts/phase2-acceptance.mjs 的测试缝
// URMOTIV_PHASE2_ACCEPTANCE_TEST_AFTER_CHILD_RUNS 以独立进程执行，
// 在验收路由子进程结束后、运行后整树卫生判定之前注入受控突变。
// 生产验收运行绝不加载该脚本；任何缝激活的运行都已强制非权威。
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(fixtureDirectory, "..", "..", "..", "..");

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
if (mode === "skip-worktree") {
  // 元数据掩盖缝：修改一个已跟踪文件后立即设 skip-worktree，
  // 让 porcelain status 对该改动隐形。这是不经任何代码缝、仅靠 Git
  // 元数据合成的「干净假象」，必须被验收元数据探测识破。
  const target = join(repositoryRoot, "apps", "api", "package.json");
  const original = readFileSync(target, "utf8");
  writeFileSync(target, `${original}\n# gate9-skip-worktree-mutation\n`);
  execFileSync("git", ["update-index", "--skip-worktree", target], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  process.exit(0);
}
if (mode === "assume-unchanged") {
  // 元数据掩盖缝：修改一个已跟踪文件后设 assume-unchanged，
  // 同样让 porcelain 对改动隐形。
  const target = join(repositoryRoot, "apps", "api", "tsconfig.json");
  const original = readFileSync(target, "utf8");
  writeFileSync(target, `${original}\n// gate9-assume-unchanged-mutation\n`);
  execFileSync("git", ["update-index", "--assume-unchanged", target], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  process.exit(0);
}
if (mode === "info-exclude") {
  // 元数据掩盖缝：创建一个未跟踪文件，再在 .git/info/exclude 里加
  // 排除规则隐藏它。porcelain 不会显示该未跟踪文件。
  writeFileSync(
    join(repositoryRoot, "apps", "api", "GATE9_HIDDEN.untracked"),
    "synthetic-info-exclude-mutation\n",
  );
  const excludePath = join(repositoryRoot, ".git", "info", "exclude");
  const existing = readFileSync(excludePath, "utf8");
  writeFileSync(excludePath, `${existing}apps/api/GATE9_HIDDEN.untracked\n`);
  process.exit(0);
}
process.exit(2);