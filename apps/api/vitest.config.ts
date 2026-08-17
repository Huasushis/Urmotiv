import { defineConfig } from "vitest/config";

/**
 * 这些测试大量使用文件版 PostgreSQL（PGlite），一个测试文件常常打开多个数据库实例。
 * 不限制并行时服务器 CPU 会被占满，慢下来的用例会超过默认 5 秒而偶发失败，
 * 因此这里收紧并行数量并放宽单个用例的时间上限。
 *
 * Vitest 4.1.10 移除了 poolOptions.forks.maxForks，改用顶层 maxWorkers 与
 * fileParallelism=false（不并行文件）。显式限制 worker 数，避免按 CPU 核数
 * 并行导致 OOM——本项目在 maxForks 被静默忽略后又发生过一次 OOM。
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    maxWorkers: 2,
    fileParallelism: false,
  }
});
