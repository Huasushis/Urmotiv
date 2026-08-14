/**
 * runner 命令行只能携带环境变量名；路径、身份、连接信息和批准摘要均不得直传。
 */
import { describe, expect, it } from "vitest";

import { resolveRunnerInputs } from "../scripts/run-real-import";
import { resolvePreflightInputs } from "../scripts/preflight-history-import";
import { HistoryMigrationError } from "../src/history-migration/errors";

const digest = "a".repeat(64);
const validEnv: NodeJS.ProcessEnv = {
  PRIVATE_ROOT: "/tmp/private",
  PACKAGE_DIRECTORY: "/tmp/private/packages",
  LIST_METADATA: "/tmp/private/list.json",
  PREFLIGHT_OUTPUT: "/tmp/private/preflight",
  GROUPING_FILE: "/tmp/private/grouping.json",
  PREFLIGHT_RECEIPT: "/tmp/private/preflight/phase2-preflight-receipt.private.json",
  RECEIPT_DIRECTORY: "/tmp/private/runner",
  STORAGE_ROOT: "/tmp/private/storage",
  IMPORT_OUTPUT_DIRECTORY: "/tmp/private/import-output",
  ADMIN_URL: "configured-admin-endpoint",
  DATABASE_URL: "configured-database-endpoint",
  DATABASE_NAME: "urmotiv_history_import_test",
  PRINCIPAL: "synthetic-principal",
  TAG_ID: "synthetic-tag",
  GIT_COMMIT: "synthetic-commit",
  BATCH_SHA256: digest,
  SOURCE_BINDINGS_SHA256: digest,
  PREFLIGHT_RECEIPT_SHA256: digest,
  EXECUTION_ID: "synthetic-execution",
  TARGET_CLASS: "scratch-temporary",
};

const validArgv = [
  "--private-root-env=PRIVATE_ROOT",
  "--package-directory-env=PACKAGE_DIRECTORY",
  "--list-metadata-env=LIST_METADATA",
  "--grouping-file-env=GROUPING_FILE",
  "--preflight-receipt-env=PREFLIGHT_RECEIPT",
  "--receipt-directory-env=RECEIPT_DIRECTORY",
  "--storage-root-env=STORAGE_ROOT",
  "--import-output-directory-env=IMPORT_OUTPUT_DIRECTORY",
  "--admin-url-env=ADMIN_URL",
  "--db-name-env=DATABASE_NAME",
  "--principal-env=PRINCIPAL",
  "--tag-id-env=TAG_ID",
  "--git-commit-env=GIT_COMMIT",
  "--batch-sha256-env=BATCH_SHA256",
  "--source-bindings-sha256-env=SOURCE_BINDINGS_SHA256",
  "--preflight-receipt-sha256-env=PREFLIGHT_RECEIPT_SHA256",
  "--execution-id-env=EXECUTION_ID",
  "--target-class-env=TARGET_CLASS",
  "--expected-count=3",
];

const validPreflightArgv = [
  "--private-root-env=PRIVATE_ROOT",
  "--list-metadata-env=LIST_METADATA",
  "--package-directory-env=PACKAGE_DIRECTORY",
  "--output-directory-env=PREFLIGHT_OUTPUT",
  "--expected-record-count=3",
  "--database-url-env=DATABASE_URL",
  "--grouping-file-env=GROUPING_FILE",
  "--tag-id-env=TAG_ID",
  "--git-commit-env=GIT_COMMIT",
  "--target-class-env=TARGET_CLASS",
  "--principal-env=PRINCIPAL",
  "--execution-id-env=EXECUTION_ID",
  "--batch-sha256-env=BATCH_SHA256",
  "--source-bindings-sha256-env=SOURCE_BINDINGS_SHA256",
];

