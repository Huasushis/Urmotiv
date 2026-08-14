import { describe, expect, it } from "vitest";
import {
  assertFormalDatabaseName,
  resolveFormalInputs,
  runFormalImport,
} from "../scripts/run-formal-import";
import { HistoryMigrationError } from "../src/history-migration";

describe("正式导入入口：参数校验与机械拒绝", () => {
  function baseEnvironment(): NodeJS.ProcessEnv {
    return {
      PRIVATE_ROOT: "/srv/urmotiv/private",
      PACKAGE_DIRECTORY: "/srv/urmotiv/private/phase2-evidence/packages",
      LIST_METADATA: "/srv/urmotiv/private/phase2-evidence/list.private.json",
      GROUPING_FILE: "/srv/urmotiv/private/phase2-evidence/grouping.private.json",
      MATERIALIZED_DIRECTORY: "/srv/urmotiv/private/phase2-evidence/materialized",
      PREPARED_DIRECTORY: "/srv/urmotiv/private/phase2-evidence/prepared",
      APPROVAL_FILE: "/srv/urmotiv/private/approval.private.json",
      PREFLIGHT_RECEIPT:
        "/srv/urmotiv/private/phase2-evidence/preflight-run-private/done/preflight-receipt.private.json",
      PHASE2_RECEIPT: "/srv/urmotiv/private/phase2-evidence/phase2-run-receipt.private.json",
      OUTPUT_DIRECTORY: "/srv/urmotiv/private/phase2-evidence/formal-output",
      STORAGE_ROOT: "/srv/urmotiv/private/storage",
      IMPORT_OUTPUT_DIRECTORY: "/srv/urmotiv/private/import-output",
      DATABASE_URL: "postgresql://urmotiv:secret@127.0.0.1:5433/urmotiv_formal_ok",
      PRINCIPAL: "e48c53a9",
      TAG_ID: "tag.01.01",
      GIT_COMMIT: "d9068f1360c6b31c398741be0b1e1b51bc1b69f5",
      EXECUTION_ID: "formal-unit-01",
      TARGET_CLASS: "designated-real",
      BATCH_SHA256: "a".repeat(64),
      SOURCE_BINDINGS_SHA256: "b".repeat(64),
    };
  }

  const fullArguments = [
    "--private-root-env=PRIVATE_ROOT",
    "--package-directory-env=PACKAGE_DIRECTORY",
    "--list-metadata-env=LIST_METADATA",
    "--grouping-file-env=GROUPING_FILE",
    "--materialized-directory-env=MATERIALIZED_DIRECTORY",
    "--prepared-directory-env=PREPARED_DIRECTORY",
    "--approval-file-env=APPROVAL_FILE",
    "--preflight-receipt-env=PREFLIGHT_RECEIPT",
    "--phase2-receipt-env=PHASE2_RECEIPT",
    "--output-directory-env=OUTPUT_DIRECTORY",
    "--storage-root-env=STORAGE_ROOT",
    "--import-output-directory-env=IMPORT_OUTPUT_DIRECTORY",
    "--database-url-env=DATABASE_URL",
    "--principal-env=PRINCIPAL",
    "--tag-id-env=TAG_ID",
    "--git-commit-env=GIT_COMMIT",
    "--execution-id-env=EXECUTION_ID",
    "--target-class-env=TARGET_CLASS",
    "--batch-sha256-env=BATCH_SHA256",
    "--source-bindings-sha256-env=SOURCE_BINDINGS_SHA256",
  ];

  function expectRefused(
    argumentsValue: readonly string[],
    environment: NodeJS.ProcessEnv,
  ): void {
    try {
      resolveFormalInputs(argumentsValue, environment);
    } catch (error) {
      expect(error).toBeInstanceOf(HistoryMigrationError);
      expect((error as HistoryMigrationError).code).toBe("INVALID_ARGUMENTS");
      return;
    }
    throw new Error("本应被拒绝的正式导入输入竟然通过校验。");
  }

  it("目标库名不允许落入临时/验收库命名范围", () => {
    expect(() => assertFormalDatabaseName("")).toThrowError(HistoryMigrationError);
    expect(() => assertFormalDatabaseName("urmotiv_history_import_abc")).toThrowError(
      HistoryMigrationError,
    );
    expect(() => assertFormalDatabaseName("urmotiv_history_import_suffix1")).toThrowError(
      HistoryMigrationError,
    );
    expect(() => assertFormalDatabaseName("urmotiv_formal_ok")).not.toThrow();
  });

  it("非法形式、未获批参数与重复参数逐一拒绝", () => {
    expectRefused(["--PRIVATE_ROOT=/x"], baseEnvironment());
    expectRefused([...fullArguments, "--extra-env=EXTRA"], baseEnvironment());
    expectRefused([...fullArguments, "--tag-id-env=TAG_ID"], baseEnvironment());
    expectRefused(["--tag-id-env"], baseEnvironment());
  });

  it("缺 env、错误 target-class 与坏摘要逐一拒绝", () => {
    const missingTarget = baseEnvironment();
    missingTarget.TARGET_CLASS = undefined;
    expectRefused(fullArguments, missingTarget);
    const wrongTarget = baseEnvironment();
    wrongTarget.TARGET_CLASS = "runner-scratch-compare";
    expectRefused(fullArguments, wrongTarget);
    const badDigest = baseEnvironment();
    badDigest.BATCH_SHA256 = "not-a-digest";
    expectRefused(fullArguments, badDigest);
    const missingEnv = baseEnvironment();
    missingEnv.TAG_ID = " ";
    expectRefused(fullArguments, missingEnv);
  });

  it("连接串不合法或指向临时/验收库名时拒绝", () => {
    const wrongProtocol = baseEnvironment();
    wrongProtocol.DATABASE_URL = "mongodb://127.0.0.1/urmotiv_formal_ok";
    expectRefused(fullArguments, wrongProtocol);
    const scratchName = baseEnvironment();
    scratchName.DATABASE_URL =
      "postgresql://urmotiv:secret@127.0.0.1:5433/urmotiv_history_import_a1";
    expectRefused(fullArguments, scratchName);
  });

  it("合法输入解析出完整正式参数，且门禁外拒绝返回非零退出码", async () => {
    const inputs = resolveFormalInputs(fullArguments, baseEnvironment());
    expect(inputs.databaseName).toBe("urmotiv_formal_ok");
    expect(inputs.privateRoot).toBe("/srv/urmotiv/private");
    expect(inputs.tagId).toBe("tag.01.01");
    // 真实执行需要数据库与收据文件，直接运行必然在密码学门禁处拒绝，退出码不能是 0。
    const code = await runFormalImport(fullArguments, baseEnvironment());
    expect(code === 1 || code === 2).toBe(true);
  });
});