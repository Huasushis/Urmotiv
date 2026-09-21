import { defineConfig } from 'vitest/config';

// PGlite 每个进程需要独立的 WASM 内存，避免测试默认按 CPU 数启动多个数据库。
export default defineConfig({
  test: { maxWorkers: 1, fileParallelism: false, testTimeout: 30_000, hookTimeout: 30_000 }
});