describe("resolveRunnerInputs", () => {
  it("从必填环境变量解析全部执行输入", () => {
    const inputs = resolveRunnerInputs(validArgv, validEnv);
    expect(inputs.privateRoot).toBe(validEnv.PRIVATE_ROOT);
    expect(inputs.packageDirectory).toBe(validEnv.PACKAGE_DIRECTORY);
    expect(inputs.adminUrl).toBe(validEnv.ADMIN_URL);
    expect(inputs.databaseName).toBe(validEnv.DATABASE_NAME);
    expect(inputs.principal).toBe(validEnv.PRINCIPAL);
    expect(inputs.targetClass).toBe("scratch-temporary");
    expect(inputs.expectedCount).toBe(3);
  });

  it("designated-validation 目标分类被接受", () => {
    const inputs = resolveRunnerInputs(validArgv, {
      ...validEnv,
      TARGET_CLASS: "designated-validation",
    });
    expect(inputs.targetClass).toBe("designated-validation");
  });

  it("designated-real 目标分类被拒绝", () => {
    expect(() =>
      resolveRunnerInputs(validArgv, { ...validEnv, TARGET_CLASS: "designated-real" }),
    ).toThrow(HistoryMigrationError);
  });

  it("任何必填环境变量名参数缺失时拒绝", () => {
    for (let index = 0; index < validArgv.length - 1; index += 1) {
      expect(() =>
        resolveRunnerInputs(validArgv.filter((_, argumentIndex) => argumentIndex !== index), validEnv),
      ).toThrow(HistoryMigrationError);
    }
  });

  it("环境变量未设置或为空时拒绝", () => {
    expect(() => resolveRunnerInputs(validArgv, { ...validEnv, ADMIN_URL: "" })).toThrow(
      HistoryMigrationError,
    );
    expect(() =>
      resolveRunnerInputs(validArgv, { ...validEnv, DATABASE_NAME: undefined }),
    ).toThrow(HistoryMigrationError);
  });

  it("非法数量、摘要、库名或目标分类均拒绝", () => {
    expect(() => resolveRunnerInputs([...validArgv, "--expected-count=0"], validEnv)).toThrow(
      HistoryMigrationError,
    );
    expect(() =>
      resolveRunnerInputs(validArgv, { ...validEnv, BATCH_SHA256: "bad" }),
    ).toThrow(HistoryMigrationError);
    expect(() =>
      resolveRunnerInputs(validArgv, { ...validEnv, DATABASE_NAME: "production" }),
    ).toThrow(HistoryMigrationError);
    expect(() =>
      resolveRunnerInputs(validArgv, { ...validEnv, TARGET_CLASS: "production" }),
    ).toThrow(HistoryMigrationError);
  });

  it("旧的直传值参数不能替代环境变量名参数", () => {
    expect(() =>
      resolveRunnerInputs(
        ["--private-root=/tmp/private", "--target-class=scratch-temporary", "--expected-count=3"],
        validEnv,
      ),
    ).toThrow(HistoryMigrationError);
    expect(() =>
      resolveRunnerInputs([...validArgv, "--admin-url=configured-directly"], validEnv),
    ).toThrow(HistoryMigrationError);
    expect(() => resolveRunnerInputs([...validArgv, validArgv[0]!], validEnv)).toThrow(
      HistoryMigrationError,
    );
  });
});

describe("resolvePreflightInputs", () => {
  it("同样只从必填环境变量解析路径、身份、连接信息和摘要", () => {
    const inputs = resolvePreflightInputs(validPreflightArgv, validEnv);
    expect(inputs.privateRoot).toBe(validEnv.PRIVATE_ROOT);
    expect(inputs.databaseUrl).toBe(validEnv.DATABASE_URL);
    expect(inputs.expectedBatchSha256).toBe(digest);
    expect(inputs.expectedRecordCount).toBe(3);
  });

  it("摘要非法、环境变量缺失或旧直传参数均拒绝", () => {
    expect(() =>
      resolvePreflightInputs(validPreflightArgv, {
        ...validEnv,
        SOURCE_BINDINGS_SHA256: "bad",
      }),
    ).toThrow(HistoryMigrationError);
    expect(() =>
      resolvePreflightInputs(validPreflightArgv, { ...validEnv, PRINCIPAL: undefined }),
    ).toThrow(HistoryMigrationError);
    expect(() =>
      resolvePreflightInputs(
        ["--private-root=/tmp/private", "--expected-record-count=3"],
        validEnv,
      ),
    ).toThrow(HistoryMigrationError);
    expect(() =>
      resolvePreflightInputs([...validPreflightArgv, "--database-url=configured-directly"], validEnv),
    ).toThrow(HistoryMigrationError);
    expect(() =>
      resolvePreflightInputs([...validPreflightArgv, validPreflightArgv[0]!], validEnv),
    ).toThrow(HistoryMigrationError);
  });
});
