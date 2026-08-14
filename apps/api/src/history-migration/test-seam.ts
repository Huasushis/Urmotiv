/**
 * 测试缝门禁：只有 Vitest 运行时才能接到 hook/故障注入参数；
 * 并且目标必须是回环地址上的临时/合成命名范围，正式生产目标一概拒绝。
 * 正式 CLI、tsx 脚本与编译产物运行时都无法通过本门禁，因此
 * 测试缝不能成为绕过正式导入授权的通道。
 */
import { HistoryMigrationError } from "./errors";
import { scratchDatabaseNamePattern } from "./phase2-postcheck";

const syntheticFormalDatabaseNamePattern = /^urmotiv_formal_[a-z0-9_]{1,40}$/;

/** Vitest 设置 VITEST=true；普通启动没有该变量。 */
export function assertTestSeamRuntime(env: NodeJS.ProcessEnv): void {
  if (env.VITEST !== "true") {
    throw new HistoryMigrationError(
      "INVALID_ARGUMENTS",
      "测试缝不可用：当前运行时不是本仓库的测试运行时。",
    );
  }
}

function isLoopbackHost(host: string | undefined): boolean {
  return (
    host === undefined ||
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === "::1"
  );
}

/** 临时/验收 runner 的注入缝：回环 + 临时命名范围；第 2 阶段本身另禁止真实目标类。 */
export function assertScratchSeamAllowed(
  env: NodeJS.ProcessEnv,
  target: {
    readonly host: string | undefined;
    readonly databaseName: string;
  },
): void {
  assertTestSeamRuntime(env);
  if (!isLoopbackHost(target.host)) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "测试缝只允许回环地址上的临时目标。");
  }
  if (!scratchDatabaseNamePattern.test(target.databaseName)) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "测试缝只允许临时/验收命名范围。");
  }
}

/** 正式导入的注入缝：回环 + 合成正式命名范围；任何真实生产目标都被机械拒绝。 */
export function assertSyntheticFormalSeamAllowed(
  env: NodeJS.ProcessEnv,
  target: {
    readonly host: string | undefined;
    readonly databaseName: string;
  },
): void {
  assertTestSeamRuntime(env);
  if (!isLoopbackHost(target.host)) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "测试缝只允许回环地址上的合成目标。");
  }
  if (!syntheticFormalDatabaseNamePattern.test(target.databaseName)) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "测试缝只允许合成正式命名范围。");
  }
}