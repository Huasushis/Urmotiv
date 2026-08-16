/**
 * Phase-2 验收数据库生命周期登记册——全局类型声明。
 * 让 .ts 测试文件能从 .mjs 模块导入，同时保持严格类型检查。
 * 实现见 phase2-database-lifecycle.mjs。
 */

declare module "*.mjs" {
  export function isValidDatabaseName(name: unknown): boolean;
  export function quoteIdentifier(name: string): string;
  export function createLifecycleContext(): {
    directory: string;
    keyPath: string;
    registryPath: string;
  };
  export function registerOwnedDatabase(lifecycleDir: string, name: string): void;
  export function readOwnedDatabaseNames(lifecycleDir: string): string[];
  export function removeLifecycleContext(lifecycleDir: string): void;
  export function preserveLifecycleContext(lifecycleDir: string): void;
  export function verifyLifecycleIntegrity(lifecycleDir: string): boolean;
}
