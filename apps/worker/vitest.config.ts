import { defineConfig } from "vitest/config";

/**
 * 与 apps/api 相同的约定：这些测试大量使用文件版 PostgreSQL（PGlite），
 * 一个测试文件常常打开多个数据库实例。不限制并行时服务器 CPU/内存会被占满，
 * 慢下来的用例会超过默认 5 秒而偶发失败，受限分配下整组分叉会挤占内存导致卡死。
 * Gate1 验收按单工作线程串行执行，这里收紧并行并放宽单个用例的时间上限。
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    maxWorkers: 1,
    fileParallelism: false
  }
});
