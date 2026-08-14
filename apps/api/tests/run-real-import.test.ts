/**
 * run-real-import.ts 的参数与环境变量校验单测。
 * 不执行任何数据库操作，只验证 resolveRunnerInputs 的接受与拒绝路径。
 */
import { describe, expect, it } from "vitest";

import { resolveRunnerInputs } from "../scripts/run-real-import";
import { HistoryMigrationError } from "../src/history-migration/errors";

const validEnv: NodeJS.ProcessEnv = {
  URMOTIV_ADMIN_URL: "postgresql://user:pass@127.0.0.1:5433/urmotiv",
  URMOTIV_DB_NAME: "urmotiv_history_import_test",
};

const validArgv = [
  "--private-root=/tmp/private",
  "--package-dir=/tmp/packages",
  "--admin-url-env=URMOTIV_ADMIN_URL",
  "--db-name-env=URMOTIV_DB_NAME",
  "--tag-id=00000000-0000-4000-8000-000000000000",
  "--target-class=scratch-temporary",
  "--expected-count=3",
  "--list-metadata=/tmp/list.json",
];

describe("resolveRunnerInputs", () => {
  it("合法参数与环境变量时正确解析", () => {
    const inputs = resolveRunnerInputs(validArgv, validEnv);
    expect(inputs.privateRoot).toBe("/tmp/private");
    expect(inputs.packageDirectory).toBe("/tmp/packages");
    expect(inputs.adminUrlEnv).toBe("URMOTIV_ADMIN_URL");
    expect(inputs.databaseNameEnv).toBe("URMOTIV_DB_NAME");
    expect(inputs.tagId).toBe("00000000-0000-4000-8000-000000000000");
    expect(inputs.targetClass).toBe("scratch-temporary");
    expect(inputs.expectedCount).toBe(3);
  });

  it("designated-validation 目标分类被接受", () => {
    const inputs = resolveRunnerInputs(
      [...validArgv, "--target-class=designated-validation"],
      validEnv,
    );
    expect(inputs.targetClass).toBe("designated-validation");
  });

  it("designated-real 目标分类被拒绝（第 2 阶段禁止真实目标）", () => {
    expect(() =>
      resolveRunnerInputs([...validArgv, "--target-class=designated-real"], validEnv),
    ).toThrow(HistoryMigrationError);
  });

  it("缺少必填参数时以稳定错误码拒绝", () => {
    expect(() =>
      resolveRunnerInputs(validArgv.slice(1), validEnv),
    ).toThrow(HistoryMigrationError);
  });

  it("管理连接串环境变量未设置时拒绝", () => {
    expect(() =>
      resolveRunnerInputs(validArgv, { ...validEnv, URMOTIV_ADMIN_URL: "" }),
    ).toThrow(HistoryMigrationError);
  });

  it("目标库名环境变量未设置时拒绝", () => {
    expect(() =>
      resolveRunnerInputs(validArgv, { ...validEnv, URMOTIV_DB_NAME: undefined }),
    ).toThrow(HistoryMigrationError);
  });

  it("expected-count 非法值时拒绝", () => {
    expect(() =>
      resolveRunnerInputs([...validArgv, "--expected-count=0"], validEnv),
    ).toThrow(HistoryMigrationError);
    expect(() =>
      resolveRunnerInputs([...validArgv, "--expected-count=abc"], validEnv),
    ).toThrow(HistoryMigrationError);
  });

  it("非法 target-class 值时拒绝", () => {
    expect(() =>
      resolveRunnerInputs([...validArgv, "--target-class=production"], validEnv),
    ).toThrow(HistoryMigrationError);
  });

  it("可选参数提供时正确解析", () => {
    const inputs = resolveRunnerInputs(
      [
        ...validArgv,
        "--principal-env=URMOTIV_PRINCIPAL",
        "--grouping-file=/tmp/grouping.json",
        "--git-commit=abc123",
      ],
      { ...validEnv, URMOTIV_PRINCIPAL: "test-operator" },
    );
    expect(inputs.principalEnv).toBe("URMOTIV_PRINCIPAL");
    expect(inputs.groupingFile).toBe("/tmp/grouping.json");
    expect(inputs.gitCommit).toBe("abc123");
  });
});
