// Phase-2 PostgreSQL 验收运行器：验收只能发生在干净的已提交检出上。
// 它自己解析当前 HEAD 并强制整树干净，然后带着两个验收门环境变量运行
// tests/history-phase2-runner-postgres.test.ts。任何未提交修改（包括对验收
// 脚本或测试自身的修改）都会在启动前被拒绝，避免削弱验收门。
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const scriptDirectory = fileURLToPath(new URL(".", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const apiDirectory = fileURLToPath(new URL("..", import.meta.url));
const acceptanceTestFile = "tests/history-phase2-runner-postgres.test.ts";

function fail(message) {
  console.error(`phase2-acceptance: ${message}`);
  process.exit(2);
}

const head = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim();
if (!/^[0-9a-f]{40}$/.test(head)) {
  fail(`HEAD 不是完整提交摘要: ${head}`);
}
const status = execFileSync(
  "git",
  ["status", "--porcelain=v1", "--untracked-files=all"],
  { cwd: repositoryRoot, encoding: "utf8" },
);
if (status.trim().length !== 0) {
  fail("整树必须干净且全部内容已提交；拒绝在未提交检出上发放验收。");
}
if (
  process.env.URMOTIV_TEST_POSTGRES_ADMIN_URL === undefined ||
  process.env.URMOTIV_TEST_POSTGRES_ADMIN_URL.trim().length === 0
) {
  fail("缺少 URMOTIV_TEST_POSTGRES_ADMIN_URL 管理连接。");
}
console.log(`phase2-acceptance: HEAD=${head}`);
const result = spawnSync(
  process.execPath,
  [join(repositoryRoot, "node_modules", "vitest", "vitest.mjs"), "run", acceptanceTestFile],
  {
    cwd: apiDirectory,
    stdio: "inherit",
    env: {
      ...process.env,
      URMOTIV_PHASE2_RUNNER_ACCEPTANCE: "1",
      URMOTIV_PHASE2_ACCEPTANCE_COMMIT: head,
    },
  },
);
process.exit(result.status ?? 1);